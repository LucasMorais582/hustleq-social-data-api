import { findWatchedCandidates } from '../jobs/instagram.watched-eligibility.repository.js';
import { enqueueWatchedBatch } from '../jobs/instagram.watched.repository.js';
import { env } from '../../../config/env.js';

export async function scheduleWatchedSync(date: string, startedAt: number, clock = Date.now) {
  const candidates = await findWatchedCandidates(new Date());
  const result = {
    total: candidates.length,
    queued: 0,
    reused: 0,
    notDue: 0,
    failed: 0,
    pending: candidates.length,
    failures: [] as { profileId: string; code: string }[],
  };
  const groups = new Map<string | null, string[]>();
  for (const target of candidates) {
    const ids = groups.get(target.userId) ?? [];
    ids.push(target.id);
    groups.set(target.userId, ids);
  }
  for (const [userId, ids] of groups) {
    for (let offset = 0; offset < ids.length; offset += env.INSTAGRAM_DAILY_BATCH_SIZE) {
      if (clock() - startedAt >= 180000) {
        result.pending =
          result.total - result.queued - result.reused - result.notDue - result.failed;
        return result;
      }
      const batch = ids.slice(offset, offset + env.INSTAGRAM_DAILY_BATCH_SIZE);
      try {
        const saved = await enqueueWatchedBatch(batch, userId, date);
        result.queued += saved.queued;
        result.reused += saved.reused;
        result.notDue += saved.notDue;
      } catch {
        result.failed += batch.length;
        result.failures.push(
          ...batch.map((profileId) => ({ profileId, code: 'WATCHED_ENQUEUE_FAILED' })),
        );
      }
    }
  }
  result.pending = result.total - result.queued - result.reused - result.notDue - result.failed;
  return result;
}
