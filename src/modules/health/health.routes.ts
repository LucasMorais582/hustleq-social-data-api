import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Health check',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ok' },
              service: { type: 'string', example: 'hustleq-social-data-api' },
            },
            required: ['status', 'service'],
          },
        },
      },
    },
    async () => ({ status: 'ok', service: 'hustleq-social-data-api' }),
  );
}
