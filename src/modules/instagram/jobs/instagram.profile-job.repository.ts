import type { PrismaClient } from '@prisma/client';
import { findWatchedCandidates } from './instagram.watched-eligibility.repository.js';

// Um Daily em lote também reserva os perfis que ainda não foram concluídos.
export async function findActiveProfileSyncJob(
  profileId: string,
  client: Pick<PrismaClient, 'instagramSyncJob' | 'instagramProfile' | 'instagramCompetitor'>,
  options: { ignoreDaily?: boolean } = {},
) {
  const direct = await client.instagramSyncJob.findUnique({
    where: { activeKey: `profile:${profileId}` },
  });
  if (direct) return direct;
  const profile = await client.instagramProfile.findUnique({
    where: { id: profileId },
    select: { ownerUserId: true },
  });
  // Uma reserva nova não pode depender de um Daily que será descartado por perda do dono.
  const daily =
    !options.ignoreDaily && profile?.ownerUserId
      ? await client.instagramSyncJob.findFirst({
          where: {
            type: 'DAILY_PROFILE_SYNC',
            userId: profile.ownerUserId,
            status: { in: ['PENDING', 'RUNNING'] },
            payload: { path: ['daily', 'remainingProfileIds'], array_contains: [profileId] },
          },
        })
      : null;
  if (daily) return daily;
  const watched = await client.instagramSyncJob.findFirst({
    where: {
      type: 'WATCHED_SYNC',
      status: { in: ['PENDING', 'RUNNING'] },
      payload: { path: ['watched', 'remainingProfileIds'], array_contains: [profileId] },
    },
  });
  if (!watched) return null;
  const candidates = await findWatchedCandidates(new Date(), client, [profileId]);
  // A mudança de pagador não libera um alvo enquanto seu Actor/lote ainda pode estar rodando.
  return candidates.some((p) => p.id === profileId) ? watched : null;
}
