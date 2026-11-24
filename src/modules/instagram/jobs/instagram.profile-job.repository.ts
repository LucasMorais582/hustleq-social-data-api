import type { PrismaClient } from '@prisma/client';

// Um Daily em lote também reserva os perfis que ainda não foram concluídos.
export async function findActiveProfileSyncJob(
  profileId: string,
  client: Pick<PrismaClient, 'instagramSyncJob' | 'instagramProfile'>,
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
  if (!profile?.ownerUserId) return null;
  return client.instagramSyncJob.findFirst({
    where: {
      type: 'DAILY_PROFILE_SYNC',
      userId: profile.ownerUserId,
      status: { in: ['PENDING', 'RUNNING'] },
      payload: { path: ['daily', 'remainingProfileIds'], array_contains: [profileId] },
    },
  });
}
