import {
  getInstagramLocalDate,
  hasProfileSnapshotOnDate,
} from '../shared/instagram.snapshot-day.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import {
  withOwnedSync,
  SyncJobOwnershipLost,
  type InitialJobOwner,
} from './instagram.initial-sync.repository.js';
import { completeInstagramSyncJob, failInstagramSyncJob } from './instagram.sync-job.repository.js';
import { findActiveProfileSyncJob } from './instagram.profile-job.repository.js';
import { watchedMetadataSchema } from './instagram.watched.schemas.js';
import {
  findWatchedCandidates,
  wasDailyAttempted,
  wasWatchedAttempted,
  hasActiveDaily,
} from './instagram.watched-eligibility.repository.js';
import {
  saveProfileCollectionInTransaction,
  type ProfileCollection,
} from '../profile/instagram.profile.repository.js';

export async function enqueueWatchedBatch(
  ids: string[],
  owner: string | null,
  date: string,
  client: PrismaClient = getPrismaClient(),
) {
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length)
    throw new Error('INVALID_WATCHED_BATCH');
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
          // Locks ordenados compartilham a exclusão com Daily, convites e contas acompanhadas.
          await tx.$queryRaw`SELECT "id" FROM "InstagramProfile" WHERE "id" IN (${Prisma.join([...ids].sort())}) ORDER BY "id" FOR UPDATE`;
          const profiles = await tx.instagramProfile.findMany({
            where: { id: { in: ids } },
            orderBy: { id: 'asc' },
          });
          const candidates = await findWatchedCandidates(clock.now, tx, ids);
          const selected: string[] = [];
          let reused = 0;
          let notDue = ids.length - profiles.length;
          for (const profile of profiles) {
            if (
              !candidates.some((p) => p.id === profile.id && p.userId === owner) ||
              (await hasProfileSnapshotOnDate(profile.id, date, tx))
            ) {
              notDue++;
              continue;
            }
            const previous = await tx.instagramSyncJob.findFirst({
              where: {
                type: 'WATCHED_SYNC',
                AND: [
                  { payload: { path: ['watched', 'date'], equals: date } },
                  { payload: { path: ['watched', 'profileIds'], array_contains: [profile.id] } },
                  {
                    OR: [
                      { status: 'FAILED' },
                      {
                        payload: {
                          path: ['watched', 'completedProfileIds'],
                          array_contains: [profile.id],
                        },
                      },
                    ],
                  },
                ],
              },
              select: { id: true },
            });
            if (
              previous ||
              (await wasWatchedAttempted(profile.id, date, tx)) ||
              (await wasDailyAttempted(profile.id, date, tx, clock.now)) ||
              (await findActiveProfileSyncJob(profile.id, tx, { ignoreDaily: true }))
            ) {
              reused++;
              continue;
            }
            selected.push(profile.id);
          }
          if (!selected.length) return { queued: 0, reused, notDue, jobId: null };
          const job = await tx.instagramSyncJob.create({
            data: {
              type: 'WATCHED_SYNC',
              trigger: 'watched',
              instagramProfileId: selected[0]!,
              userId: owner,
              activeKey: `watched:${date}:${selected[0]}`,
              runAt: clock.now,
              createdAt: clock.now,
              payload: watchedMetadataSchema.parse({
                watched: {
                  userId: owner,
                  date,
                  profileIds: selected,
                  remainingProfileIds: selected,
                },
              }) as Prisma.InputJsonValue,
            },
          });
          return { queued: selected.length, reused, notDue, jobId: job.id };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 30000,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2034', 'P2002'].includes(error.code) &&
        attempt < 3
      )
        continue;
      throw error;
    }
  }
}

export function readWatchedTargets(owner: InitialJobOwner, client?: PrismaClient) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = watchedMetadataSchema.parse(job.payload);
      if (job.userId !== metadata.watched.userId) throw new Error('WATCHED_OWNER_MISMATCH');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      const profiles = await tx.instagramProfile.findMany({
        where: { id: { in: metadata.watched.remainingProfileIds } },
        orderBy: { id: 'asc' },
      });
      const candidates = await findWatchedCandidates(
        clock.now,
        tx,
        metadata.watched.remainingProfileIds,
      );
      const targets = [];
      for (const profile of profiles) {
        if (
          candidates.some((p) => p.id === profile.id && p.userId === metadata.watched.userId) &&
          !(await hasProfileSnapshotOnDate(profile.id, getInstagramLocalDate(clock.now), tx)) &&
          !(await wasDailyAttempted(profile.id, metadata.watched.date, tx, clock.now))
        )
          targets.push(profile);
      }
      const selected = new Set(targets.map((profile) => profile.id));
      const skipped = metadata.watched.remainingProfileIds.filter((id) => !selected.has(id));
      if (skipped.length) {
        metadata.watched.remainingProfileIds = [...selected];
        metadata.watched.skippedProfileIds.push(...skipped);
        await tx.instagramSyncJob.update({
          where: { id: job.id },
          data: { payload: metadata as Prisma.InputJsonValue },
        });
      }
      return targets;
    },
    client,
    'WATCHED_SYNC',
  );
}

export function prepareWatchedRun(
  owner: InitialJobOwner,
  step: 'profile' | 'reels',
  actor: string,
  targetIds: string[],
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = watchedMetadataSchema.parse(job.payload);
      if (job.userId !== metadata.watched.userId) throw new Error('WATCHED_OWNER_MISMATCH');
      if (await hasActiveDaily(tx)) throw new Error('DAILY_SYNC_IN_PROGRESS');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      const candidates = await findWatchedCandidates(
        clock.now,
        tx,
        metadata.watched.remainingProfileIds,
      );
      const affectedIds = step === 'profile' ? targetIds : metadata.watched.remainingProfileIds;
      for (const id of affectedIds) {
        if (
          !candidates.some((p) => p.id === id && p.userId === job.userId) ||
          (await wasDailyAttempted(id, metadata.watched.date, tx, clock.now))
        )
          throw new Error('WATCHED_ELIGIBILITY_CHANGED');
      }

      const ids = metadata.providerSteps[step] ?? [];
      const last = ids.at(-1);
      if (last && targetIds.every((id) => metadata.runTargets[last]?.includes(id))) {
        const previous = await tx.providerRun.findUniqueOrThrow({ where: { id: last } });
        if (
          previous.actor !== actor ||
          previous.userId !== job.userId ||
          previous.trigger !== 'watched'
        )
          throw new Error('PROVIDER_RUN_MISMATCH');
        const attempt = metadata.providerAttempts[previous.id];
        if (previous.status !== 'failed' || attempt === undefined || attempt >= job.attempts)
          return { run: previous, fresh: false };
      }
      const run = await tx.providerRun.create({
        data: {
          actor,
          trigger: 'watched',
          userId: job.userId,
          status: 'running',
          instagramProfileId:
            metadata.watched.profileIds.length === 1 ? metadata.watched.profileIds[0]! : null,
        },
      });
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: {
          payload: {
            ...metadata,
            providerSteps: { ...metadata.providerSteps, [step]: [...ids, run.id] },
            providerAttempts: { ...metadata.providerAttempts, [run.id]: job.attempts },
            runTargets: { ...metadata.runTargets, [run.id]: targetIds },
          } as Prisma.InputJsonValue,
        },
      });
      return { run, fresh: true };
    },
    client,
    'WATCHED_SYNC',
  );
}

export function commitWatchedProfile(
  owner: InitialJobOwner,
  profileId: string,
  collection: ProfileCollection,
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = watchedMetadataSchema.parse(job.payload);
      if (!metadata.watched.remainingProfileIds.includes(profileId))
        throw new Error('WATCHED_PROFILE_ALREADY_PROCESSED');
      const profile = await tx.instagramProfile.findUniqueOrThrow({ where: { id: profileId } });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      const candidates = await findWatchedCandidates(clock.now, tx, [profileId]);
      if (
        candidates.length &&
        !(await wasDailyAttempted(profileId, metadata.watched.date, tx, clock.now))
      ) {
        if (profile.instagramId !== collection.profile.instagramId)
          throw new Error('PROFILE_IDENTITY_MISMATCH');
        // Se outra coleta terminou enquanto o Actor rodava, preservar os posts
        // obtidos; a persistencia deduplica somente a contagem de seguidores.
        const saved = await saveProfileCollectionInTransaction(
          { ...collection, metricSource: 'daily', profileSnapshotCadence: 'new-york-day' },
          tx,
        );
        if (saved.instagramProfileId !== profileId) throw new Error('PROFILE_IDENTITY_MISMATCH');
        await tx.instagramProfile.update({
          where: { id: profileId },
          data: { syncStatus: 'ready', lastSyncedAt: collection.collectedAt },
        });
        metadata.watched.completedProfileIds.push(profileId);
      } else metadata.watched.skippedProfileIds.push(profileId);
      metadata.watched.remainingProfileIds = metadata.watched.remainingProfileIds.filter(
        (id) => id !== profileId,
      );
      delete metadata.watched.failures[profileId];
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: { payload: metadata as Prisma.InputJsonValue },
      });
    },
    client,
    'WATCHED_SYNC',
  );
}

export function finishWatchedAttempt(
  owner: InitialJobOwner,
  failures: Record<string, string>,
  errorCode?: string,
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const parsed = watchedMetadataSchema.safeParse(job.payload);
      if (!parsed.success) {
        const failed = await failInstagramSyncJob(owner, 'INVALID_WATCHED_JOB_PAYLOAD', tx);
        if (!failed) throw new SyncJobOwnershipLost();
        return { status: failed.status, updated: 0 };
      }
      const metadata = parsed.data;
      metadata.watched.failures = { ...metadata.watched.failures, ...failures };
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: { payload: metadata as Prisma.InputJsonValue },
      });
      if (!metadata.watched.remainingProfileIds.length) {
        if (!(await completeInstagramSyncJob(owner, tx))) throw new SyncJobOwnershipLost();
        return { status: 'SUCCEEDED', updated: metadata.watched.completedProfileIds.length };
      }
      const result = await failInstagramSyncJob(owner, errorCode ?? 'WATCHED_SYNC_INCOMPLETE', tx);
      if (!result) throw new SyncJobOwnershipLost();
      return { status: result.status, updated: metadata.watched.completedProfileIds.length };
    },
    client,
    'WATCHED_SYNC',
  );
}
