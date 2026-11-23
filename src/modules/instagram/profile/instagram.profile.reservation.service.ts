import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { ApiError } from '../../../errors/api.error.js';
import { providerFailure } from '../../../errors/provider.error.js';
import {
  ProviderStartUncertain,
  type TrackedRunGateway,
} from '../../../provider/apify/apify.tracked-run.js';
import { normalizeProfileName } from '../shared/instagram.normalize.js';
import { lookupTrackedInstagramProfile } from './instagram.profile.lookup.service.js';
import { reserveVerifiedInstagramProfile } from './instagram.profile.reservation.repository.js';
import {
  reserveInstagramProfileSchema,
  reservedInstagramProfileResponseSchema,
  type ReserveInstagramProfileRequest,
} from './instagram.profile.internal.schemas.js';

export async function reserveInstagramProfile(
  request: ReserveInstagramProfileRequest,
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  const input = reserveInstagramProfileSchema.parse(request);
  const reservedUntil = new Date(input.reservedUntil);
  // Evita iniciar uma coleta paga para um convite que ja chegou vencido.
  if (reservedUntil.getTime() <= Date.now()) {
    throw new ApiError(400, 'INVALID_REQUEST', 'reservedUntil deve ser uma data futura');
  }
  try {
    const { profile, providerRunId } = await lookupTrackedInstagramProfile(
      input.username,
      { trigger: 'initial', userId: null },
      client,
      gateway,
    );
    const reservation = await reserveVerifiedInstagramProfile(
      {
        inviteId: input.inviteId,
        reservedUntil,
        providerRunId,
        identity: {
          instagramId: profile.id,
          username: profile.username,
          name: normalizeProfileName(profile.fullName),
          url: profile.url ?? null,
          bio: profile.biography ?? null,
          profilePhoto: profile.profilePicUrlHD ?? profile.profilePicUrl ?? null,
          category: profile.businessCategoryName ?? null,
          isVerified: profile.verified ?? null,
        },
      },
      client,
    );
    return reservedInstagramProfileResponseSchema.parse(reservation);
  } catch (error) {
    if (error instanceof ProviderStartUncertain) {
      throw providerFailure(
        'Não foi possível confirmar o início da consulta à Apify. A reserva não foi criada.',
      );
    }
    throw error;
  }
}
