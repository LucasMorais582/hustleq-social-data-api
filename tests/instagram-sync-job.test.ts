import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  enqueueInstagramSyncJob,
  claimNextInstagramSyncJob,
  renewInstagramSyncJobLease,
  completeInstagramSyncJob,
  failInstagramSyncJob,
  SYNC_JOB_MAX_ATTEMPTS,
  SYNC_JOB_RETRY_DELAYS_MS,
} from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
const input = {
  type: 'INITIAL_PROFILE_SYNC' as const,
  trigger: 'initial' as const,
  instagramProfileId: 'profile-id',
  activeKey: 'profile:profile-id',
};
function fixture() {
  const upsert = vi.fn().mockResolvedValue({ id: 'job', ...input, status: 'PENDING', attempts: 0 });
  const query = vi.fn().mockResolvedValue([]);
  const client = { instagramSyncJob: { upsert }, $queryRaw: query } as unknown as PrismaClient;
  return { client, upsert, query };
}
const owner = { id: 'job', lockToken: 'worker-claim' };
describe('internal Instagram sync job operations', () => {
  it('preserves an existing active job without overwriting its payload, user or schedule', async () => {
    const { client, upsert } = fixture();
    await enqueueInstagramSyncJob(
      { ...input, userId: 'external-user', payload: { label: 'fixture' } },
      client,
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activeKey: input.activeKey },
        update: { activeKey: input.activeKey },
        create: expect.objectContaining({
          userId: 'external-user',
          payload: { label: 'fixture' },
          instagramPostId: null,
        }),
      }),
    );
  });
  it('distinguishes JSON null from an absent payload', async () => {
    const { client, upsert } = fixture();
    await enqueueInstagramSyncJob({ ...input, payload: null }, client);
    expect(upsert.mock.calls[0]![0].create.payload).toBe(Prisma.JsonNull);
    await enqueueInstagramSyncJob(input, client);
    expect(upsert.mock.calls[1]![0].create).not.toHaveProperty('payload');
  });
  it.each([
    new Error('database unavailable'),
    new Prisma.PrismaClientKnownRequestError('unexpected unique conflict', {
      code: 'P2002',
      clientVersion: 'test',
    }),
  ])('propagates storage errors without pretending to have enqueued a job', async (error) => {
    const { client, upsert } = fixture();
    upsert.mockRejectedValue(error);
    await expect(enqueueInstagramSyncJob(input, client)).rejects.toBe(error);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...input, activeKey: '' },
    { ...input, activeKey: ' padded ' },
    { ...input, instagramProfileId: undefined },
    { ...input, instagramPostId: 'post' },
    { ...input, trigger: 'refresh' },
    { ...input, runAt: new Date('invalid') },
    { type: 'POST_REFRESH', trigger: 'refresh', activeKey: 'post:missing' },
    {
      type: 'DISCOVER_SEARCH',
      trigger: 'discover',
      activeKey: 'discover',
      instagramProfileId: 'profile',
    },
    { ...input, status: 'SUCCEEDED' },
  ])('rejects an invalid queue instruction before writing: %j', async (value) => {
    const { client, upsert } = fixture();
    await expect(enqueueInstagramSyncJob(value as typeof input, client)).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });
  it('returns null for an empty queue and returns the claimed job otherwise', async () => {
    const { client, query } = fixture();
    expect(await claimNextInstagramSyncJob(600000, client)).toBeNull();
    const claimed = { id: 'job', status: 'RUNNING', attempts: 1 };
    query.mockResolvedValueOnce([claimed]);
    expect(await claimNextInstagramSyncJob(600000, client)).toEqual(claimed);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 3600001])(
    'rejects an invalid lease %s before querying',
    async (lease) => {
      const { client, query } = fixture();
      await expect(claimNextInstagramSyncJob(lease, client)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('does not report success when the claim is no longer owned', async () => {
    const { client, query } = fixture();
    expect(await renewInstagramSyncJobLease(owner, 600000, client)).toBe(false);
    expect(await completeInstagramSyncJob(owner, client)).toBe(false);
    expect(await failInstagramSyncJob(owner, 'PROVIDER_UNAVAILABLE', client)).toBeNull();
    query.mockResolvedValue([{ id: owner.id }]);
    expect(await completeInstagramSyncJob(owner, client)).toBe(true);
  });
  it('does not persist raw errors or credential-bearing text', async () => {
    const { client, query } = fixture();
    await expect(
      failInstagramSyncJob(owner, 'https://example.com?token=secret', client),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('propagates a transition failure without claiming a task was completed', async () => {
    const { client, query } = fixture();
    query.mockRejectedValue(new Error('connection lost'));
    await expect(completeInstagramSyncJob(owner, client)).rejects.toThrow('connection lost');
  });
  it('uses the agreed total of three attempts with one and five minute retry delays', () => {
    expect(SYNC_JOB_MAX_ATTEMPTS).toBe(3);
    expect(SYNC_JOB_RETRY_DELAYS_MS).toEqual([60000, 300000]);
  });
});
