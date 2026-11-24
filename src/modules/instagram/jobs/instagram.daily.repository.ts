import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import {
  withOwnedSync,
  SyncJobOwnershipLost,
  type InitialJobOwner,
} from './instagram.initial-sync.repository.js';
import { completeInstagramSyncJob, failInstagramSyncJob } from './instagram.sync-job.repository.js';
import { findActiveProfileSyncJob } from './instagram.profile-job.repository.js';
import { dailyMetadataSchema } from './instagram.daily.schemas.js';
import {
  saveProfileCollectionInTransaction,
  type ProfileCollection,
} from '../profile/instagram.profile.repository.js';

export const DAILY_MIN_INTERVAL_MS = 20 * 3600000;
function eligible(
  profile: { ownerUserId: string | null; monitoringUntil: Date | null },
  owner: string,
  now: Date,
) {
  return (
    profile.ownerUserId === owner && (!profile.monitoringUntil || profile.monitoringUntil > now)
  );
}
export async function enqueueDailyBatch(
  ids: string[],
  owner: string,
  date: string,
  client: PrismaClient = getPrismaClient(),
) {
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length)
    throw new Error('INVALID_DAILY_BATCH');
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
          // Mesma ordem de locks entre schedulers; upserts de convites/concorrentes também serializam no perfil.
          await tx.$queryRaw`SELECT "id" FROM "InstagramProfile" WHERE "id" IN (${Prisma.join([...ids].sort())}) ORDER BY "id" FOR UPDATE`;
          const profiles = await tx.instagramProfile.findMany({
            where: { id: { in: ids } },
            orderBy: { id: 'asc' },
          });
          const selected: string[] = [];
          let reused = 0;
          let notDue = ids.length - profiles.length;
          for (const profile of profiles) {
            const age = profile.lastSyncedAt
              ? clock.now.getTime() - profile.lastSyncedAt.getTime()
              : Infinity;
            if (!eligible(profile, owner, clock.now) || (age >= 0 && age < DAILY_MIN_INTERVAL_MS)) {
              notDue++;
              continue;
            }
            const previous = await tx.instagramSyncJob.findFirst({
              where: {
                type: 'DAILY_PROFILE_SYNC',
                AND: [
                  { payload: { path: ['daily', 'date'], equals: date } },
                  { payload: { path: ['daily', 'profileIds'], array_contains: [profile.id] } },
                ],
              },
              select: { id: true },
            });
            if (previous || (await findActiveProfileSyncJob(profile.id, tx))) {
              reused++;
              continue;
            }
            selected.push(profile.id);
          }
          if (!selected.length) return { queued: 0, reused, notDue, jobId: null };
          const job = await tx.instagramSyncJob.create({
            data: {
              type: 'DAILY_PROFILE_SYNC',
              trigger: 'daily',
              instagramProfileId: selected[0]!,
              userId: owner,
              activeKey: `daily:${date}:${selected[0]}`,
              runAt: clock.now,
              createdAt: clock.now,
              payload: dailyMetadataSchema.parse({
                daily: {
                  ownerUserId: owner,
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

export function readDailyTargets(owner: InitialJobOwner, client?: PrismaClient) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = dailyMetadataSchema.parse(job.payload);
      if (job.userId !== metadata.daily.ownerUserId) throw new Error('DAILY_OWNER_MISMATCH');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      const profiles = await tx.instagramProfile.findMany({
        where: { id: { in: metadata.daily.remainingProfileIds } },
        orderBy: { id: 'asc' },
      });
      const targets = profiles.filter((profile) =>
        eligible(profile, metadata.daily.ownerUserId, clock.now),
      );
      const selected = new Set(targets.map((profile) => profile.id));
      const skipped = metadata.daily.remainingProfileIds.filter((id) => !selected.has(id));
      if (skipped.length) {
        metadata.daily.remainingProfileIds = [...selected];
        metadata.daily.skippedProfileIds.push(...skipped);
        await tx.instagramSyncJob.update({
          where: { id: job.id },
          data: { payload: metadata as Prisma.InputJsonValue },
        });
      }
      return targets;
    },
    client,
    'DAILY_PROFILE_SYNC',
  );
}

export function prepareDailyRun(
  owner: InitialJobOwner,
  step: 'profile' | 'reels',
  actor: string,
  targetIds: string[],
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = dailyMetadataSchema.parse(job.payload);
      const ids = metadata.providerSteps[step] ?? [];
      const last = ids.at(-1);
      if (last && targetIds.every((id) => metadata.runTargets[last]?.includes(id))) {
        const previous = await tx.providerRun.findUniqueOrThrow({ where: { id: last } });
        if (
          previous.actor !== actor ||
          previous.userId !== job.userId ||
          previous.trigger !== 'daily'
        )
          throw new Error('PROVIDER_RUN_MISMATCH');
        const attempt = metadata.providerAttempts[previous.id];
        if (previous.status !== 'failed' || attempt === undefined || attempt >= job.attempts)
          return { run: previous, fresh: false };
      }
      const run = await tx.providerRun.create({
        data: {
          actor,
          trigger: 'daily',
          userId: job.userId,
          status: 'running',
          instagramProfileId:
            metadata.daily.profileIds.length === 1 ? metadata.daily.profileIds[0]! : null,
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
    'DAILY_PROFILE_SYNC',
  );
}

export function commitDailyProfile(
  owner: InitialJobOwner,
  profileId: string,
  collection: ProfileCollection,
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const metadata = dailyMetadataSchema.parse(job.payload);
      if (!metadata.daily.remainingProfileIds.includes(profileId))
        throw new Error('DAILY_PROFILE_ALREADY_PROCESSED');
      const profile = await tx.instagramProfile.findUniqueOrThrow({ where: { id: profileId } });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      if (eligible(profile, metadata.daily.ownerUserId, clock.now)) {
        if (profile.instagramId !== collection.profile.instagramId)
          throw new Error('PROFILE_IDENTITY_MISMATCH');
        const saved = await saveProfileCollectionInTransaction(
          { ...collection, metricSource: 'daily', profileSnapshotMinIntervalHours: 20 },
          tx,
        );
        if (saved.instagramProfileId !== profileId) throw new Error('PROFILE_IDENTITY_MISMATCH');
        await tx.instagramProfile.update({
          where: { id: profileId },
          data: { syncStatus: 'ready', lastSyncedAt: collection.collectedAt },
        });
        metadata.daily.completedProfileIds.push(profileId);
      } else metadata.daily.skippedProfileIds.push(profileId);
      metadata.daily.remainingProfileIds = metadata.daily.remainingProfileIds.filter(
        (id) => id !== profileId,
      );
      delete metadata.daily.failures[profileId];
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: { payload: metadata as Prisma.InputJsonValue },
      });
    },
    client,
    'DAILY_PROFILE_SYNC',
  );
}

export function finishDailyAttempt(
  owner: InitialJobOwner,
  failures: Record<string, string>,
  errorCode?: string,
  client?: PrismaClient,
) {
  return withOwnedSync(
    owner,
    async (tx, job) => {
      const parsed = dailyMetadataSchema.safeParse(job.payload);
      if (!parsed.success) {
        const failed = await failInstagramSyncJob(owner, 'INVALID_DAILY_JOB_PAYLOAD', tx);
        if (!failed) throw new SyncJobOwnershipLost();
        return { status: failed.status, updated: 0 };
      }
      const metadata = parsed.data;
      metadata.daily.failures = { ...metadata.daily.failures, ...failures };
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: { payload: metadata as Prisma.InputJsonValue },
      });
      if (!metadata.daily.remainingProfileIds.length) {
        if (!(await completeInstagramSyncJob(owner, tx))) throw new SyncJobOwnershipLost();
        return { status: 'SUCCEEDED', updated: metadata.daily.completedProfileIds.length };
      }
      const result = await failInstagramSyncJob(
        owner,
        errorCode ?? 'DAILY_PROFILE_SYNC_INCOMPLETE',
        tx,
      );
      if (!result) throw new SyncJobOwnershipLost();
      return { status: result.status, updated: metadata.daily.completedProfileIds.length };
    },
    client,
    'DAILY_PROFILE_SYNC',
  );
}
