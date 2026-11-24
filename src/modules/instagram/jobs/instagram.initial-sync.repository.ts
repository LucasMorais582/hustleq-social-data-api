import { Prisma, type InstagramSyncJob, type PrismaClient } from '@prisma/client';
import { z } from 'zod/v4';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import {
  saveProfileCollectionInTransaction,
  type ProfileCollection,
} from '../profile/instagram.profile.repository.js';
import { completeInstagramSyncJob, failInstagramSyncJob } from './instagram.sync-job.repository.js';

export class SyncJobOwnershipLost extends Error {
  readonly code = 'SYNC_JOB_OWNERSHIP_LOST';
  constructor() {
    super('O worker não possui mais a tarefa');
  }
}
export type InitialJobOwner = { id: string; lockToken: string };
const metadataSchema = z
  .object({
    providerSteps: z.record(z.string(), z.array(z.string())).default({}),
    providerAttempts: z.record(z.string(), z.int().min(1)).default({}),
  })
  .passthrough();

export async function withOwnedSync<T>(
  owner: InitialJobOwner,
  work: (tx: Prisma.TransactionClient, job: InstagramSyncJob) => Promise<T>,
  client: PrismaClient = getPrismaClient(),
  type: 'INITIAL_PROFILE_SYNC' | 'POST_REFRESH' = 'INITIAL_PROFILE_SYNC',
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<InstagramSyncJob[]>`
          SELECT * FROM "InstagramSyncJob"
          WHERE "id" = ${owner.id} AND "type" = ${type}::"InstagramSyncJobType"
            AND "status" = 'RUNNING' AND "lockToken" = ${owner.lockToken}
            AND "leaseExpiresAt" > statement_timestamp()
          FOR UPDATE
        `;
          if (!rows[0]) throw new SyncJobOwnershipLost();
          const result = await work(tx, rows[0]);
          const [lease] = await tx.$queryRaw<{ valid: boolean }[]>`
          SELECT clock_timestamp() < ${rows[0].leaseExpiresAt} AS valid
        `;
          if (!lease?.valid) throw new SyncJobOwnershipLost();
          return result;
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
        error.code === 'P2034' &&
        attempt < 3
      )
        continue;
      throw error;
    }
  }
}

export function withOwnedInitialSync<T>(
  owner: InitialJobOwner,
  work: (tx: Prisma.TransactionClient, job: InstagramSyncJob) => Promise<T>,
  client?: PrismaClient,
) {
  return withOwnedSync(owner, work, client);
}

export function beginInitialProfileSync(owner: InitialJobOwner, client?: PrismaClient) {
  return withOwnedInitialSync(
    owner,
    async (tx, job) => {
      const profile = await tx.instagramProfile.update({
        where: { id: job.instagramProfileId! },
        data: { syncStatus: 'syncing' },
        select: { id: true, instagramId: true, username: true },
      });
      return profile;
    },
    client,
  );
}

export function prepareInitialSyncRun(
  owner: InitialJobOwner,
  step: 'profile' | 'reels',
  actor: string,
  client?: PrismaClient,
) {
  return withOwnedInitialSync(
    owner,
    async (tx, job) => {
      const metadata = metadataSchema.parse(job.payload ?? {});
      const ids = metadata.providerSteps[step] ?? [];
      const last = ids.at(-1);
      if (last) {
        const previous = await tx.providerRun.findUniqueOrThrow({ where: { id: last } });
        if (previous.actor !== actor || previous.instagramProfileId !== job.instagramProfileId)
          throw new Error('PROVIDER_RUN_MISMATCH');
        const attempt = metadata.providerAttempts[previous.id];
        if (previous.status !== 'failed' || attempt === undefined || attempt >= job.attempts)
          return { run: previous, fresh: false };
      }
      const profile = await tx.instagramProfile.findUniqueOrThrow({
        where: { id: job.instagramProfileId! },
        select: { ownerUserId: true },
      });
      const run = await tx.providerRun.create({
        data: {
          actor,
          trigger: job.trigger,
          status: 'running',
          instagramProfileId: job.instagramProfileId,
          userId: profile.ownerUserId ?? job.userId,
        },
      });
      await tx.instagramSyncJob.update({
        where: { id: job.id },
        data: {
          payload: {
            ...metadata,
            providerSteps: { ...metadata.providerSteps, [step]: [...ids, run.id] },
            providerAttempts: { ...metadata.providerAttempts, [run.id]: job.attempts },
          } as Prisma.InputJsonValue,
        },
      });
      return { run, fresh: true };
    },
    client,
  );
}

export function commitInitialProfileSync(
  owner: InitialJobOwner,
  collection: ProfileCollection,
  client?: PrismaClient,
) {
  return withOwnedInitialSync(
    owner,
    async (tx, job) => {
      const profile = await tx.instagramProfile.findUniqueOrThrow({
        where: { id: job.instagramProfileId! },
        select: { instagramId: true },
      });
      if (profile.instagramId !== collection.profile.instagramId)
        throw new Error('PROFILE_IDENTITY_MISMATCH');
      const saved = await saveProfileCollectionInTransaction(collection, tx);
      if (saved.instagramProfileId !== job.instagramProfileId)
        throw new Error('PROFILE_IDENTITY_MISMATCH');
      await tx.instagramProfile.update({
        where: { id: job.instagramProfileId! },
        data: { syncStatus: 'ready', lastSyncedAt: collection.collectedAt },
      });
      if (!(await completeInstagramSyncJob(owner, tx))) throw new SyncJobOwnershipLost();
    },
    client,
  );
}

export function failInitialProfileSync(
  owner: InitialJobOwner,
  code: string,
  client?: PrismaClient,
) {
  return withOwnedInitialSync(
    owner,
    async (tx, job) => {
      const result = await failInstagramSyncJob(owner, code, tx);
      if (!result) throw new SyncJobOwnershipLost();
      await tx.instagramProfile.update({
        where: { id: job.instagramProfileId! },
        data: { syncStatus: result.status === 'FAILED' ? 'failed' : 'syncing' },
      });
      return result;
    },
    client,
  );
}
