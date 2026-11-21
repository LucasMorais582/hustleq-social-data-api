import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';

export interface ProfileInternalStore {
  find(profileId: string): Promise<{ id: string; ownerUserId: string | null } | null>;
  assignOwner(profileId: string, userId: string): Promise<void>;
  clearReservation(profileId: string): Promise<void>;
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
            },
            clearReservation: async (id) => {
              await tx.instagramProfile.update({
                where: { id },
                data: { reservedForInviteId: null, reservedUntil: null },
                select: { id: true },
              });
            },
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
