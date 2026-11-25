import type { PrismaClient } from '@prisma/client';
import { ApiError } from '../../../errors/api.error.js';
import { withProfileInternalTransaction } from './instagram.profile.internal.repository.js';
import { instagramUsernameSchema } from '../shared/instagram.provider.schemas.js';
import { normalizeProfileName } from '../shared/instagram.normalize.js';
import { profileMonitoringResponseSchema } from './instagram.profile.internal.schemas.js';

export async function updateInstagramProfileMonitoring(
  profileId: string,
  monitoringUntil: string | null,
  client?: PrismaClient,
) {
  return withProfileInternalTransaction(async (store) => {
    if (!(await store.find(profileId))) {
      throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
    }
    const profile = await store.updateMonitoring(
      profileId,
      monitoringUntil === null ? null : new Date(monitoringUntil),
    );
    return profileMonitoringResponseSchema.parse({
      ...profile,
      username: instagramUsernameSchema.parse(profile.username),
      name: normalizeProfileName(profile.name),
      monitoringUntil: profile.monitoringUntil?.toISOString() ?? null,
      lastSyncedAt: profile.lastSyncedAt?.toISOString() ?? null,
    });
  }, client);
}

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

export async function removeInstagramProfileOwner(
  profileId: string,
  userId: string,
  client?: PrismaClient,
) {
  return withProfileInternalTransaction(async (store) => {
    const profile = await store.find(profileId);
    if (!profile) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
    // Repetir uma remoção não cancela jobs de um convite novo enquanto ainda está sem dono.
    if (profile.ownerUserId === null) return;
    if (profile.ownerUserId !== userId)
      throw new ApiError(409, 'OWNER_MISMATCH', 'O perfil pertence a outro usuário');
    await store.removeOwner(profileId);
  }, client);
}
