import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  authenticateUserOrService,
  authenticatedCallerUserId,
} from '../../../auth/authenticate.js';
import { readErrorSchema } from '../shared/instagram.read.schemas.js';
import { discoverQuerySchema, discoverResponseSchema } from './instagram.discover.schemas.js';
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
          'Posts dos últimos 30 dias; cache compartilhado por 24h; aguarda a busca em cache miss',
        security: [{ bearerAuth: [] }],
        querystring: discoverQuerySchema,
        response: {
          200: discoverResponseSchema,
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
      const waiting = new AbortController();
      const close = () => {
        if (!reply.raw.writableEnded) waiting.abort();
      };
      reply.raw.once('close', close);
      try {
        return await getInstagramDiscover(request.query, authenticatedCallerUserId(request), {
          signal: waiting.signal,
        });
      } finally {
        reply.raw.removeListener('close', close);
      }
    },
  );
}
