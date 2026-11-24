import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ find: vi.fn(), enqueue: vi.fn() }));
vi.mock('../src/modules/instagram/refresh/instagram.refresh.repository.js', () => ({
  findProfilesForInstagramRefresh: m.find,
}));
vi.mock('../src/modules/instagram/jobs/instagram.daily.repository.js', () => ({
  enqueueDailyBatch: m.enqueue,
}));
import { runInstagramRefresh } from '../src/modules/instagram/refresh/instagram.refresh.service.js';
import { env } from '../src/config/env.js';
const now = new Date('2026-11-24T09:30:00Z');
const batchSize = env.INSTAGRAM_DAILY_BATCH_SIZE;
beforeEach(() => {
  vi.resetAllMocks();
  env.INSTAGRAM_DAILY_BATCH_SIZE = 2;
  m.find.mockResolvedValue([]);
  m.enqueue.mockImplementation(async (ids: string[]) => ({
    queued: ids.length,
    reused: 0,
    notDue: 0,
    jobId: 'batch',
  }));
});
afterEach(() => {
  env.INSTAGRAM_DAILY_BATCH_SIZE = batchSize;
});
describe('Daily scheduler', () => {
  it('skips outside 4am New York without database access', async () => {
    expect(await runInstagramRefresh(new Date('2026-11-24T08:59:59Z'))).toMatchObject({
      skipped: true,
    });
    expect(m.find).not.toHaveBeenCalled();
  });
  it('groups and chunks profiles by owner without executing Actors', async () => {
    m.find.mockResolvedValue([
      { id: 'a', ownerUserId: 'owner-1' },
      { id: 'b', ownerUserId: 'owner-2' },
      { id: 'c', ownerUserId: 'owner-1' },
      { id: 'd', ownerUserId: 'owner-1' },
    ]);
    expect(await runInstagramRefresh(now, () => 0)).toMatchObject({
      queued: 4,
      pending: 0,
      failed: 0,
    });
    expect(m.enqueue.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [['a', 'c'], 'owner-1', '2026-11-24'],
      [['d'], 'owner-1', '2026-11-24'],
      [['b'], 'owner-2', '2026-11-24'],
    ]);
  });
  it('reports already queued/recent profiles without duplicates', async () => {
    m.find.mockResolvedValue([
      { id: 'a', ownerUserId: 'owner' },
      { id: 'b', ownerUserId: 'owner' },
    ]);
    m.enqueue.mockResolvedValue({ queued: 0, reused: 1, notDue: 1 });
    expect(await runInstagramRefresh(now)).toMatchObject({
      queued: 0,
      reused: 1,
      notDue: 1,
      pending: 0,
    });
  });
  it('does not queue missing ownership', async () => {
    m.find.mockResolvedValue([{ id: 'a', ownerUserId: null }]);
    expect(await runInstagramRefresh(now)).toMatchObject({ notDue: 1, pending: 0 });
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it('handles an empty database', async () => {
    expect(await runInstagramRefresh(now)).toMatchObject({ total: 0, queued: 0, pending: 0 });
  });
  it('reports failures and continues with the next owner', async () => {
    m.find.mockResolvedValue([
      { id: 'a', ownerUserId: 'one' },
      { id: 'b', ownerUserId: 'two' },
    ]);
    m.enqueue.mockRejectedValueOnce(new Error('sensitive SQL'));
    const result = await runInstagramRefresh(now, () => 0);
    expect(result).toMatchObject({
      queued: 1,
      failed: 1,
      pending: 0,
      failures: [{ profileId: 'a', code: 'DAILY_ENQUEUE_FAILED' }],
    });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it('stops enqueueing when the request budget is exhausted; next invocation can resume', async () => {
    m.find.mockResolvedValue([{ id: 'a', ownerUserId: 'owner' }]);
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValue(180000);
    expect(await runInstagramRefresh(now, clock)).toMatchObject({ queued: 0, pending: 1 });
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});
