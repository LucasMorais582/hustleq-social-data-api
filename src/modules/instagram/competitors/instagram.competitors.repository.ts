import { Prisma, type InstagramCompetitor, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';

import type { CompetitorIdentity } from './instagram.competitors.schemas.js';

export type CompetitorStatus = 'active' | 'ended' | 'all';
export interface CompetitorStore {
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
