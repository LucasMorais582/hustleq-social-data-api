import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ find: vi.fn(), enqueue: vi.fn() }));
vi.mock('../src/modules/instagram/jobs/instagram.watched-eligibility.repository.js', () => ({
  findWatchedCandidates: m.find,
}));
vi.mock('../src/modules/instagram/jobs/instagram.watched.repository.js', () => ({
  enqueueWatchedBatch: m.enqueue,
}));
import { scheduleWatchedSync } from '../src/modules/instagram/refresh/instagram.watched-schedule.service.js';
import { env } from '../src/config/env.js';
const size = env.INSTAGRAM_DAILY_BATCH_SIZE;
beforeEach(() => {
  vi.resetAllMocks();
  env.INSTAGRAM_DAILY_BATCH_SIZE = 2;
  m.find.mockResolvedValue([]);
  m.enqueue.mockImplementation(async (ids: string[]) => ({
    queued: ids.length,
    reused: 0,
    notDue: 0,
  }));
});
afterEach(() => {
  env.INSTAGRAM_DAILY_BATCH_SIZE = size;
});
describe('Watched scheduling', () => {
  it('batches by distinct payer, with a separate unattributed group', async () => {
    m.find.mockResolvedValue([
      { id: 'a', userId: 'one' },
      { id: 'b', userId: null },
      { id: 'c', userId: 'one' },
      { id: 'd', userId: 'two' },
      { id: 'e', userId: 'one' },
      { id: 'f', userId: null },
    ]);
    expect(await scheduleWatchedSync('2026-11-24', 0, () => 0)).toMatchObject({
      total: 6,
      queued: 6,
      pending: 0,
    });
    expect(m.enqueue.mock.calls).toEqual([
      [['a', 'c'], 'one', '2026-11-24'],
      [['e'], 'one', '2026-11-24'],
      [['b', 'f'], null, '2026-11-24'],
      [['d'], 'two', '2026-11-24'],
    ]);
  });
  it('continues after one enqueue failure and exposes only a safe code', async () => {
    m.find.mockResolvedValue([
      { id: 'a', userId: 'one' },
      { id: 'b', userId: 'two' },
    ]);
    m.enqueue.mockRejectedValueOnce(new Error('sensitive database message'));
    const result = await scheduleWatchedSync('2026-11-24', 0, () => 0);
    expect(result).toMatchObject({
      queued: 1,
      failed: 1,
      pending: 0,
      failures: [{ profileId: 'a', code: 'WATCHED_ENQUEUE_FAILED' }],
    });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it('shares the 180s cron budget and reports members not yet queued', async () => {
    m.find.mockResolvedValue([{ id: 'a', userId: null }]);
    expect(await scheduleWatchedSync('2026-11-24', 0, () => 180000)).toMatchObject({
      pending: 1,
      queued: 0,
    });
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});
