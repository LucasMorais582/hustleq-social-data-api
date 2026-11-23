-- Fila persistente autorizada para a VPS. Preserva as sete tabelas existentes.
BEGIN;

-- CreateEnum
CREATE TYPE "InstagramSyncJobType" AS ENUM ('INITIAL_PROFILE_SYNC', 'DAILY_PROFILE_SYNC', 'WATCHED_SYNC', 'POST_REFRESH', 'DISCOVER_SEARCH');

-- CreateEnum
CREATE TYPE "InstagramSyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "InstagramSyncJob" (
    "id" TEXT NOT NULL,
    "type" "InstagramSyncJobType" NOT NULL,
    "status" "InstagramSyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" TEXT NOT NULL,
    "instagramProfileId" TEXT,
    "instagramPostId" TEXT,
    "userId" TEXT,
    "payload" JSONB,
    "activeKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lockToken" TEXT,
    "lastError" TEXT,
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InstagramSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstagramSyncJob_activeKey_key" ON "InstagramSyncJob"("activeKey");

-- CreateIndex
CREATE INDEX "InstagramSyncJob_status_runAt_createdAt_idx" ON "InstagramSyncJob"("status", "runAt", "createdAt");

-- CreateIndex
CREATE INDEX "InstagramSyncJob_status_leaseExpiresAt_idx" ON "InstagramSyncJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "InstagramSyncJob_instagramProfileId_createdAt_idx" ON "InstagramSyncJob"("instagramProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "InstagramSyncJob_instagramPostId_createdAt_idx" ON "InstagramSyncJob"("instagramPostId", "createdAt");

-- AddForeignKey
ALTER TABLE "InstagramSyncJob" ADD CONSTRAINT "InstagramSyncJob_instagramProfileId_fkey" FOREIGN KEY ("instagramProfileId") REFERENCES "InstagramProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramSyncJob" ADD CONSTRAINT "InstagramSyncJob_instagramPostId_fkey" FOREIGN KEY ("instagramPostId") REFERENCES "InstagramPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Checks complementares ao Prisma: estado coerente e contador nao negativo.
ALTER TABLE "InstagramSyncJob"
ADD CONSTRAINT "InstagramSyncJob_attempts_check" CHECK ("attempts" >= 0),
ADD CONSTRAINT "InstagramSyncJob_activeKey_check" CHECK (
  "activeKey" IS NULL OR length(btrim("activeKey")) > 0
),
ADD CONSTRAINT "InstagramSyncJob_state_check" CHECK (
  ("status" = 'PENDING' AND "activeKey" IS NOT NULL
    AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL
    AND "lockToken" IS NULL AND "finishedAt" IS NULL)
  OR
  ("status" = 'RUNNING' AND "activeKey" IS NOT NULL
    AND "lockedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL
    AND "leaseExpiresAt" > "lockedAt"
    AND "lockToken" IS NOT NULL AND length(btrim("lockToken")) > 0
    AND "finishedAt" IS NULL)
  OR
  ("status" IN ('SUCCEEDED', 'FAILED') AND "activeKey" IS NULL
    AND "lockedAt" IS NULL AND "leaseExpiresAt" IS NULL
    AND "lockToken" IS NULL AND "finishedAt" IS NOT NULL)
),
ADD CONSTRAINT "InstagramSyncJob_target_check" CHECK (
  ("type" IN ('INITIAL_PROFILE_SYNC', 'DAILY_PROFILE_SYNC', 'WATCHED_SYNC')
    AND "instagramProfileId" IS NOT NULL AND "instagramPostId" IS NULL)
  OR ("type" = 'POST_REFRESH' AND "instagramPostId" IS NOT NULL)
  OR ("type" = 'DISCOVER_SEARCH'
    AND "instagramProfileId" IS NULL AND "instagramPostId" IS NULL)
);

COMMIT;
