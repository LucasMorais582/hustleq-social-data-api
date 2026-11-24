import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate, authenticatedUserId } from '../../../auth/authenticate.js';
import { readErrorSchema } from '../shared/instagram.read.schemas.js';
import { storedPostResponseSchema } from '../profile/instagram.profile.read.schemas.js';
import { instagramPostIdParamsSchema } from './instagram.post.read.schemas.js';
import {
  postRefreshingResponseSchema,
  postRefreshingWithDataResponseSchema,
  postRefreshBodySchema,
  postRefreshQuerySchema,
} from './instagram.post.refresh.schemas.js';
import {
  readOrRefreshInstagramPost,
  refreshInstagramPost,
} from './instagram.post.refresh.service.js';

export async function instagramPostRefreshRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    await authenticate(request, reply);
  });
  const base = {
    tags: ['Instagram posts'],
    security: [{ bearerAuth: [] }],
    params: instagramPostIdParamsSchema,
    querystring: postRefreshQuerySchema,
  };
  const errors = {
    400: readErrorSchema,
    401: readErrorSchema,
    403: readErrorSchema,
    404: readErrorSchema,
    500: readErrorSchema,
    503: readErrorSchema,
  };
  route.get(
    '/instagram/posts/:postId',
    {
      schema: {
        ...base,
        summary: 'Lê o post salvo e agenda atualização se a coleta tiver 24h ou mais',
        response: {
          200: storedPostResponseSchema,
          202: postRefreshingWithDataResponseSchema,
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const result = await readOrRefreshInstagramPost(
        request.params.postId,
        authenticatedUserId(request),
      );
      return result.refreshing
        ? reply.code(202).send({ status: 'refreshing', post: result.post })
        : reply.code(200).send(result.post);
    },
  );
  route.post(
    '/instagram/posts/:postId/refresh',
    {
      schema: {
        ...base,
        summary: 'Agenda refresh manual; teto de segurança por usuário/dia UTC',
        body: postRefreshBodySchema,
        response: { 202: postRefreshingResponseSchema, 429: readErrorSchema, ...errors },
      },
    },
    async (request, reply) => {
      await refreshInstagramPost(request.params.postId, authenticatedUserId(request));
      return reply.code(202).send({ status: 'refreshing' });
    },
  );
}
