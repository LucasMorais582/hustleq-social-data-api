import { Prisma, type PrismaClient } from '@prisma/client';
import { assertProfileReadAccess } from '../../../auth/instagram-access.js';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { storedDateFilter, type ReadRange } from '../shared/instagram.read.schemas.js';
import type { ProfilePostsQuery } from './instagram.profile.read.schemas.js';

const profileSnapshotSelect = {
  followers: true,
  following: true,
  postsCount: true,
  collectedAt: true,
} satisfies Prisma.InstagramProfileSnapshotSelect;
const profileSelect = {
  id: true,
  instagramId: true,
  username: true,
  name: true,
  url: true,
  bio: true,
  profilePhoto: true,
  category: true,
  isVerified: true,
  syncStatus: true,
  lastSyncedAt: true,
  snapshots: { orderBy: { collectedAt: 'desc' }, take: 1, select: profileSnapshotSelect },
} satisfies Prisma.InstagramProfileSelect;
export const postSelect = {
  id: true,
  instagramPostId: true,
  url: true,
  type: true,
  caption: true,
  hashtags: true,
  displayUrl: true,
  images: true,
  timestamp: true,
  ownerUsername: true,
  metricSnapshots: {
    orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: {
      likesCount: true,
      likesHidden: true,
      commentsCount: true,
      viewsCount: true,
      collectedAt: true,
    },
  },
} satisfies Prisma.InstagramPostSelect;
export type StoredProfileRead = Prisma.InstagramProfileGetPayload<{ select: typeof profileSelect }>;
export type StoredPostRead = Prisma.InstagramPostGetPayload<{ select: typeof postSelect }>;

async function authorizedRead<T>(
  profileId: string,
  userId: string,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient,
) {
  // Autoriza, conta e lê na mesma visão do banco, sem writes nem chamadas externas.
  return client.$transaction(
    async (tx) => {
      await assertProfileReadAccess(profileId, userId, tx);
      return read(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 10000,
      timeout: 15000,
    },
  );
}

export function readStoredInstagramProfile(
  profileId: string,
  userId: string,
  client = getPrismaClient(),
) {
  return authorizedRead(
    profileId,
    userId,
    (tx) => tx.instagramProfile.findUnique({ where: { id: profileId }, select: profileSelect }),
    client,
  );
}
export function readStoredInstagramPosts(
  profileId: string,
  userId: string,
  query: ProfilePostsQuery,
  client = getPrismaClient(),
) {
  const typeMap = { IMAGE: 'photo', CAROUSEL: 'carousel', REEL: 'reel' } as const;
  const where: Prisma.InstagramPostWhereInput = {
    instagramProfileId: profileId,
    ...(query.type ? { type: typeMap[query.type] } : {}),
    ...(query.from || query.to ? { timestamp: storedDateFilter(query) } : {}),
  };
  return authorizedRead(
    profileId,
    userId,
    async (tx) => {
      const [total, posts] = await Promise.all([
        tx.instagramPost.count({ where }),
        tx.instagramPost.findMany({
          where,
          select: postSelect,
          orderBy: [{ timestamp: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);
      return { total, posts };
    },
    client,
  );
}
export function readStoredInstagramProfileSnapshots(
  profileId: string,
  userId: string,
  range: ReadRange,
  client = getPrismaClient(),
) {
  return authorizedRead(
    profileId,
    userId,
    (tx) =>
      tx.instagramProfileSnapshot.findMany({
        where: {
          instagramProfileId: profileId,
          ...(range.from || range.to ? { collectedAt: storedDateFilter(range) } : {}),
        },
        select: profileSnapshotSelect,
        orderBy: { collectedAt: 'asc' },
      }),
    client,
  );
}
