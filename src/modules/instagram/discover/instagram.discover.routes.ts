import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  authenticateUserOrService,
  authenticatedCallerUserId,
} from '../../../auth/authenticate.js';
import { readErrorSchema } from '../shared/instagram.read.schemas.js';
import {
  discoverQuerySchema,
  discoverResponseSchema,
  discoverSearchingResponseSchema,
} from './instagram.discover.schemas.js';
import { getInstagramDiscover } from './instagram.discover.service.js';

export async function instagramDiscoverRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.get(
    '/instagram/discover',
    {
      onRequest: async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        await authenticateUserOrService(request, reply);
      },
      schema: {
        tags: ['Instagram Discover'],
        summary:
          'Posts dos últimos 30 dias; cache 24h; sem cache, enfileira e retorna 202 imediatamente',
        security: [{ bearerAuth: [] }],
        querystring: discoverQuerySchema,
        response: {
          200: discoverResponseSchema,
          202: discoverSearchingResponseSchema,
          400: readErrorSchema,
          401: readErrorSchema,
          403: readErrorSchema,
          429: readErrorSchema,
          500: readErrorSchema,
          503: readErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await getInstagramDiscover(request.query, authenticatedCallerUserId(request));
      if ('status' in result) return reply.code(202).send(result);
      return reply.code(200).send(result);
    },
  );
}
