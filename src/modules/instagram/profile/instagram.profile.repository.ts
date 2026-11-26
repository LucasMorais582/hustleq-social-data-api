import {
  getInstagramLocalDate,
  hasProfileSnapshotOnDate,
} from '../shared/instagram.snapshot-day.js';
import { Prisma } from '@prisma/client';
import type { InstagramMediaType, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';

interface CollectedProfile {
  instagramId: string;
  username: string;
  name: string | null;
  url: string | null;
  bio: string | null;
  profilePhoto: string | null;
  category: string | null;
  isVerified: boolean | null;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
}

export interface ProfileCollection {
  profile: CollectedProfile;
  collectedAt: Date;
  refreshMetricsSince?: Date;
  metricSource?: 'initial' | 'daily';
  profileSnapshotMinIntervalHours?: 20 | 24;
  profileSnapshotCadence?: 'new-york-day';
  refreshRecentPostsLimit?: 10 | 12;
  refreshAllCollectedPosts?: boolean;
  posts: {
    instagramPostId: string;
    type: InstagramMediaType;
    url: string | null;
    caption: string | null;
    hashtags: string[];
    displayUrl: string | null;
    images: string[];
    timestamp: Date | null;
    ownerUsername: string | null;
    likesCount: number | null;
    likesHidden: boolean;
    commentsCount: number | null;
    viewsCount: bigint | null;
  }[];
}

const MAX_ATTEMPTS = 3;

export async function saveProfileCollection(
  collection: ProfileCollection,
  client: PrismaClient = getPrismaClient(),
) {
  // Serializable + retry protege o intervalo e a primeira descoberta em chamadas concorrentes.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          return saveProfileCollectionInTransaction(collection, tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 30000,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2034', 'P2002'].includes(error.code) &&
        attempt < MAX_ATTEMPTS
      )
        continue;
      throw error;
    }
  }
  throw new Error('Não foi possível concluir a persistência');
}

// O worker chama esta versao na mesma transacao que valida sua posse e conclui o job.
export async function saveProfileCollectionInTransaction(
  collection: ProfileCollection,
  tx: Prisma.TransactionClient,
) {
  const { followers, following, postsCount, ...identity } = collection.profile;
  const profile = await tx.instagramProfile.upsert({
    where: { instagramId: identity.instagramId },
    create: identity,
    update: identity,
  });
  let shouldCreate: boolean;
  if (collection.profileSnapshotCadence === 'new-york-day') {
    shouldCreate = !(await hasProfileSnapshotOnDate(
      profile.id,
      getInstagramLocalDate(collection.collectedAt),
      tx,
    ));
  } else {
    const latestSnapshot = await tx.instagramProfileSnapshot.findFirst({
      where: { instagramProfileId: profile.id },
      orderBy: { collectedAt: 'desc' },
    });
    shouldCreate =
      !latestSnapshot ||
      collection.collectedAt.getTime() - latestSnapshot.collectedAt.getTime() >=
        (collection.profileSnapshotMinIntervalHours ?? 24) * 3600000;
  }
  if (shouldCreate) {
    await tx.instagramProfileSnapshot.create({
      data: {
        instagramProfileId: profile.id,
        followers,
        following,
        postsCount,
        source: collection.metricSource ?? null,
        collectedAt: collection.collectedAt,
      },
    });
  }

  for (const post of collection.posts) {
    const { likesCount, likesHidden, commentsCount, viewsCount, ...content } = post;
    const existing = await tx.instagramPost.findUnique({
      where: { instagramPostId: post.instagramPostId },
    });
    if (existing && existing.instagramProfileId !== profile.id) {
      // Nunca mover silenciosamente uma publicação de autor.
      throw new Error('A publicação já está vinculada a outro perfil');
    }
    const savedPost = await tx.instagramPost.upsert({
      where: { instagramPostId: post.instagramPostId },
      create: {
        ...content,
        instagramProfileId: profile.id,
        lastCollectedAt: collection.collectedAt,
      },
      update: content,
    });
    const latestMetric =
      existing && collection.refreshAllCollectedPosts
        ? await tx.instagramPostMetricSnapshot.findFirst({
            where: { instagramPostId: savedPost.id },
            orderBy: { collectedAt: 'desc' },
          })
        : null;
    if (
      !existing ||
      (collection.refreshAllCollectedPosts &&
        (!latestMetric || latestMetric.collectedAt < collection.collectedAt))
    ) {
      await tx.instagramPostMetricSnapshot.create({
        data: {
          instagramPostId: savedPost.id,
          source: collection.metricSource ?? (collection.refreshMetricsSince ? 'daily' : 'initial'),
          likesCount,
          likesHidden,
          commentsCount,
          viewsCount,
          collectedAt: collection.collectedAt,
        },
      });
      if (existing) {
        await tx.instagramPost.update({
          where: { id: savedPost.id },
          data: { lastCollectedAt: collection.collectedAt },
        });
      }
    }
  }
  if (collection.refreshMetricsSince && !collection.refreshAllCollectedPosts) {
    const latestPosts = await tx.instagramPost.findMany({
      where: { instagramProfileId: profile.id, timestamp: { not: null } },
      orderBy: [{ timestamp: 'desc' }, { id: 'asc' }],
      take: collection.refreshRecentPostsLimit ?? 10,
      select: { id: true, instagramPostId: true },
    });
    const collected = new Map(collection.posts.map((post) => [post.instagramPostId, post]));
    for (const post of latestPosts) {
      const metrics = collected.get(post.instagramPostId);
      if (!metrics) continue; // Não transformar métricas antigas em uma coleta nova.
      const latest = await tx.instagramPostMetricSnapshot.findFirst({
        where: { instagramPostId: post.id },
        orderBy: { collectedAt: 'desc' },
      });
      if (latest && latest.collectedAt >= collection.refreshMetricsSince) continue;
      await tx.instagramPostMetricSnapshot.create({
        data: {
          instagramPostId: post.id,
          source: collection.metricSource ?? 'daily',
          likesCount: metrics.likesCount,
          likesHidden: metrics.likesHidden,
          commentsCount: metrics.commentsCount,
          viewsCount: metrics.viewsCount,
          collectedAt: collection.collectedAt,
        },
      });
      await tx.instagramPost.update({
        where: { id: post.id },
        data: { lastCollectedAt: collection.collectedAt },
      });
    }
  }
  return { instagramProfileId: profile.id };
}
