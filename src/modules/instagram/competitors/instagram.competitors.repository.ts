import { Prisma, type InstagramCompetitor, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { ApiError } from '../../../errors/api.error.js';
import { findActiveProfileSyncJob } from '../jobs/instagram.profile-job.repository.js';
import { enqueueInstagramSyncJob } from '../jobs/instagram.sync-job.repository.js';

import type { CompetitorIdentity } from './instagram.competitors.schemas.js';

export type CompetitorStatus = 'active' | 'ended' | 'all';
export interface CompetitorStore {
  requireOwner(profileId: string, userId: string): Promise<void>;
  scheduleInitial(profileId: string, providerRunId: string, userId: string): Promise<void>;
  profileExists(id: string): Promise<boolean>;
  profileInstagramId(id: string): Promise<string | null>;
  saveIdentity(profile: CompetitorIdentity): Promise<string>;
  activeExists(profileId: string, competitorId: string): Promise<boolean>;
  countActive(profileId: string): Promise<number>;
  create(profileId: string, competitorId: string): Promise<InstagramCompetitor>;
  find(profileId: string, relationId: string): Promise<InstagramCompetitor | null>;
  end(relationId: string, endedAt: Date): Promise<InstagramCompetitor>;
  list(
    profileId: string,
    status: CompetitorStatus,
    skip: number,
    take: number,
  ): Promise<InstagramCompetitor[]>;
}

export async function withCompetitorTransaction<T>(
  work: (store: CompetitorStore) => Promise<T>,
  client: PrismaClient = getPrismaClient(),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.$transaction(
        async (tx) =>
          work({
            requireOwner: async (id, userId) => {
              const profile = await tx.instagramProfile.findUnique({
                where: { id },
                select: { ownerUserId: true },
              });
              if (!profile) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
              if (profile.ownerUserId !== userId)
                throw new ApiError(
                  403,
                  'FORBIDDEN',
                  'Somente o dono pode gerenciar contas acompanhadas',
                );
            },
            scheduleInitial: async (profileId, providerRunId, userId) => {
              const linked = await tx.providerRun.updateMany({
                where: {
                  id: providerRunId,
                  actor: 'apify/instagram-profile-scraper',
                  status: 'succeeded',
                  apifyRunId: { not: null },
                  OR: [{ instagramProfileId: null }, { instagramProfileId: profileId }],
                },
                data: { instagramProfileId: profileId },
              });
              if (linked.count !== 1) throw new Error('VERIFIED_PROFILE_RUN_NOT_FOUND');
              const activeSync = await findActiveProfileSyncJob(profileId, tx);
              // Daily preserva o último status no erro; não transformá-lo em Initial/syncing.
              if (activeSync?.type === 'DAILY_PROFILE_SYNC') return;
              if (!activeSync)
                await enqueueInstagramSyncJob(
                  {
                    type: 'INITIAL_PROFILE_SYNC',
                    trigger: 'initial',
                    instagramProfileId: profileId,
                    userId,
                    activeKey: `profile:${profileId}`,
                    payload: {
                      providerSteps: { profile: [providerRunId] },
                      providerAttempts: { [providerRunId]: 1 },
                    },
                  },
                  tx,
                );
              await tx.instagramProfile.update({
                where: { id: profileId },
                data: { syncStatus: 'syncing' },
              });
            },
            profileExists: async (id) =>
              Boolean(
                await tx.instagramProfile.findUnique({ where: { id }, select: { id: true } }),
              ),
            profileInstagramId: async (id) =>
              (
                await tx.instagramProfile.findUnique({
                  where: { id },
                  select: { instagramId: true },
                })
              )?.instagramId ?? null,
            saveIdentity: async (profile) => {
              const saved = await tx.instagramProfile.upsert({
                where: { instagramId: profile.instagramId },
                create: profile,
                update: profile,
                select: { id: true },
              });
              return saved.id;
            },
            activeExists: async (instagramProfileId, competitorProfileId) =>
              Boolean(
                await tx.instagramCompetitor.findFirst({
                  where: { instagramProfileId, competitorProfileId, endedAt: null },
                  select: { id: true },
                }),
              ),
            countActive: (instagramProfileId) =>
              tx.instagramCompetitor.count({ where: { instagramProfileId, endedAt: null } }),
            create: (instagramProfileId, competitorProfileId) =>
              tx.instagramCompetitor.create({ data: { instagramProfileId, competitorProfileId } }),
            find: (instagramProfileId, id) =>
              tx.instagramCompetitor.findFirst({ where: { id, instagramProfileId } }),
            end: (id, endedAt) =>
              tx.instagramCompetitor.update({ where: { id }, data: { endedAt } }),
            list: (instagramProfileId, status, skip, take) =>
              tx.instagramCompetitor.findMany({
                where: {
                  instagramProfileId,
                  ...(status === 'all'
                    ? {}
                    : { endedAt: status === 'active' ? null : { not: null } }),
                },
                include: {
                  competitorProfile: {
                    select: {
                      id: true,
                      instagramId: true,
                      username: true,
                      name: true,
                      bio: true,
                      profilePhoto: true,
                      url: true,
                      category: true,
                      isVerified: true,
                    },
                  },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip,
                take,
              }),
          }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 15000,
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
