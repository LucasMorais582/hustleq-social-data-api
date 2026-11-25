import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod/v4';
import { ProviderError } from '../../../errors/provider.error.js';
import {
  withOwnedSync,
  SyncJobOwnershipLost,
  type InitialJobOwner,
} from './instagram.initial-sync.repository.js';
import { completeInstagramSyncJob, failInstagramSyncJob } from './instagram.sync-job.repository.js';
import { discoverTargetSchema } from '../discover/instagram.discover.schemas.js';
import { normalizeDiscoverPosts } from '../discover/instagram.discover.normalize.js';

export const DISCOVER_ACTOR = 'seemuapps/instagram-keyword-posts-scraper';
const metadataSchema = z
  .object({
    discover: discoverTargetSchema,
    providerSteps: z.record(z.string(), z.array(z.string())).default({}),
    providerAttempts: z.record(z.string(), z.int().min(1)).default({}),
  })
  .passthrough();
export function readDiscoverTarget(owner: InitialJobOwner, client?: PrismaClient) {
  return withOwnedSync(
    owner,
    async (_tx, job) => metadataSchema.parse(job.payload).discover,
    client,
    'DISCOVER_SEARCH',
  );
}
export function prepareDiscoverRun(owner: InitialJobOwner, client?: PrismaClient) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = metadataSchema.parse(job.payload);
      const ids = metadata.providerSteps.discover ?? [];
      const last = ids.at(-1);
      if (last) {
        const previous = await tx.providerRun.findUniqueOrThrow({ where: { id: last } });
        if (
          previous.actor !== DISCOVER_ACTOR ||
          previous.userId !== job.userId ||
          previous.trigger !== 'discover' ||
          previous.instagramProfileId !== null ||
          previous.instagramPostId !== null
        )
          throw new Error('PROVIDER_RUN_MISMATCH');
        const attempt = metadata.providerAttempts[previous.id];
        if (previous.status !== 'failed' || attempt === undefined || attempt >= job.attempts)
          return { run: previous, fresh: false };
      }
      const run = await tx.providerRun.create({
        data: { actor: DISCOVER_ACTOR, trigger: 'discover', userId: job.userId, status: 'running' },
      });
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: {
          payload: {
            ...metadata,
            providerSteps: { ...metadata.providerSteps, discover: [...ids, run.id] },
            providerAttempts: { ...metadata.providerAttempts, [run.id]: job.attempts },
          } as Prisma.InputJsonValue,
        },
      });
      return { run, fresh: true };
    },
    client,
    'DISCOVER_SEARCH',
  );
}
export function commitDiscoverSearch(
  owner: InitialJobOwner,
  items: unknown[],
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const target = metadataSchema.parse(job.payload).discover;
      // Coordena publicação do cache/conclusão com o enqueue HTTP, evitando busca duplicada.
      if (!job.activeKey) throw new Error('DISCOVER_ACTIVE_KEY_MISSING');
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${job.activeKey}, 0))`;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      const posts = normalizeDiscoverPosts(items, target, clock.now);
      const data = {
        niche: target.niche,
        city: target.city,
        query: target.query,
        results: posts as Prisma.InputJsonValue,
        fetchedAt: clock.now,
      };
      await tx.discoverCache.upsert({
        where: { key: target.key },
        create: { key: target.key, ...data },
        update: data,
      });
      if (!(await completeInstagramSyncJob(owner, tx))) throw new SyncJobOwnershipLost();
    },
    client,
    'DISCOVER_SEARCH',
  );
}
export function failDiscoverSearch(owner: InitialJobOwner, error: unknown, client?: PrismaClient) {
  const status = error instanceof ProviderError && error.statusCode === 429 ? 429 : 503;
  const message = (
    error instanceof ProviderError ? error.message : 'Não foi possível concluir a busca na Apify'
  )
    .replace(/apify_api_[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 1000);
  const code = status === 429 ? 'PROVIDER_RATE_LIMITED' : 'DISCOVER_SEARCH_FAILED';
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = metadataSchema.parse(job.payload);
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: { payload: { ...metadata, failure: { status, message } } as Prisma.InputJsonValue },
      });
      const failed = await failInstagramSyncJob(owner, code, tx);
      if (!failed) throw new SyncJobOwnershipLost();
      return failed;
    },
    client,
    'DISCOVER_SEARCH',
  );
}
