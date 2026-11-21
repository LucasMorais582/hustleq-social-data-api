import type { PrismaClient } from '@prisma/client';
import { ApiError } from '../../../errors/api.error.js';
import { withProfileInternalTransaction } from './instagram.profile.internal.repository.js';

export async function assignInstagramProfileOwner(
  profileId: string,
  userId: string,
  client?: PrismaClient,
) {
  return withProfileInternalTransaction(async (store) => {
    const profile = await store.find(profileId);
    if (!profile) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
    if (profile.ownerUserId !== null && profile.ownerUserId !== userId) {
      throw new ApiError(409, 'PROFILE_ALREADY_OWNED', 'O perfil já pertence a outro usuário');
    }
    await store.assignOwner(profileId, userId);
    return { profileId, ownerUserId: userId };
  }, client);
}
export async function clearInstagramProfileReservation(profileId: string, client?: PrismaClient) {
  return withProfileInternalTransaction(async (store) => {
    if (!(await store.find(profileId))) {
      throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
    }
    // Não remove dono, perfil, posts, snapshots ou relações de concorrência.
    await store.clearReservation(profileId);
  }, client);
}
