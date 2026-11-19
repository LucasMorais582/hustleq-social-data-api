import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { authenticate } from '../../../auth/authenticate.js';
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

function subject(request: FastifyRequest) {
  return z.object({ sub: z.string().min(1) }).parse(request.user).sub;
}
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
        subject(request),
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
          subject(request),
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
