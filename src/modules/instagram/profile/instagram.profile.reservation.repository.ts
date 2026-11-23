import { Prisma, type PrismaClient } from '@prisma/client';
import { ApiError } from '../../../errors/api.error.js';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { enqueueInstagramSyncJob } from '../jobs/instagram.sync-job.repository.js';
import type { ProfileCollection } from './instagram.profile.repository.js';

type ProfileIdentity = Omit<ProfileCollection['profile'], 'followers' | 'following' | 'postsCount'>;
export interface VerifiedProfileReservation {
  identity: ProfileIdentity;
  inviteId: string;
  reservedUntil: Date;
  providerRunId: string;
}

export async function reserveVerifiedInstagramProfile(
  input: VerifiedProfileReservation,
  client: PrismaClient = getPrismaClient(),
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (!clock || input.reservedUntil <= clock.now) {
            throw new ApiError(400, 'INVALID_REQUEST', 'reservedUntil deve ser uma data futura');
          }
          const existing = await tx.instagramProfile.findUnique({
            where: { instagramId: input.identity.instagramId },
          });
          if (existing && existing.ownerUserId !== null) {
            throw new ApiError(409, 'PROFILE_ALREADY_OWNED', 'O perfil já possui proprietário');
          }
          if (
            existing?.reservedForInviteId &&
            existing.reservedForInviteId !== input.inviteId &&
            existing.reservedUntil &&
            existing.reservedUntil > clock.now
          ) {
            throw new ApiError(
              409,
              'PROFILE_RESERVED',
              'O perfil está reservado para outro convite',
            );
          }
          const profile = await tx.instagramProfile.upsert({
            where: { instagramId: input.identity.instagramId },
            create: {
              ...input.identity,
              reservedForInviteId: input.inviteId,
              reservedUntil: input.reservedUntil,
            },
            update: {
              ...input.identity,
              reservedForInviteId: input.inviteId,
              reservedUntil: input.reservedUntil,
            },
          });
          const linked = await tx.providerRun.updateMany({
            where: {
              id: input.providerRunId,
              actor: 'apify/instagram-profile-scraper',
              status: 'succeeded',
              apifyRunId: { not: null },
              OR: [{ instagramProfileId: null }, { instagramProfileId: profile.id }],
            },
            data: { instagramProfileId: profile.id },
          });
          if (linked.count !== 1) throw new Error('VERIFIED_PROFILE_RUN_NOT_FOUND');
          const age = profile.lastSyncedAt
            ? clock.now.getTime() - profile.lastSyncedAt.getTime()
            : Infinity;
          const fresh = profile.syncStatus === 'ready' && age >= 0 && age < 86400000;
          const activeKey = `profile:${profile.id}`;
          const activeJob = await tx.instagramSyncJob.findUnique({ where: { activeKey } });
          if (!fresh || activeJob) {
            if (!activeJob) {
              await enqueueInstagramSyncJob(
                {
                  type: 'INITIAL_PROFILE_SYNC',
                  trigger: 'initial',
                  instagramProfileId: profile.id,
                  activeKey,
                  payload: {
                    providerSteps: { profile: [input.providerRunId] },
                    providerAttempts: { [input.providerRunId]: 1 },
                  },
                },
                tx,
              );
            }
            await tx.instagramProfile.update({
              where: { id: profile.id },
              data: { syncStatus: 'syncing' },
            });
            return {
              profileId: profile.id,
              username: profile.username,
              status: 'syncing' as const,
            };
          }
          return { profileId: profile.id, username: profile.username, status: 'ready' as const };
        },
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
