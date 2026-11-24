import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { discoverKey, discoverKeyword, type DiscoverQuery } from './instagram.discover.schemas.js';

const TTL_MS = 86400000;
export function freshDiscoverCache(cache: { fetchedAt: Date } | null, now: Date) {
  if (!cache) return false;
  const age = now.getTime() - cache.fetchedAt.getTime();
  return age >= 0 && age < TTL_MS;
}
export function beginDiscover(
  query: DiscoverQuery,
  userId: string | null,
  client: PrismaClient = getPrismaClient(),
) {
  const key = discoverKey(query);
  const activeKey = `discover:${createHash('sha256').update(key).digest('hex')}`;
  return client.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${activeKey}, 0))`;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      const cache = await tx.discoverCache.findUnique({ where: { key } });
      if (freshDiscoverCache(cache, clock.now)) return { cache, jobId: null, created: false };
      const existing = await tx.instagramSyncJob.findUnique({
        where: { activeKey },
        select: { id: true },
      });
      if (existing) return { cache: null, jobId: existing.id, created: false };
      const job = await tx.instagramSyncJob.create({
        data: {
          type: 'DISCOVER_SEARCH',
          trigger: 'discover',
          userId,
          activeKey,
          payload: { discover: { ...query, key, keyword: discoverKeyword(query) } },
          createdAt: clock.now,
          runAt: clock.now,
        },
      });
      return { cache: null, jobId: job.id, created: true };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10000,
      timeout: 15000,
    },
  );
}
export function readDiscoverProgress(
  key: string,
  jobId: string,
  client: PrismaClient = getPrismaClient(),
) {
  return client.$transaction(
    async (tx) => {
      const job = await tx.instagramSyncJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { status: true, payload: true },
      });
      const cache =
        job.status === 'SUCCEEDED' ? await tx.discoverCache.findUnique({ where: { key } }) : null;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
      return { job, cache: freshDiscoverCache(cache, clock.now) ? cache : null };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 10000,
      timeout: 15000,
    },
  );
}
