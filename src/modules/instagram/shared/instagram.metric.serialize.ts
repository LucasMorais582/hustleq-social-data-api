import type { InstagramMediaType, InstagramPostMetricSnapshot } from '@prisma/client';
import { ApiError } from '../../../errors/api.error.js';

type StoredMetric = Pick<
  InstagramPostMetricSnapshot,
  'likesCount' | 'likesHidden' | 'commentsCount' | 'viewsCount' | 'collectedAt'
>;
function publicViews(value: bigint | null) {
  if (value === null) return null;
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      'A métrica salva excede a faixa numérica do contrato',
    );
  }
  return Number(value);
}
export function serializeStoredPostMetric(metric: StoredMetric, type: InstagramMediaType) {
  const likesHidden = metric.likesHidden || metric.likesCount === -1;
  return {
    likesCount: likesHidden ? null : metric.likesCount,
    likesHidden,
    commentsCount: metric.commentsCount,
    viewsCount: type === 'reel' ? publicViews(metric.viewsCount) : null,
    collectedAt: metric.collectedAt.toISOString(),
  };
}
