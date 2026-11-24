import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { assertProfileReadAccess } from '../../../auth/instagram-access.js';
import { ApiError } from '../../../errors/api.error.js';
import { postSelect } from '../profile/instagram.profile.read.repository.js';
import { serializeStoredInstagramPost } from '../profile/instagram.profile.read.service.js';

export function canonicalPostUrl(url: string | null, type: string) {
  if (!url)
    throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'O post salvo não possui URL para atualização');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'A URL do post salvo não permite atualização');
  }
  const path = parsed.pathname.match(/^\/(p|reel)\/([a-zA-Z0-9_-]+)\/?$/);
  if (parsed.protocol !== 'https:' || !/^(www\.)?instagram\.com$/.test(parsed.hostname) || !path)
    throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'A URL do post salvo não permite atualização');
  return `https://www.instagram.com/${type === 'reel' ? 'reel' : 'p'}/${path[2]}/`;
}

export async function requestStoredPostRefresh(
  postId: string,
  userId: string,
  trigger: 'on_open' | 'refresh',
  limit: number,
  client: PrismaClient = getPrismaClient(),
) {
  return client.$transaction(
    async (tx) => {
      // Serializa a cota do usuário entre posts diferentes e o enqueue do mesmo post.
      if (trigger === 'refresh')
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`manual-refresh:${userId}`}, 0))`;
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "InstagramPost" WHERE "id" = ${postId} FOR UPDATE`;
      if (!locked[0]) throw new ApiError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');
      const post = await tx.instagramPost.findUniqueOrThrow({
        where: { id: postId },
        select: { ...postSelect, instagramProfileId: true, lastCollectedAt: true },
      });
      await assertProfileReadAccess(post.instagramProfileId, userId, tx);
      const publicPost = serializeStoredInstagramPost(post);
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      const activeKey = `post:${postId}`;
      const activeJob = await tx.instagramSyncJob.findUnique({ where: { activeKey } });
      const activeRun = await tx.providerRun.findFirst({
        where: {
          instagramPostId: postId,
          status: 'running',
          startedAt: { gt: new Date(clock.now.getTime() - 600000) },
        },
        select: { id: true },
      });
      if (activeJob || activeRun) return { refreshing: true, post: publicPost };
      const age = post.lastCollectedAt
        ? clock.now.getTime() - post.lastCollectedAt.getTime()
        : Infinity;
      if (trigger === 'on_open' && age >= 0 && age < 86400000)
        return { refreshing: false, post: publicPost };
      canonicalPostUrl(post.url, post.type);
      if (trigger === 'refresh') {
        const start = new Date(clock.now);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        const count = await tx.instagramSyncJob.count({
          where: {
            type: 'POST_REFRESH',
            trigger: 'refresh',
            userId,
            createdAt: { gte: start, lt: end },
          },
        });
        if (count >= limit)
          throw new ApiError(
            429,
            'MANUAL_REFRESH_LIMIT_REACHED',
            'Limite diário de atualizações manuais atingido',
          );
      }
      await tx.instagramSyncJob.create({
        data: {
          type: 'POST_REFRESH',
          trigger,
          userId,
          instagramPostId: postId,
          instagramProfileId: post.instagramProfileId,
          activeKey,
          createdAt: clock.now,
          runAt: clock.now,
        },
      });
      return { refreshing: true, post: publicPost };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10000,
      timeout: 15000,
    },
  );
}
