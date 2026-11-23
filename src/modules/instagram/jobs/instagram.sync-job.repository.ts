import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type InstagramSyncJob } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import {
  enqueueSyncJobSchema,
  syncJobLeaseSchema,
  syncJobOwnershipSchema,
  syncJobErrorCodeSchema,
  type EnqueueSyncJobInput,
} from './instagram.sync-job.schemas.js';

export const SYNC_JOB_MAX_ATTEMPTS = 3;
export const SYNC_JOB_RETRY_DELAYS_MS = [60000, 300000] as const;
type QueueClient = Pick<PrismaClient, 'instagramSyncJob' | '$queryRaw'>;
type JobOwner = { id: string; lockToken: string };

export async function enqueueInstagramSyncJob(
  input: EnqueueSyncJobInput,
  client: QueueClient = getPrismaClient(),
) {
  const data = enqueueSyncJobSchema.parse(input);
  const create: Prisma.InstagramSyncJobUncheckedCreateInput = {
    type: data.type,
    trigger: data.trigger,
    activeKey: data.activeKey,
    instagramProfileId: data.instagramProfileId ?? null,
    instagramPostId: data.instagramPostId ?? null,
    userId: data.userId ?? null,
    ...(data.runAt === undefined ? {} : { runAt: data.runAt }),
    ...(data.payload === undefined
      ? {}
      : {
          payload:
            data.payload === null ? Prisma.JsonNull : (data.payload as Prisma.InputJsonValue),
        }),
  };
  // Update não vazio permite ao Prisma usar o upsert nativo do PostgreSQL.
  // Não sobrescreve alvo, usuário, payload ou agenda de um job já ativo.
  return client.instagramSyncJob.upsert({
    where: { activeKey: data.activeKey },
    create,
    update: { activeKey: data.activeKey },
  });
}

export async function claimNextInstagramSyncJob(
  leaseMs: number,
  client: QueueClient = getPrismaClient(),
) {
  syncJobLeaseSchema.parse(leaseMs);
  const token = randomUUID(); // Token de posse, não ID de entidade.
  const jobs = await client.$queryRaw<InstagramSyncJob[]>`
    UPDATE "InstagramSyncJob" AS job
    SET "status" = 'RUNNING', "attempts" = job."attempts" + 1,
        "lockedAt" = statement_timestamp(),
        "leaseExpiresAt" = statement_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
        "lockToken" = ${token}, "updatedAt" = statement_timestamp()
    WHERE job."id" = (
      SELECT "id" FROM "InstagramSyncJob"
      WHERE "status" = 'PENDING' AND "runAt" <= statement_timestamp()
        AND "attempts" < ${SYNC_JOB_MAX_ATTEMPTS}
      ORDER BY "runAt" ASC, "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING job.*
  `;
  return jobs[0] ?? null;
}

export async function renewInstagramSyncJobLease(
  owner: JobOwner,
  leaseMs: number,
  client: QueueClient = getPrismaClient(),
) {
  syncJobOwnershipSchema.parse(owner);
  syncJobLeaseSchema.parse(leaseMs);
  const rows = await client.$queryRaw<{ id: string }[]>`
    UPDATE "InstagramSyncJob"
    SET "leaseExpiresAt" = statement_timestamp() + (${leaseMs} * INTERVAL '1 millisecond'),
        "updatedAt" = statement_timestamp()
    WHERE "id" = ${owner.id} AND "status" = 'RUNNING' AND "lockToken" = ${owner.lockToken}
      AND "leaseExpiresAt" > statement_timestamp()
    RETURNING "id"
  `;
  return rows.length === 1;
}

export async function completeInstagramSyncJob(
  owner: JobOwner,
  client: QueueClient = getPrismaClient(),
) {
  syncJobOwnershipSchema.parse(owner);
  const rows = await client.$queryRaw<{ id: string }[]>`
    UPDATE "InstagramSyncJob"
    SET "status" = 'SUCCEEDED', "activeKey" = NULL, "lockedAt" = NULL,
        "leaseExpiresAt" = NULL, "lockToken" = NULL, "lastError" = NULL,
        "finishedAt" = statement_timestamp(), "updatedAt" = statement_timestamp()
    WHERE "id" = ${owner.id} AND "status" = 'RUNNING' AND "lockToken" = ${owner.lockToken}
      AND "leaseExpiresAt" > statement_timestamp()
    RETURNING "id"
  `;
  return rows.length === 1;
}

export async function failInstagramSyncJob(
  owner: JobOwner,
  errorCode: string,
  client: QueueClient = getPrismaClient(),
) {
  syncJobOwnershipSchema.parse(owner);
  syncJobErrorCodeSchema.parse(errorCode);
  const rows = await client.$queryRaw<InstagramSyncJob[]>`
    UPDATE "InstagramSyncJob"
    SET "status" = CASE WHEN "attempts" >= ${SYNC_JOB_MAX_ATTEMPTS}
          THEN 'FAILED'::"InstagramSyncJobStatus" ELSE 'PENDING'::"InstagramSyncJobStatus" END,
        "activeKey" = CASE WHEN "attempts" >= ${SYNC_JOB_MAX_ATTEMPTS} THEN NULL ELSE "activeKey" END,
        "finishedAt" = CASE WHEN "attempts" >= ${SYNC_JOB_MAX_ATTEMPTS} THEN statement_timestamp() ELSE NULL END,
        "runAt" = CASE WHEN "attempts" = 1
          THEN statement_timestamp() + (${SYNC_JOB_RETRY_DELAYS_MS[0]} * INTERVAL '1 millisecond')
          WHEN "attempts" = 2
          THEN statement_timestamp() + (${SYNC_JOB_RETRY_DELAYS_MS[1]} * INTERVAL '1 millisecond')
          ELSE "runAt" END,
        "lockedAt" = NULL, "leaseExpiresAt" = NULL, "lockToken" = NULL,
        "lastError" = ${errorCode}, "updatedAt" = statement_timestamp()
    WHERE "id" = ${owner.id} AND "status" = 'RUNNING' AND "lockToken" = ${owner.lockToken}
      AND "leaseExpiresAt" > statement_timestamp()
    RETURNING *
  `;
  return rows[0] ?? null;
}
