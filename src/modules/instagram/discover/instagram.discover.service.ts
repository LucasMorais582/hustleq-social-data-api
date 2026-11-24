import { setTimeout } from 'node:timers/promises';
import { z } from 'zod/v4';
import type { DiscoverCache } from '@prisma/client';
import { env } from '../../../config/env.js';
import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { beginDiscover, readDiscoverProgress } from './instagram.discover.repository.js';
import {
  discoverKey,
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
export async function getInstagramDiscover(
  query: DiscoverQuery,
  userId: string | null,
  options: { signal?: AbortSignal; waitMs?: number; pollMs?: number } = {},
) {
  const deadline = Date.now() + (options.waitMs ?? env.INSTAGRAM_DISCOVER_WAIT_MS);
  const initial = await beginDiscover(query, userId);
  if (initial.cache) return response(initial.cache, query, true);
  if (!initial.jobId) throw new Error('DISCOVER_JOB_MISSING');
  for (;;) {
    if (options.signal?.aborted) throw providerFailure('A espera pela busca foi interrompida');
    const progress = await readDiscoverProgress(discoverKey(query), initial.jobId);
    if (progress.job.status === 'FAILED') {
      const failure = failureSchema.safeParse(progress.job.payload);
      if (failure.success)
        throw new ProviderError(
          failure.data.failure.status,
          failure.data.failure.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
          failure.data.failure.message,
        );
      throw providerFailure('Não foi possível concluir a busca na Apify');
    }
    if (progress.cache) return response(progress.cache, query, !initial.created);
    if (progress.job.status === 'SUCCEEDED')
      throw providerFailure('A busca terminou sem cache válido');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw providerFailure('Tempo limite ao aguardar a busca do Discover');
    try {
      await setTimeout(Math.min(options.pollMs ?? 2000, remaining), undefined, {
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw providerFailure('A espera pela busca foi interrompida');
      throw error;
    }
  }
}
