import { withApifyCaller } from '../../../provider/apify/apify.execution-context.js';
import { authenticate, authenticatedUserId } from '../../../auth/authenticate.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { instagramTrendsRequestSchema } from './instagram.trends.schemas.js';
import { getInstagramTrends } from './instagram.trends.service.js';

export async function getTrendsInstagram(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post(
    '/instagram/trends/search',
    {
      onRequest: authenticate,
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ['Instagram'],
        summary: 'Buscar posts e reels por palavra-chave e período',
        body: instagramTrendsRequestSchema,
      },
    },
    async (request, reply) => {
      const response = await withApifyCaller(authenticatedUserId(request), () =>
        getInstagramTrends(request.body),
      );
      return reply.status(200).send({ response });
    },
  );
}
