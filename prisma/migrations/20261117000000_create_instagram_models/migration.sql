-- Criação inicial das entidades Instagram; sem exclusão de tabelas ou dados.
BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "InstagramMediaType" AS ENUM ('photo', 'carousel', 'reel');

-- CreateTable
CREATE TABLE "InstagramProfile" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "instagramId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT,
    "url" TEXT,
    "bio" TEXT,
    "profilePhoto" TEXT,
    "category" TEXT,
    "isVerified" BOOLEAN,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InstagramProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramProfileSnapshot" (
    "id" TEXT NOT NULL,
    "instagramProfileId" TEXT NOT NULL,
    "followers" INTEGER,
    "following" INTEGER,
    "postsCount" INTEGER,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstagramProfileSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramCompetitor" (
    "id" TEXT NOT NULL,
    "instagramProfileId" TEXT NOT NULL,
    "competitorProfileId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InstagramCompetitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramPost" (
    "id" TEXT NOT NULL,
    "instagramProfileId" TEXT NOT NULL,
    "instagramPostId" TEXT NOT NULL,
    "url" TEXT,
    "type" "InstagramMediaType" NOT NULL,
    "caption" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "displayUrl" TEXT,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timestamp" TIMESTAMPTZ(3),
    "ownerUsername" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InstagramPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramPostMetricSnapshot" (
    "id" TEXT NOT NULL,
    "instagramPostId" TEXT NOT NULL,
    "likesCount" INTEGER,
    "commentsCount" INTEGER,
    "viewsCount" BIGINT,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstagramPostMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstagramProfile_instagramId_key" ON "InstagramProfile"("instagramId");

-- CreateIndex
CREATE INDEX "InstagramProfile_ownerUserId_idx" ON "InstagramProfile"("ownerUserId");

-- CreateIndex
CREATE INDEX "InstagramProfile_username_idx" ON "InstagramProfile"("username");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramProfileSnapshot_instagramProfileId_collectedAt_key" ON "InstagramProfileSnapshot"("instagramProfileId", "collectedAt");

-- CreateIndex
CREATE INDEX "InstagramCompetitor_instagramProfileId_endedAt_idx" ON "InstagramCompetitor"("instagramProfileId", "endedAt");

-- CreateIndex
CREATE INDEX "InstagramCompetitor_competitorProfileId_idx" ON "InstagramCompetitor"("competitorProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramPost_instagramPostId_key" ON "InstagramPost"("instagramPostId");

-- CreateIndex
CREATE INDEX "InstagramPost_instagramProfileId_timestamp_idx" ON "InstagramPost"("instagramProfileId", "timestamp");

-- CreateIndex
CREATE INDEX "InstagramPostMetricSnapshot_instagramPostId_collectedAt_idx" ON "InstagramPostMetricSnapshot"("instagramPostId", "collectedAt");

-- AddForeignKey
ALTER TABLE "InstagramProfileSnapshot" ADD CONSTRAINT "InstagramProfileSnapshot_instagramProfileId_fkey" FOREIGN KEY ("instagramProfileId") REFERENCES "InstagramProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramCompetitor" ADD CONSTRAINT "InstagramCompetitor_instagramProfileId_fkey" FOREIGN KEY ("instagramProfileId") REFERENCES "InstagramProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramCompetitor" ADD CONSTRAINT "InstagramCompetitor_competitorProfileId_fkey" FOREIGN KEY ("competitorProfileId") REFERENCES "InstagramProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramPost" ADD CONSTRAINT "InstagramPost_instagramProfileId_fkey" FOREIGN KEY ("instagramProfileId") REFERENCES "InstagramProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramPostMetricSnapshot" ADD CONSTRAINT "InstagramPostMetricSnapshot_instagramPostId_fkey" FOREIGN KEY ("instagramPostId") REFERENCES "InstagramPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
