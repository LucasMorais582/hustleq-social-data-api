import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticateService } from '../../../auth/authenticate.js';
import { readErrorSchema } from '../shared/instagram.read.schemas.js';
import {
  instagramCostsQuerySchema,
  instagramCostsResponseSchema,
} from './instagram.costs.schemas.js';
import { getInstagramCosts } from './instagram.costs.service.js';

export async function instagramCostsRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    await authenticateService(request, reply);
  });
  route.get(
    '/internal/costs',
    {
      schema: {
        tags: ['Instagram internal costs'],
        security: [{ bearerAuth: [] }],
        summary: 'Custos registrados por mês UTC; totais afetados por custo desconhecido são null',
        querystring: instagramCostsQuerySchema,
        response: {
          200: instagramCostsResponseSchema,
          400: readErrorSchema,
          401: readErrorSchema,
          403: readErrorSchema,
          500: readErrorSchema,
        },
      },
    },
    (request) => getInstagramCosts(request.query.month),
  );
}
