import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { ApiError } from '../../../errors/api.error.js';
import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import {
  createTrackedRunGateway,
  executeTrackedActor,
  ProviderStartUncertain,
  type TrackedRunGateway,
} from '../../../provider/apify/apify.tracked-run.js';
import { normalizeProfileName } from '../shared/instagram.normalize.js';
import { parseInstagramProfileResult } from './instagram.profile.service.js';
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
  let providerRunId: string | undefined;
  try {
    const items = await executeTrackedActor(
      'apify/instagram-profile-scraper',
      { usernames: [input.username] },
      {
        prepare: async () => {
          const run = await client.providerRun.create({
            data: {
              actor: 'apify/instagram-profile-scraper',
              trigger: 'initial',
              status: 'running',
              // Convite ainda nao possui usuario HustleQ; nao atribuir custo ao token de servico.
              userId: null,
            },
          });
          providerRunId = run.id;
          return { run, fresh: true };
        },
        update: (id, data) => client.providerRun.update({ where: { id }, data }),
      },
      async () => {},
      gateway ?? createTrackedRunGateway({ timeout: 60 }),
    );
    if (items.length > 1)
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'A Apify retornou perfis inesperados',
      );
    const profile = parseInstagramProfileResult(items[0]);
    if (profile.username !== input.username) {
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'O perfil retornado não corresponde ao username solicitado',
      );
    }
    if (!providerRunId) throw new Error('VERIFIED_PROFILE_RUN_NOT_FOUND');
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
