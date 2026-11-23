import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { authenticateService } from '../../../auth/authenticate.js';
import { reserveInstagramProfile } from './instagram.profile.reservation.service.js';
import {
  instagramProfileIdParamsSchema,
  readErrorSchema,
} from '../shared/instagram.read.schemas.js';
import {
  assignProfileOwnerSchema,
  assignedProfileOwnerResponseSchema,
  clearProfileReservationSchema,
  updateProfileMonitoringSchema,
  profileMonitoringResponseSchema,
  reserveInstagramProfileSchema,
  reservedInstagramProfileResponseSchema,
} from './instagram.profile.internal.schemas.js';
import {
  assignInstagramProfileOwner,
  clearInstagramProfileReservation,
  updateInstagramProfileMonitoring,
} from './instagram.profile.internal.service.js';

export async function instagramProfileInternalRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    await authenticateService(request, reply);
  });
  const base = {
    tags: ['Instagram internal profiles'],
    security: [{ bearerAuth: [] }],
    params: instagramProfileIdParamsSchema,
  };
  const errors = {
    400: readErrorSchema,
    401: readErrorSchema,
    403: readErrorSchema,
    404: readErrorSchema,
    500: readErrorSchema,
  };
  route.post(
    '/internal/instagram/profiles',
    {
      schema: {
        tags: base.tags,
        security: base.security,
        summary: 'Confirma a identidade, reserva para o convite e enfileira o Initial Sync',
        body: reserveInstagramProfileSchema,
        response: {
          201: reservedInstagramProfileResponseSchema,
          ...errors,
          409: readErrorSchema,
          429: readErrorSchema,
          503: readErrorSchema,
        },
      },
    },
    async (request, reply) => reply.code(201).send(await reserveInstagramProfile(request.body)),
  );
  route.patch(
    '/internal/instagram/profiles/:profileId/monitoring',
    {
      schema: {
        ...base,
        summary: 'Define até quando o perfil participa da coleta diária; exige serviço',
        body: updateProfileMonitoringSchema,
        response: { 200: profileMonitoringResponseSchema, ...errors },
      },
    },
    (request) =>
      updateInstagramProfileMonitoring(request.params.profileId, request.body.monitoringUntil),
  );
  route.post(
    '/internal/instagram/profiles/:profileId/owner',
    {
      schema: {
        ...base,
        summary: 'Atribui o dono e limpa a reserva; exige token de serviço',
        body: assignProfileOwnerSchema,
        response: { 200: assignedProfileOwnerResponseSchema, 409: readErrorSchema, ...errors },
      },
    },
    (request) => assignInstagramProfileOwner(request.params.profileId, request.body.userId),
  );
  route.delete(
    '/internal/instagram/profiles/:profileId/reservation',
    {
      schema: {
        ...base,
        summary: 'Libera a reserva sem apagar dados; exige token de serviço',
        body: clearProfileReservationSchema,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await clearInstagramProfileReservation(request.params.profileId);
      return reply.code(204).send(null);
    },
  );
}
