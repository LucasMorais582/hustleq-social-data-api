import type { Prisma, InstagramSyncJob } from '@prisma/client';
import { dailyMetadataSchema } from '../jobs/instagram.daily.schemas.js';

// Executado na mesma transação serializável da comparação do dono.
export async function removeProfileOwnerInTransaction(id: string, tx: Prisma.TransactionClient) {
  await tx.instagramProfile.update({ where: { id }, data: { ownerUserId: null } });
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
  await tx.instagramCompetitor.updateMany({
    where: { instagramProfileId: id, endedAt: null },
    data: { endedAt: clock.now },
  });
  // Um claim concorrente vence ou perde o lock: nunca reescreve um RUNNING como pendente.
  const jobs = await tx.$queryRaw<InstagramSyncJob[]>`
    SELECT job.* FROM "InstagramSyncJob" job
    WHERE job."status" = 'PENDING' AND (
      (job."type" = 'INITIAL_PROFILE_SYNC' AND job."instagramProfileId" = ${id})
      OR (job."type" = 'POST_REFRESH' AND EXISTS (
        SELECT 1 FROM "InstagramPost" post
        WHERE post."id" = job."instagramPostId" AND post."instagramProfileId" = ${id}
      ))
      OR (job."type" = 'DAILY_PROFILE_SYNC' AND
        job."payload"->'daily'->'remainingProfileIds' @> ${JSON.stringify([id])}::jsonb)
    ) ORDER BY job."id" FOR UPDATE OF job SKIP LOCKED
  `;
  const cancelled = {
    status: 'FAILED' as const,
    lastError: 'PROFILE_OWNER_REMOVED',
    activeKey: null,
    lockedAt: null,
    leaseExpiresAt: null,
    lockToken: null,
    finishedAt: clock.now,
  };
  const singles = jobs.filter((job) => job.type !== 'DAILY_PROFILE_SYNC').map((job) => job.id);
  if (singles.length)
    await tx.instagramSyncJob.updateMany({
      where: { id: { in: singles }, status: 'PENDING' },
      data: cancelled,
    });
  for (const job of jobs.filter((job) => job.type === 'DAILY_PROFILE_SYNC')) {
    let data: Prisma.InstagramSyncJobUpdateManyMutationInput = cancelled;
    if (job.type === 'DAILY_PROFILE_SYNC') {
      const metadata = dailyMetadataSchema.parse(job.payload);
      metadata.daily.remainingProfileIds = metadata.daily.remainingProfileIds.filter(
        (p) => p !== id,
      );
      metadata.daily.skippedProfileIds = [...new Set([...metadata.daily.skippedProfileIds, id])];
      delete metadata.daily.failures[id];
      data = {
        ...(metadata.daily.remainingProfileIds.length ? {} : cancelled),
        payload: metadata as Prisma.InputJsonValue,
      };
    }
    await tx.instagramSyncJob.updateMany({ where: { id: job.id, status: 'PENDING' }, data });
  }
}
