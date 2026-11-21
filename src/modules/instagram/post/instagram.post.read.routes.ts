import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate, authenticatedUserId } from '../../../auth/authenticate.js';
import { instagramReadRangeSchema, readErrorSchema } from '../shared/instagram.read.schemas.js';
import {
  instagramPostIdParamsSchema,
  postMetricsResponseSchema,
} from './instagram.post.read.schemas.js';
import { getStoredInstagramPostMetrics } from './instagram.post.read.service.js';

export async function instagramPostReadRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.get(
    '/instagram/posts/:postId/metrics',
    {
      onRequest: async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        await authenticate(request, reply);
      },
      schema: {
        tags: ['Instagram posts'],
        security: [{ bearerAuth: [] }],
        summary: 'Histórico de métricas do post salvo, sem coleta',
        params: instagramPostIdParamsSchema,
        querystring: instagramReadRangeSchema,
        response: {
          200: postMetricsResponseSchema,
          400: readErrorSchema,
          401: readErrorSchema,
          403: readErrorSchema,
          404: readErrorSchema,
          500: readErrorSchema,
        },
      },
    },
    (request) =>
      getStoredInstagramPostMetrics(
        request.params.postId,
        authenticatedUserId(request),
        request.query,
      ),
  );
}
