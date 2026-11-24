import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod/v4';
import {
  withOwnedSync,
  SyncJobOwnershipLost,
  type InitialJobOwner,
} from './instagram.initial-sync.repository.js';
import { completeInstagramSyncJob, failInstagramSyncJob } from './instagram.sync-job.repository.js';
import type { normalizeInstagramPost } from '../shared/instagram.post.normalize.js';

const metadataSchema = z
  .object({
    providerSteps: z.record(z.string(), z.array(z.string())).default({}),
    providerAttempts: z.record(z.string(), z.int().min(1)).default({}),
  })
  .passthrough();
type MetricPost = ReturnType<typeof normalizeInstagramPost>;

export function readPostRefreshTarget(owner: InitialJobOwner, client?: PrismaClient) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const post = await tx.instagramPost.findUniqueOrThrow({
        where: { id: job.instagramPostId! },
        include: { instagramProfile: { select: { instagramId: true } } },
      });
      if (job.instagramProfileId && post.instagramProfileId !== job.instagramProfileId)
        throw new Error('POST_PROFILE_MISMATCH');
      return post;
    },
    client,
    'POST_REFRESH',
  );
}

export function preparePostRefreshRun(
  owner: InitialJobOwner,
  actor: string,
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = metadataSchema.parse(job.payload ?? {});
      const ids = metadata.providerSteps.post ?? [];
      const last = ids.at(-1);
      if (last) {
        const previous = await tx.providerRun.findUniqueOrThrow({ where: { id: last } });
        if (previous.actor !== actor || previous.instagramPostId !== job.instagramPostId)
          throw new Error('PROVIDER_RUN_MISMATCH');
        const attempt = metadata.providerAttempts[previous.id];
        if (previous.status !== 'failed' || attempt === undefined || attempt >= job.attempts)
          return { run: previous, fresh: false };
      }
      const post = await tx.instagramPost.findUniqueOrThrow({
        where: { id: job.instagramPostId! },
        select: { instagramProfileId: true, instagramProfile: { select: { ownerUserId: true } } },
      });
      const run = await tx.providerRun.create({
        data: {
          actor,
          trigger: job.trigger,
          status: 'running',
          instagramPostId: job.instagramPostId,
          instagramProfileId: post.instagramProfileId,
          userId: post.instagramProfile.ownerUserId ?? job.userId,
        },
      });
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: {
          payload: {
            ...metadata,
            providerSteps: { ...metadata.providerSteps, post: [...ids, run.id] },
            providerAttempts: { ...metadata.providerAttempts, [run.id]: job.attempts },
          } as Prisma.InputJsonValue,
        },
      });
      return { run, fresh: true };
    },
    client,
    'POST_REFRESH',
  );
}

export function commitPostRefresh(
  owner: InitialJobOwner,
  metric: MetricPost,
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      if (job.trigger !== 'on_open' && job.trigger !== 'refresh')
        throw new Error('INVALID_POST_REFRESH_TRIGGER');
      // Lock do post também coordena com as requisições HTTP que verificam frescor.
      await tx.$queryRaw`SELECT "id" FROM "InstagramPost" WHERE "id" = ${job.instagramPostId} FOR UPDATE`;
      const post = await tx.instagramPost.findUniqueOrThrow({
        where: { id: job.instagramPostId! },
        select: {
          instagramPostId: true,
          type: true,
          instagramProfile: { select: { instagramId: true } },
        },
      });
      if (
        post.instagramPostId !== metric.id ||
        post.instagramProfile.instagramId !== metric.ownerId ||
        post.type !== metric.type
      )
        throw new Error('POST_IDENTITY_MISMATCH');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      await tx.instagramPostMetricSnapshot.create({
        data: {
          instagramPostId: job.instagramPostId!,
          likesCount: metric.likesCount,
          likesHidden: metric.likesHidden,
          commentsCount: metric.commentsCount,
          viewsCount:
            metric.type === 'reel' && metric.viewsCount !== null ? BigInt(metric.viewsCount) : null,
          source: job.trigger,
          collectedAt: clock.now,
        },
      });
      await tx.instagramPost.update({
        where: { id: job.instagramPostId! },
        data: { lastCollectedAt: clock.now },
      });
      if (!(await completeInstagramSyncJob(owner, tx))) throw new SyncJobOwnershipLost();
    },
    client,
    'POST_REFRESH',
  );
}

export function failPostRefresh(owner: InitialJobOwner, code: string, client?: PrismaClient) {
  return withOwnedSync(
    owner,
    async (tx) => {
      const result = await failInstagramSyncJob(owner, code, tx);
      if (!result) throw new SyncJobOwnershipLost();
      return result;
    },
    client,
    'POST_REFRESH',
  );
}
