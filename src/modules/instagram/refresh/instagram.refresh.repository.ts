import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';

export function findProfilesForInstagramRefresh(
  now: Date,
  client: Pick<PrismaClient, 'instagramProfile'> = getPrismaClient(),
) {
  return client.instagramProfile.findMany({
    where: {
      ownerUserId: { not: null },
      OR: [{ monitoringUntil: null }, { monitoringUntil: { gt: now } }],
    },
    orderBy: { id: 'asc' },
    select: { id: true, ownerUserId: true },
  });
}
