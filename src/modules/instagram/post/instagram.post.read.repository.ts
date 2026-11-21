import { Prisma } from '@prisma/client';
import { assertProfileReadAccess } from '../../../auth/instagram-access.js';
import { ApiError } from '../../../errors/api.error.js';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { storedDateFilter, type ReadRange } from '../shared/instagram.read.schemas.js';

export function readStoredInstagramPostMetrics(
  postId: string,
  userId: string,
  range: ReadRange,
  client = getPrismaClient(),
) {
  return client.$transaction(
    async (tx) => {
      const post = await tx.instagramPost.findUnique({
        where: { id: postId },
        select: { instagramProfileId: true, type: true },
      });
      if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');
      await assertProfileReadAccess(post.instagramProfileId, userId, tx);
      const metrics = await tx.instagramPostMetricSnapshot.findMany({
        where: {
          instagramPostId: postId,
          ...(range.from || range.to ? { collectedAt: storedDateFilter(range) } : {}),
        },
        select: {
          likesCount: true,
          likesHidden: true,
          commentsCount: true,
          viewsCount: true,
          collectedAt: true,
          source: true,
        },
        orderBy: [{ collectedAt: 'asc' }, { id: 'asc' }],
      });
      return { type: post.type, metrics };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 10000,
      timeout: 15000,
    },
  );
}
