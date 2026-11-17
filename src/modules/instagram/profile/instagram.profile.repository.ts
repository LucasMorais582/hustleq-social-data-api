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
    commentsCount: number | null;
    viewsCount: bigint | null;
  }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
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
          const { followers, following, postsCount, ...identity } = collection.profile;
          const profile = await tx.instagramProfile.upsert({
            where: { instagramId: identity.instagramId },
            create: identity,
            update: identity,
          });
          const latestSnapshot = await tx.instagramProfileSnapshot.findFirst({
            where: { instagramProfileId: profile.id },
            orderBy: { collectedAt: 'desc' },
          });
          if (
            !latestSnapshot ||
            collection.collectedAt.getTime() - latestSnapshot.collectedAt.getTime() >= DAY_MS
          ) {
            await tx.instagramProfileSnapshot.create({
              data: {
                instagramProfileId: profile.id,
                followers,
                following,
                postsCount,
                collectedAt: collection.collectedAt,
              },
            });
          }

          for (const post of collection.posts) {
            const { likesCount, commentsCount, viewsCount, ...content } = post;
            const existing = await tx.instagramPost.findUnique({
              where: { instagramPostId: post.instagramPostId },
            });
            if (existing && existing.instagramProfileId !== profile.id) {
              // Nunca mover silenciosamente uma publicação de autor.
              throw new Error('A publicação já está vinculada a outro perfil');
            }
            const savedPost = await tx.instagramPost.upsert({
              where: { instagramPostId: post.instagramPostId },
              create: { ...content, instagramProfileId: profile.id },
              update: content,
            });
            if (!existing) {
              await tx.instagramPostMetricSnapshot.create({
                data: {
                  instagramPostId: savedPost.id,
                  likesCount,
                  commentsCount,
                  viewsCount,
                  collectedAt: collection.collectedAt,
                },
              });
            }
          }
          return { instagramProfileId: profile.id };
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
