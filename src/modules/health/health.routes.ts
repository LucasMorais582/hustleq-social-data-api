import type { FastifyInstance } from 'fastify';
import { z } from 'zod/v4';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Health check',
        response: {
          200: z.object({
            status: z.literal('ok'),
            service: z.literal('hustleq-social-data-api'),
          }),
        },
      },
    },
    async () => ({ status: 'ok', service: 'hustleq-social-data-api' }),
  );
}
