import { beforeEach, describe, expect, it, vi } from 'vitest';
const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../src/modules/instagram/competitors/instagram.competitors.repository.js', () => ({
  withCompetitorTransaction: transaction,
}));
import {
  addInstagramCompetitor,
  endInstagramCompetitor,
  listInstagramCompetitors,
} from '../src/modules/instagram/competitors/instagram.competitors.service.js';
import type { CompetitorStore } from '../src/modules/instagram/competitors/instagram.competitors.repository.js';

function relation(endedAt: Date | null = null) {
  return {
    id: 'relation',
    instagramProfileId: 'profile',
    competitorProfileId: 'competitor',
    startedAt: new Date('2026-01-01'),
    endedAt,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}
function makeStore() {
  return {
    requireOwner: vi.fn().mockResolvedValue(undefined),
    scheduleInitial: vi.fn().mockResolvedValue(undefined),
    profileInstagramId: vi.fn().mockResolvedValue('monitor-external'),
    saveIdentity: vi.fn().mockResolvedValue('competitor'),
    profileExists: vi.fn().mockResolvedValue(true),
    activeExists: vi.fn().mockResolvedValue(false),
    countActive: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue(relation()),
    find: vi.fn().mockResolvedValue(relation()),
    end: vi.fn().mockResolvedValue(relation(new Date())),
    list: vi.fn().mockResolvedValue([relation()]),
  };
}
let store: ReturnType<typeof makeStore>;
beforeEach(() => {
  vi.resetAllMocks();
  store = makeStore();
  transaction.mockImplementation(async (work: (tx: CompetitorStore) => Promise<unknown>) =>
    work(store),
  );
});

describe('competitor relationship business rules', () => {
  it('adds a relation between stored profiles', async () => {
    expect(await addInstagramCompetitor('profile', 'competitor')).toMatchObject({
      id: 'relation',
      endedAt: null,
    });
    expect(store.create).toHaveBeenCalledWith('profile', 'competitor');
  });
  it('rejects self-monitoring before DB access', async () => {
    await expect(addInstagramCompetitor('profile', 'profile')).rejects.toMatchObject({
      statusCode: 400,
      code: 'COMPETITOR_SELF_REFERENCE',
    });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('requires the monitoring profile', async () => {
    store.profileExists.mockResolvedValue(false);
    await expect(addInstagramCompetitor('missing', 'competitor')).rejects.toMatchObject({
      statusCode: 404,
      code: 'PROFILE_NOT_FOUND',
    });
    expect(store.create).not.toHaveBeenCalled();
  });
  it('requires the competitor profile without invoking a provider', async () => {
    store.profileExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(addInstagramCompetitor('profile', 'missing')).rejects.toMatchObject({
      code: 'COMPETITOR_PROFILE_NOT_FOUND',
    });
    expect(store.create).not.toHaveBeenCalled();
  });
  it('rejects an existing active relation', async () => {
    store.activeExists.mockResolvedValue(true);
    await expect(addInstagramCompetitor('profile', 'competitor')).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMPETITOR_ALREADY_ACTIVE',
    });
    expect(store.create).not.toHaveBeenCalled();
  });
  it.each([3, 4])('rejects a new competitor when there are %i active', async (count) => {
    store.countActive.mockResolvedValue(count);
    await expect(addInstagramCompetitor('profile', 'competitor')).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMPETITOR_LIMIT_REACHED',
    });
    expect(store.create).not.toHaveBeenCalled();
  });
  it('allows the third active competitor', async () => {
    store.countActive.mockResolvedValue(2);
    await addInstagramCompetitor('profile', 'competitor');
    expect(store.create).toHaveBeenCalledTimes(1);
  });
  it('creates a new relation when only ended relations exist', async () => {
    store.activeExists.mockResolvedValue(false);
    await addInstagramCompetitor('profile', 'competitor');
    expect(store.create).toHaveBeenCalledWith('profile', 'competitor');
    expect(store.end).not.toHaveBeenCalled();
  });
  it('ends a relation without deleting its history', async () => {
    await endInstagramCompetitor('profile', 'relation', 'owner');
    expect(store.find).toHaveBeenCalledWith('profile', 'relation');
    expect(store.end).toHaveBeenCalledWith('relation', expect.any(Date));
  });
  it('preserves the original endedAt when ending twice', async () => {
    const ended = relation(new Date('2026-02-01'));
    store.find.mockResolvedValue(ended);
    expect(await endInstagramCompetitor('profile', 'relation', 'owner')).toBe(ended);
    expect(store.end).not.toHaveBeenCalled();
  });
  it('cannot end a relation belonging to another monitoring profile', async () => {
    store.find.mockResolvedValue(null);
    await expect(
      endInstagramCompetitor('profile', 'foreign-relation', 'owner'),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'COMPETITOR_RELATION_NOT_FOUND',
    });
    expect(store.end).not.toHaveBeenCalled();
  });
  it.each(['active', 'ended', 'all'] as const)(
    'lists %s with bounded pagination',
    async (status) => {
      const result = await listInstagramCompetitors('profile', status, 2, 25, 'owner');
      expect(store.list).toHaveBeenCalledWith('profile', status, 25, 25);
      expect(result).toMatchObject({
        page: 2,
        limit: 25,
        relations: [expect.objectContaining({ id: 'relation' })],
      });
    },
  );
  it('returns a controlled 503 on DB failure', async () => {
    transaction.mockRejectedValue(new Error('SQL details'));
    await expect(
      listInstagramCompetitors('profile', 'active', 1, 50, 'owner'),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'PERSISTENCE_FAILED',
    });
  });
});
