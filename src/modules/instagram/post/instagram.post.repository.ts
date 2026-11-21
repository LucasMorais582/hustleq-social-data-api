import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import type { ProfileCollection } from '../profile/instagram.profile.repository.js';

export interface PostCollection {
  collectedAt: Date;
  posts: (ProfileCollection['posts'][number] & { ownerInstagramId: string })[];
}

export async function savePostCollection(
  collection: PostCollection,
  client: PrismaClient = getPrismaClient(),
) {
  if (collection.posts.length === 0) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.$transaction(
        async (tx) => {
          const profiles = await tx.instagramProfile.findMany({
            where: {
              instagramId: {
                in: [...new Set(collection.posts.map((post) => post.ownerInstagramId))],
              },
            },
            select: { id: true, instagramId: true },
          });
          const profileIds = new Map(profiles.map((profile) => [profile.instagramId, profile.id]));
          const seenPosts = new Map<string, string>();
          // Ordem estável reduz disputas entre coletas concorrentes.
          for (const post of [...collection.posts].sort((a, b) =>
            a.instagramPostId.localeCompare(b.instagramPostId),
          )) {
            const {
              ownerInstagramId,
              likesCount,
              likesHidden,
              commentsCount,
              viewsCount,
              ...content
            } = post;
            const instagramProfileId = profileIds.get(ownerInstagramId);
            if (!instagramProfileId) continue;
            const seenOwner = seenPosts.get(post.instagramPostId);
            if (seenOwner && seenOwner !== ownerInstagramId) {
              throw new Error('A mesma publicação foi recebida com autores diferentes');
            }
            if (seenOwner) continue;
            seenPosts.set(post.instagramPostId, ownerInstagramId);
            const existing = await tx.instagramPost.findUnique({
              where: { instagramPostId: post.instagramPostId },
            });
            if (existing && existing.instagramProfileId !== instagramProfileId) {
              throw new Error('A publicação já está vinculada a outro perfil');
            }
            const saved = await tx.instagramPost.upsert({
              where: { instagramPostId: post.instagramPostId },
              create: { ...content, instagramProfileId, lastCollectedAt: collection.collectedAt },
              update: content,
            });
            if (!existing) {
              await tx.instagramPostMetricSnapshot.create({
                data: {
                  instagramPostId: saved.id,
                  source: 'initial',
                  likesCount,
                  likesHidden,
                  commentsCount,
                  viewsCount,
                  collectedAt: collection.collectedAt,
                },
              });
            }
          }
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 30000,
        },
      );
      return;
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
