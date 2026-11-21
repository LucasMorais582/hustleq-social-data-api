import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../provider/database/prisma.client.js';
import { ApiError } from '../errors/api.error.js';

// Estas verificações serão usadas nas novas leituras do contrato MVP.
// O escopo vem do banco, não de claims OWNER/COMPETITOR enviadas pelo cliente.
export async function assertProfileReadAccess(
  profileId: string,
  userId: string,
  client: Pick<PrismaClient, 'instagramProfile'> = getPrismaClient(),
): Promise<'OWNER' | 'COMPETITOR'> {
  const profile = await client.instagramProfile.findUnique({
    where: { id: profileId },
    select: {
      ownerUserId: true,
      monitoredBy: {
        where: { endedAt: null, instagramProfile: { ownerUserId: userId } },
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!profile) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
  if (profile.ownerUserId === userId) return 'OWNER';
  if (profile.monitoredBy.length > 0) return 'COMPETITOR';
  throw new ApiError(403, 'FORBIDDEN', 'Sem acesso a este perfil');
}

export async function assertPostReadAccess(
  postId: string,
  userId: string,
  client: Pick<PrismaClient, 'instagramProfile' | 'instagramPost'> = getPrismaClient(),
) {
  const post = await client.instagramPost.findUnique({
    where: { id: postId },
    select: { instagramProfileId: true },
  });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');
  return assertProfileReadAccess(post.instagramProfileId, userId, client);
}
