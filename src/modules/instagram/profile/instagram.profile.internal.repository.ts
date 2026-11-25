import { removeProfileOwnerInTransaction } from './instagram.profile.owner-removal.repository.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';

const monitoringProfileSelect = {
  id: true,
  instagramId: true,
  username: true,
  name: true,
  url: true,
  bio: true,
  profilePhoto: true,
  category: true,
  isVerified: true,
  monitoringUntil: true,
  syncStatus: true,
  lastSyncedAt: true,
} satisfies Prisma.InstagramProfileSelect;
type MonitoringProfile = Prisma.InstagramProfileGetPayload<{
  select: typeof monitoringProfileSelect;
}>;

export interface ProfileInternalStore {
  find(profileId: string): Promise<{ id: string; ownerUserId: string | null } | null>;
  assignOwner(profileId: string, userId: string): Promise<void>;
  clearReservation(profileId: string): Promise<void>;
  removeOwner(profileId: string): Promise<void>;
  updateMonitoring(profileId: string, monitoringUntil: Date | null): Promise<MonitoringProfile>;
}
export async function withProfileInternalTransaction<T>(
  work: (store: ProfileInternalStore) => Promise<T>,
  client: PrismaClient = getPrismaClient(),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.$transaction(
        async (tx) =>
          work({
            find: (id) =>
              tx.instagramProfile.findUnique({
                where: { id },
                select: { id: true, ownerUserId: true },
              }),
            assignOwner: async (id, ownerUserId) => {
              await tx.instagramProfile.update({
                where: { id },
                data: { ownerUserId, reservedForInviteId: null, reservedUntil: null },
                select: { id: true },
              });
              await tx.providerRun.updateMany({
                where: { instagramProfileId: id, trigger: 'initial', userId: null },
                data: { userId: ownerUserId },
              });
            },
            removeOwner: (id) => removeProfileOwnerInTransaction(id, tx),
            clearReservation: async (id) => {
              await tx.instagramProfile.update({
                where: { id },
                data: { reservedForInviteId: null, reservedUntil: null },
                select: { id: true },
              });
            },
            updateMonitoring: (id, monitoringUntil) =>
              tx.instagramProfile.update({
                where: { id },
                data: { monitoringUntil },
                select: monitoringProfileSelect,
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
        error.code === 'P2034' &&
        attempt < 3
      )
        continue;
      throw error;
    }
  }
}
