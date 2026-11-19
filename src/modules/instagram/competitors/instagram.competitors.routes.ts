import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate, authenticatedUserId } from '../../../auth/authenticate.js';
import {
  competitorParamsSchema,
  competitorRelationParamsSchema,
  competitorSearchSchema,
  competitorConfirmationSchema,
  competitorListSchema,
} from './instagram.competitors.schemas.js';
import {
  previewInstagramCompetitor,
  confirmInstagramCompetitor,
  listInstagramCompetitors,
  endInstagramCompetitor,
} from './instagram.competitors.service.js';

export async function instagramCompetitorRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const path = '/instagram/profiles/:instagramProfileId/competitors';
  const security = [{ bearerAuth: [] }];
  route.post(
    `${path}/search`,
    {
      onRequest: authenticate,
      schema: { security, params: competitorParamsSchema, body: competitorSearchSchema },
    },
    async (request) => ({
      response: await previewInstagramCompetitor(
        request.params.instagramProfileId,
        request.body.username,
        authenticatedUserId(request),
      ),
    }),
  );
  route.post(
    path,
    {
      onRequest: authenticate,
      schema: { security, params: competitorParamsSchema, body: competitorConfirmationSchema },
    },
    async (request, reply) =>
      reply.code(201).send({
        response: await confirmInstagramCompetitor(
          request.params.instagramProfileId,
          request.body.confirmationToken,
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
      ),
    }),
  );
  route.delete(
    `${path}/:relationId`,
    {
      onRequest: authenticate,
      schema: { security, params: competitorRelationParamsSchema },
    },
    async (request) => ({
      response: await endInstagramCompetitor(
        request.params.instagramProfileId,
        request.params.relationId,
      ),
    }),
  );
}
