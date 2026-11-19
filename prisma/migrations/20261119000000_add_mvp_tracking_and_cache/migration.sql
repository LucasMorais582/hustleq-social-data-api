-- Extensão aditiva para MVP: preserva IDs, registros e snapshots legados.
-- source e timestamps novos ficam NULL nos registros existentes, sem backfill inventado.
BEGIN;

-- AlterTable
ALTER TABLE "InstagramProfile" ADD COLUMN     "lastSyncedAt" TIMESTAMPTZ(3),
ADD COLUMN     "monitoringUntil" TIMESTAMPTZ(3),
ADD COLUMN     "reservedForInviteId" TEXT,
ADD COLUMN     "reservedUntil" TIMESTAMPTZ(3),
ADD COLUMN     "syncStatus" TEXT NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "InstagramPost" ADD COLUMN     "lastCollectedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "InstagramPostMetricSnapshot" ADD COLUMN     "likesHidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "DiscoverCache" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "niche" TEXT,
    "city" TEXT,
    "query" TEXT,
    "results" JSONB NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoverCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderRun" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "apifyRunId" TEXT,
    "trigger" TEXT NOT NULL,
    "instagramProfileId" TEXT,
    "instagramPostId" TEXT,
    "userId" TEXT,
    "items" INTEGER,
    "costUsd" DECIMAL(10,6),
    "status" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ProviderRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscoverCache_key_key" ON "DiscoverCache"("key");

-- CreateIndex
CREATE INDEX "ProviderRun_userId_startedAt_idx" ON "ProviderRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "ProviderRun_instagramPostId_status_idx" ON "ProviderRun"("instagramPostId", "status");

-- CreateIndex
CREATE INDEX "ProviderRun_instagramProfileId_status_idx" ON "ProviderRun"("instagramProfileId", "status");

COMMIT;
