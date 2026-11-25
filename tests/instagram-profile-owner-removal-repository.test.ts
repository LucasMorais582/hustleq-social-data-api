import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { removeProfileOwnerInTransaction } from '../src/modules/instagram/profile/instagram.profile.owner-removal.repository.js';
const now = new Date('2026-11-25T10:00:00Z');
function fixture(jobs: unknown[] = []) {
  const tx = {
    $queryRaw: vi
      .fn()
      .mockImplementation(async (sql: TemplateStringsArray) =>
        sql.join('').includes('clock_timestamp') ? [{ now }] : jobs,
      ),
    instagramProfile: { update: vi.fn() },
    instagramCompetitor: { updateMany: vi.fn() },
    instagramSyncJob: { updateMany: vi.fn() },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}
beforeEach(() => vi.clearAllMocks());
const metadata = (remaining: string[]) => ({
  daily: {
    ownerUserId: 'owner',
    date: '2026-11-25',
    profileIds: ['other', 'removed'],
    remainingProfileIds: remaining,
  },
  providerSteps: {},
  runTargets: {},
});
describe('owner removal persistence', () => {
  it('changes only ownership and outgoing active relations; never deletes public history or incoming relations', async () => {
    const f = fixture();
    await removeProfileOwnerInTransaction('removed', f.client);
    expect(f.tx.instagramProfile.update).toHaveBeenCalledWith({
      where: { id: 'removed' },
      data: { ownerUserId: null },
    });
    expect(f.tx.instagramCompetitor.updateMany).toHaveBeenCalledWith({
      where: { instagramProfileId: 'removed', endedAt: null },
      data: { endedAt: now },
    });
    const sql = f.tx.$queryRaw.mock.calls[1]![0].join('');
    expect(sql).toContain("'PENDING'");
    expect(sql).toContain('SKIP LOCKED');
    expect(sql).toContain('INITIAL_PROFILE_SYNC');
    expect(sql).toContain('POST_REFRESH');
    expect(sql).toContain('remainingProfileIds');
  });
  it('cancels pending Initial and Post Refresh without aborting Actors or deleting ledger rows', async () => {
    const f = fixture([
      { id: 'initial', type: 'INITIAL_PROFILE_SYNC' },
      { id: 'post', type: 'POST_REFRESH' },
    ]);
    await removeProfileOwnerInTransaction('removed', f.client);
    expect(f.tx.instagramSyncJob.updateMany).toHaveBeenCalledTimes(1);
    for (const [call] of f.tx.instagramSyncJob.updateMany.mock.calls)
      expect(call).toMatchObject({
        where: { status: 'PENDING' },
        data: {
          status: 'FAILED',
          activeKey: null,
          lockToken: null,
          finishedAt: now,
          lastError: 'PROFILE_OWNER_REMOVED',
        },
      });
  });
  it('removes only the cancelled member from a shared pending Daily batch', async () => {
    const f = fixture([
      { id: 'batch', type: 'DAILY_PROFILE_SYNC', payload: metadata(['other', 'removed']) },
    ]);
    await removeProfileOwnerInTransaction('removed', f.client);
    const update = f.tx.instagramSyncJob.updateMany.mock.calls[0]![0];
    expect(update.data).not.toHaveProperty('status');
    expect(update.data.payload.daily).toMatchObject({
      remainingProfileIds: ['other'],
      skippedProfileIds: ['removed'],
    });
  });
  it('cancels a Daily with no members left, releasing its active key', async () => {
    const f = fixture([
      { id: 'batch', type: 'DAILY_PROFILE_SYNC', payload: metadata(['removed']) },
    ]);
    await removeProfileOwnerInTransaction('removed', f.client);
    expect(f.tx.instagramSyncJob.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'FAILED',
      activeKey: null,
      lastError: 'PROFILE_OWNER_REMOVED',
    });
  });
  it('fails closed on invalid batch metadata instead of cancelling other customers', async () => {
    const f = fixture([{ id: 'batch', type: 'DAILY_PROFILE_SYNC', payload: {} }]);
    await expect(removeProfileOwnerInTransaction('removed', f.client)).rejects.toThrow();
    expect(f.tx.instagramSyncJob.updateMany).not.toHaveBeenCalled();
  });
});
