import type { Prisma, PrismaClient } from '@prisma/client';
import { getInstagramLocalDate } from '../refresh/instagram.refresh.schedule.js';
import { watchedMetadataSchema } from './instagram.watched.schemas.js';
import { dailyMetadataSchema } from './instagram.daily.schemas.js';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';

type Client = Pick<PrismaClient, 'instagramCompetitor' | 'instagramSyncJob'>;
export async function findWatchedCandidates(
  now: Date,
  client: Pick<PrismaClient, 'instagramCompetitor'> = getPrismaClient(),
  ids?: string[],
) {
  const relations = await client.instagramCompetitor.findMany({
    where: {
      endedAt: null,
      ...(ids ? { competitorProfileId: { in: ids } } : {}),
      instagramProfile: {
        ownerUserId: { not: null },
        OR: [{ monitoringUntil: null }, { monitoringUntil: { gt: now } }],
      },
    },
    select: {
      competitorProfileId: true,
      instagramProfile: { select: { ownerUserId: true } },
    },
  });
  const users = new Map<string, Set<string>>();
  for (const relation of relations) {
    const user = relation.instagramProfile.ownerUserId;
    if (!user) continue;
    const watchers = users.get(relation.competitorProfileId) ?? new Set<string>();
    watchers.add(user);
    users.set(relation.competitorProfileId, watchers);
  }
  return [...users].map(([id, watchers]) => ({
    id,
    userId: watchers.size === 1 ? [...watchers][0]! : null,
  }));
}

// Apenas uma reserva Daily sem Actor não conta como tentativa efetiva.
export async function wasDailyAttempted(
  profileId: string,
  date: string,
  client: Client,
  now?: Date,
) {
  const dates = [...new Set([date, ...(now ? [getInstagramLocalDate(now)] : [])])];
  const dateFilter = dates.map((value) => ({
    payload: { path: ['daily', 'date'], equals: value },
  }));
  const jobs = await client.instagramSyncJob.findMany({
    where: {
      type: 'DAILY_PROFILE_SYNC',
      AND: [
        dates.length === 1 ? dateFilter[0]! : { OR: dateFilter },
        { payload: { path: ['daily', 'profileIds'], array_contains: [profileId] } },
      ],
    },
    select: { payload: true },
  });
  return jobs.some(({ payload }) => {
    const parsed = dailyMetadataSchema.safeParse(payload);
    if (!parsed.success) return false;
    const data = parsed.data;
    return (
      data.daily.completedProfileIds.includes(profileId) ||
      data.providerSteps.profile?.some((id) => data.runTargets[id]?.includes(profileId))
    );
  });
}
export async function wasWatchedAttempted(profileId: string, date: string, client: Client) {
  const jobs = await client.instagramSyncJob.findMany({
    where: {
      type: 'WATCHED_SYNC',
      AND: [
        { payload: { path: ['watched', 'date'], equals: date } },
        { payload: { path: ['watched', 'profileIds'], array_contains: [profileId] } },
      ],
    },
    select: { payload: true },
  });
  return jobs.some(({ payload }) => {
    const parsed = watchedMetadataSchema.safeParse(payload);
    if (!parsed.success) return false;
    return parsed.data.providerSteps.profile?.some((id) =>
      parsed.data.runTargets[id]?.includes(profileId),
    );
  });
}
export function hasActiveDaily(client: Pick<Prisma.TransactionClient, 'instagramSyncJob'>) {
  return client.instagramSyncJob.findFirst({
    where: { type: 'DAILY_PROFILE_SYNC', status: { in: ['PENDING', 'RUNNING'] } },
    select: { id: true },
  });
}
