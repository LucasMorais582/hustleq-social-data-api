import { findProfilesForInstagramRefresh } from './instagram.refresh.repository.js';
import { getInstagramRefreshDate } from './instagram.refresh.schedule.js';
import { enqueueDailyBatch } from '../jobs/instagram.daily.repository.js';
import { scheduleWatchedSync } from './instagram.watched-schedule.service.js';
import { env } from '../../../config/env.js';

export async function runInstagramRefresh(now = new Date(), clock = Date.now) {
  const date = getInstagramRefreshDate(now);
  if (!date) return { skipped: true as const, reason: 'OUTSIDE_SCHEDULE' };
  const startedAt = clock();
  const profiles = await findProfilesForInstagramRefresh(now);
  const result = {
    skipped: false as const,
    total: profiles.length,
    queued: 0,
    reused: 0,
    notDue: 0,
    failed: 0,
    pending: profiles.length,
    failures: [] as { profileId: string; code: string }[],
  };
  const owners = new Map<string, string[]>();
  for (const profile of profiles) {
    if (!profile.ownerUserId) {
      result.notDue++;
      continue;
    }
    const ids = owners.get(profile.ownerUserId) ?? [];
    ids.push(profile.id);
    owners.set(profile.ownerUserId, ids);
  }
  for (const [owner, ids] of owners) {
    for (let offset = 0; offset < ids.length; offset += env.INSTAGRAM_DAILY_BATCH_SIZE) {
      if (clock() - startedAt >= 180000) {
        result.pending =
          result.total - result.queued - result.reused - result.notDue - result.failed;
        return result;
      }
      const batch = ids.slice(offset, offset + env.INSTAGRAM_DAILY_BATCH_SIZE);
      try {
        const saved = await enqueueDailyBatch(batch, owner, date);
        result.queued += saved.queued;
        result.reused += saved.reused;
        result.notDue += saved.notDue;
      } catch {
        result.failed += batch.length;
        result.failures.push(
          ...batch.map((profileId) => ({ profileId, code: 'DAILY_ENQUEUE_FAILED' })),
        );
      }
    }
  }
  result.pending = result.total - result.queued - result.reused - result.notDue - result.failed;
  // Não agenda Watched se parte do Daily nem sequer pôde ser enfileirada.
  if (!result.failed && !result.pending) {
    const watched = await scheduleWatchedSync(date, startedAt, clock);
    return { ...result, watched };
  }
  return result;
}
