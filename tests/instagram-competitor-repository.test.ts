import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { withCompetitorTransaction } from '../src/modules/instagram/competitors/instagram.competitors.repository.js';

function fixture() {
  const tx = {
    instagramProfile: {
      findUnique: vi.fn().mockResolvedValue({ id: 'internal', instagramId: 'external' }),
      upsert: vi.fn().mockResolvedValue({ id: 'internal' }),
    },
    instagramCompetitor: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'new' }),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const transaction = vi.fn((callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
  return { tx, transaction, client: { $transaction: transaction } as unknown as PrismaClient };
}
describe('competitor transactional persistence', () => {
  it.each(['DAILY_PROFILE_SYNC', 'WATCHED_SYNC'])(
    'shares %s without changing the existing profile status to syncing',
    async (type) => {
      const f = fixture();
      const tx = {
        ...f.tx,
        instagramProfile: {
          ...f.tx.instagramProfile,
          findUnique: vi
            .fn()
            .mockResolvedValue({ ownerUserId: type === 'WATCHED_SYNC' ? null : 'owner' }),
          update: vi.fn(),
        },
        instagramCompetitor: {
          ...f.tx.instagramCompetitor,
          findMany: vi
            .fn()
            .mockResolvedValue([
              { competitorProfileId: 'target', instagramProfile: { ownerUserId: 'owner' } },
            ]),
        },
        providerRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        instagramSyncJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          findFirst: vi.fn().mockResolvedValue({ id: 'batch', type, userId: 'owner' }),
          upsert: vi.fn(),
        },
      };
      const client = {
        $transaction: (work: (store: typeof tx) => Promise<unknown>) => work(tx),
      } as unknown as PrismaClient;
      await withCompetitorTransaction(
        (store) => store.scheduleInitial('target', 'verified-run', 'caller'),
        client,
      );
      expect(tx.instagramSyncJob.upsert).not.toHaveBeenCalled();
      expect(tx.instagramProfile.update).not.toHaveBeenCalled();
      expect(tx.providerRun.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it('reuses external identity without assigning ownership', async () => {
    const { tx, transaction, client } = fixture();
    const profile = {
      instagramId: 'external',
      username: 'other',
      name: null,
      bio: null,
      url: null,
      profilePhoto: null,
      category: null,
      isVerified: null,
    };
    await withCompetitorTransaction(async (store) => {
      expect(await store.saveIdentity(profile)).toBe('internal');
      await store.create('source', 'internal');
    }, client);
    expect(tx.instagramProfile.upsert).toHaveBeenCalledWith({
      where: { instagramId: 'external' },
      create: profile,
      update: profile,
      select: { id: true },
    });
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(tx.instagramCompetitor.create).toHaveBeenCalledWith({
      data: { instagramProfileId: 'source', competitorProfileId: 'internal' },
    });
  });
  it.each(['active', 'ended', 'all'] as const)(
    'scopes and paginates %s relationships',
    async (status) => {
      const { tx, client } = fixture();
      await withCompetitorTransaction((store) => store.list('source', status, 25, 25), client);
      const expected =
        status === 'all' ? {} : { endedAt: status === 'active' ? null : { not: null } };
      expect(tx.instagramCompetitor.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { instagramProfileId: 'source', ...expected },
          skip: 25,
          take: 25,
        }),
      );
    },
  );
  it('only updates endedAt when removing', async () => {
    const { tx, client } = fixture();
    const now = new Date();
    await withCompetitorTransaction((store) => store.end('relation', now), client);
    expect(tx.instagramCompetitor.update).toHaveBeenCalledWith({
      where: { id: 'relation' },
      data: { endedAt: now },
    });
  });
  it.each(['P2034', 'P2002'])('retries %s with business checks executed again', async (code) => {
    const { transaction, client } = fixture();
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
      code,
      clientVersion: '6',
    });
    transaction.mockRejectedValueOnce(conflict);
    await withCompetitorTransaction((store) => store.countActive('source'), client);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('limits retries after repeated concurrent conflicts', async () => {
    const { transaction, client } = fixture();
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
      code: 'P2034',
      clientVersion: '6',
    });
    transaction.mockRejectedValue(conflict);
    await expect(
      withCompetitorTransaction((store) => store.countActive('source'), client),
    ).rejects.toBe(conflict);
    expect(transaction).toHaveBeenCalledTimes(3);
  });
  it('propagates failures instead of retrying unknown errors', async () => {
    const { transaction, client } = fixture();
    transaction.mockRejectedValue(new Error('connection'));
    await expect(
      withCompetitorTransaction((store) => store.countActive('source'), client),
    ).rejects.toThrow('connection');
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
