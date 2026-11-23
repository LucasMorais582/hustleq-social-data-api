import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import type { ProfileOwnershipStatus } from './instagram.profile.search.schemas.js';

export function readInstagramProfileOwnership(
  instagramId: string,
  userId: string,
  client: PrismaClient = getPrismaClient(),
): Promise<ProfileOwnershipStatus> {
  return client.$transaction(
    async (tx) => {
      const profile = await tx.instagramProfile.findUnique({
        where: { instagramId },
        select: { ownerUserId: true, reservedForInviteId: true, reservedUntil: true },
      });
      // Ausencia no nosso banco nao significa ausencia no Instagram.
      if (!profile) return 'available';
      if (profile.ownerUserId !== null)
        return profile.ownerUserId === userId ? 'owned_by_me' : 'owned_by_other';
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      return profile.reservedForInviteId &&
        profile.reservedUntil &&
        profile.reservedUntil > clock.now
        ? 'reserved'
        : 'available';
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 1000,
      timeout: 3000,
    },
  );
}
