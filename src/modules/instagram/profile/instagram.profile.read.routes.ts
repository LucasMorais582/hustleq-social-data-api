import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate, authenticatedUserId } from '../../../auth/authenticate.js';
import { searchInstagramProfile } from './instagram.profile.search.service.js';
import {
  instagramProfileSearchQuerySchema,
  instagramProfileSearchResponseSchema,
} from './instagram.profile.search.schemas.js';
import {
  instagramProfileIdParamsSchema,
  instagramReadRangeSchema,
  readErrorSchema,
} from '../shared/instagram.read.schemas.js';
import {
  instagramProfilePostsQuerySchema,
  storedProfileResponseSchema,
  profilePostsResponseSchema,
  profileSnapshotsResponseSchema,
} from './instagram.profile.read.schemas.js';
import {
  getStoredInstagramProfile,
  getStoredInstagramProfilePosts,
  getStoredInstagramProfileSnapshots,
} from './instagram.profile.read.service.js';

export async function instagramProfileReadRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    await authenticate(request, reply);
  });
  const base = {
    tags: ['Instagram profiles'],
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
  route.get(
    '/instagram/profiles/search',
    {
      schema: {
        tags: base.tags,
        security: base.security,
        summary: 'Pesquisa o perfil e sua disponibilidade, sem cadastrar ou reservar',
        querystring: instagramProfileSearchQuerySchema,
        response: {
          200: instagramProfileSearchResponseSchema,
          ...errors,
          429: readErrorSchema,
          503: readErrorSchema,
        },
      },
    },
    (request) => searchInstagramProfile(request.query, authenticatedUserId(request)),
  );
  route.get(
    '/instagram/profiles/:profileId',
    {
      schema: {
        ...base,
        summary: 'Perfil salvo com o snapshot mais recente, sem Apify',
        response: { 200: storedProfileResponseSchema, ...errors },
      },
    },
    (request) => getStoredInstagramProfile(request.params.profileId, authenticatedUserId(request)),
  );
  route.get(
    '/instagram/profiles/:profileId/posts',
    {
      schema: {
        ...base,
        summary: 'Posts salvos com paginação e métricas mais recentes',
        querystring: instagramProfilePostsQuerySchema,
        response: { 200: profilePostsResponseSchema, ...errors },
      },
    },
    (request) =>
      getStoredInstagramProfilePosts(
        request.params.profileId,
        authenticatedUserId(request),
        request.query,
      ),
  );
  route.get(
    '/instagram/profiles/:profileId/snapshots',
    {
      schema: {
        ...base,
        summary: 'Histórico de snapshots do perfil em ordem crescente',
        querystring: instagramReadRangeSchema,
        response: { 200: profileSnapshotsResponseSchema, ...errors },
      },
    },
    (request) =>
      getStoredInstagramProfileSnapshots(
        request.params.profileId,
        authenticatedUserId(request),
        request.query,
      ),
  );
}
