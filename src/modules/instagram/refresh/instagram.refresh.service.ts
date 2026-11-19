import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { getInstagramProfile } from '../profile/instagram.profile.service.js';
import { getInstagramRefreshWindowStart } from './instagram.refresh.schedule.js';
import { ProviderError } from '../../../errors/provider.error.js';

export async function runInstagramRefresh(now = new Date(), clock = Date.now) {
  const windowStart = getInstagramRefreshWindowStart(now);
  if (!windowStart) return { skipped: true as const, reason: 'OUTSIDE_SCHEDULE' };
  const startedAt = clock();
  const profiles = await getPrismaClient().instagramProfile.findMany({
    orderBy: { id: 'asc' },
    select: { instagramId: true, username: true },
  });
  const result = {
    skipped: false as const,
    total: profiles.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    pending: profiles.length,
    failures: [] as { instagramId: string; code: string }[],
  };
  for (const profile of profiles) {
    // Reserva tempo para uma coleta limitada e sua transação antes do teto de 300s.
    if (clock() - startedAt >= 180000) break;
    try {
      await getInstagramProfile(
        { username: profile.username },
        {
          expectedInstagramId: profile.instagramId,
          refreshMetricsSince: windowStart,
        },
      );
      result.succeeded++;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'REFRESH_FAILED';
      result.failures.push({ instagramId: profile.instagramId, code });
      result.failed++;
      if (error instanceof ProviderError && error.statusCode === 429) {
        result.processed++;
        result.pending = result.total - result.processed;
        break; // Não continuar consumindo chamadas quando o provedor recusar o lote.
      }
    }
    result.processed++;
    result.pending = result.total - result.processed;
  }
  return result;
}
