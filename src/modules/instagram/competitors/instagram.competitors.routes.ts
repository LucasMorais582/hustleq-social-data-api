import { withApifyCaller } from '../../../provider/apify/apify.execution-context.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate, authenticatedUserId } from '../../../auth/authenticate.js';
import {
  competitorParamsSchema,
  competitorRelationParamsSchema,
  competitorSearchSchema,
  competitorListSchema,
} from './instagram.competitors.schemas.js';
import {
  previewInstagramCompetitor,
  registerInstagramCompetitor,
  listInstagramCompetitors,
  endInstagramCompetitor,
} from './instagram.competitors.service.js';

export async function instagramCompetitorRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const path = '/instagram/profiles/:instagramProfileId/competitors';
  const security = [{ bearerAuth: [] }];
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  route.post(
    `${path}/search`,
    {
      onRequest: authenticate,
      schema: {
        security,
        params: competitorParamsSchema,
        body: competitorSearchSchema,
        deprecated: true,
      },
    },
    async (request) => ({
      response: await withApifyCaller(authenticatedUserId(request), () =>
        previewInstagramCompetitor(
          request.params.instagramProfileId,
          request.body.username,
          authenticatedUserId(request),
        ),
      ),
    }),
  );
  route.post(
    path,
    {
      onRequest: authenticate,
      schema: { security, params: competitorParamsSchema, body: competitorSearchSchema },
    },
    async (request, reply) =>
      reply.code(201).send({
        response: await registerInstagramCompetitor(
          request.params.instagramProfileId,
          request.body.username,
          authenticatedUserId(request),
        ),
      }),
  );
  route.get(
    path,
    {
      onRequest: authenticate,
      schema: { security, params: competitorParamsSchema, querystring: competitorListSchema },
    },
    async (request) => ({
      response: await listInstagramCompetitors(
        request.params.instagramProfileId,
        request.query.status,
        request.query.page,
        request.query.limit,
        authenticatedUserId(request),
      ),
    }),
  );
  route.delete(
    `${path}/:relationId`,
    {
      onRequest: authenticate,
      schema: { security, params: competitorRelationParamsSchema },
    },
    async (request, reply) => {
      await endInstagramCompetitor(
        request.params.instagramProfileId,
        request.params.relationId,
        authenticatedUserId(request),
      );
      return reply.code(204).send();
    },
  );
}
