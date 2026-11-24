import { withApifyCaller } from '../../../provider/apify/apify.execution-context.js';
import { authenticate, authenticatedUserId } from '../../../auth/authenticate.js';
import { instagramProfileRequestSchema } from '../global-schemas/instagram.username.schemas.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getInstagramProfile } from './instagram.profile.service.js';

export async function getProfileInstagram(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post(
    '/instagram/profile/search',
    {
      onRequest: authenticate,
      schema: {
        security: [{ bearerAuth: [] }],
        body: instagramProfileRequestSchema,
      },
    },
    async (request, reply) => {
      const response = await withApifyCaller(authenticatedUserId(request), () =>
        getInstagramProfile(request.body),
      );
      return reply.status(200).send({ response });
    },
  );
}
