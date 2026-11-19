import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../../../config/env.js';
import { runInstagramRefresh } from './instagram.refresh.service.js';

let running = false;

export async function instagramRefreshRoutes(app: FastifyInstance) {
  app.get(
    '/cron/instagram-refresh',
    {
      schema: { hide: true },
      onRequest: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!env.CRON_SECRET) {
          return reply.status(503).send({ code: 'CRON_NOT_CONFIGURED' });
        }
        const received = createHash('sha256')
          .update(request.headers.authorization ?? '')
          .digest();
        const expected = createHash('sha256').update(`Bearer ${env.CRON_SECRET}`).digest();
        if (!timingSafeEqual(received, expected)) {
          return reply.status(401).send({ code: 'UNAUTHORIZED' });
        }
        if (!env.INSTAGRAM_REFRESH_ENABLED) {
          return reply.status(503).send({ code: 'CRON_DISABLED' });
        }
      },
    },
    async (_request, reply) => {
      if (running) return reply.status(409).send({ code: 'REFRESH_ALREADY_RUNNING' });
      running = true;
      try {
        const result = await runInstagramRefresh();
        if (!result.skipped && (result.failed > 0 || result.pending > 0)) {
          app.log.warn(result, 'Instagram daily refresh incomplete');
          return reply.status(503).send({ code: 'REFRESH_INCOMPLETE', ...result });
        }
        return result;
      } catch (error) {
        app.log.error(error, 'Instagram daily refresh failed');
        return reply.status(503).send({ code: 'REFRESH_FAILED' });
      } finally {
        running = false;
      }
    },
  );
}
