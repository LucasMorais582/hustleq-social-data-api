import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { beginDiscover } from '../src/modules/instagram/discover/instagram.discover.repository.js';
const query = { niche: 'food', city: 'newark', query: null };
function fixture() {
  const now = new Date('2026-11-25T10:00:00Z');
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ now }]),
    discoverCache: { findUnique: vi.fn().mockResolvedValue(null) },
    instagramSyncJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'new' }),
    },
  };
  const transaction = vi.fn(async (work: (db: typeof tx) => unknown) => work(tx));
  return { now, tx, client: { $transaction: transaction } as unknown as PrismaClient };
}
beforeEach(() => vi.clearAllMocks());
describe('Discover asynchronous enqueue', () => {
  it('returns an active job without creating another or waiting', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findUnique.mockResolvedValue({ id: 'active' });
    expect(await beginDiscover(query, 'user', f.client)).toMatchObject({
      jobId: 'active',
      created: false,
    });
    expect(f.tx.instagramSyncJob.findFirst).not.toHaveBeenCalled();
    expect(f.tx.instagramSyncJob.create).not.toHaveBeenCalled();
  });
  it('returns a recent failure for one minute without another paid sequence', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findFirst.mockResolvedValue({
      id: 'failed',
      payload: { failure: { status: 429, message: 'wait' } },
    });
    expect(await beginDiscover(query, 'user', f.client)).toMatchObject({
      failed: true,
      jobId: 'failed',
      created: false,
    });
    expect(f.tx.instagramSyncJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'FAILED',
          finishedAt: { gt: new Date(f.now.getTime() - 60000) },
        }),
      }),
    );
    expect(f.tx.instagramSyncJob.create).not.toHaveBeenCalled();
  });
  it('creates one search after the cooldown when no valid cache or active job exists', async () => {
    const f = fixture();
    expect(await beginDiscover(query, 'user', f.client)).toMatchObject({
      jobId: 'new',
      created: true,
    });
    expect(f.tx.instagramSyncJob.create).toHaveBeenCalledTimes(1);
  });
  it('serves a fresh cache even if an older job had failed', async () => {
    const f = fixture();
    f.tx.discoverCache.findUnique.mockResolvedValue({ fetchedAt: f.now });
    expect(await beginDiscover(query, 'user', f.client)).toMatchObject({
      cache: { fetchedAt: f.now },
    });
    expect(f.tx.instagramSyncJob.findFirst).not.toHaveBeenCalled();
    expect(f.tx.instagramSyncJob.create).not.toHaveBeenCalled();
  });
});
