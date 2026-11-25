import { z } from 'zod/v4';
import type { DiscoverCache } from '@prisma/client';
import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { beginDiscover } from './instagram.discover.repository.js';
import {
  discoverPostsSchema,
  discoverResponseSchema,
  type DiscoverQuery,
} from './instagram.discover.schemas.js';

const failureSchema = z.object({
  failure: z.object({
    status: z.union([z.literal(429), z.literal(503)]),
    message: z.string().max(1000),
  }),
});
function response(cache: DiscoverCache, query: DiscoverQuery, fromCache: boolean) {
  return discoverResponseSchema.parse({
    ...query,
    fromCache,
    fetchedAt: cache.fetchedAt.toISOString(),
    posts: discoverPostsSchema.parse(cache.results),
  });
}
export async function getInstagramDiscover(query: DiscoverQuery, userId: string | null) {
  const initial = await beginDiscover(query, userId);
  if (initial.cache) return response(initial.cache, query, true);
  if (!initial.jobId) throw new Error('DISCOVER_JOB_MISSING');
  if ('failed' in initial && initial.failed) {
    const failure = failureSchema.safeParse(initial.payload);
    if (failure.success)
      throw new ProviderError(
        failure.data.failure.status,
        failure.data.failure.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
        failure.data.failure.message,
      );
    throw providerFailure('Não foi possível concluir a busca na Apify');
  }
  return { status: 'searching' as const };
}
