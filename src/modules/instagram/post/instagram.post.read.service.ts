import type { PrismaClient } from '@prisma/client';
import { serializeStoredPostMetric } from '../shared/instagram.metric.serialize.js';
import type { ReadRange } from '../shared/instagram.read.schemas.js';
import { readStoredInstagramPostMetrics } from './instagram.post.read.repository.js';
import { postMetricsResponseSchema } from './instagram.post.read.schemas.js';

export async function getStoredInstagramPostMetrics(
  postId: string,
  userId: string,
  range: ReadRange,
  client?: PrismaClient,
) {
  const { type, metrics } = await readStoredInstagramPostMetrics(postId, userId, range, client);
  return postMetricsResponseSchema.parse({
    postId,
    metrics: metrics.map((metric) => ({
      ...serializeStoredPostMetric(metric, type),
      source: metric.source,
    })),
  });
}
