import { authenticate } from '../../../auth/authenticate.js';
import { ProfileLookupError } from './instagram.profile.errors.js';
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
      try {
        const response = await getInstagramProfile(request.body);
        return reply.status(200).send({ response });
      } catch (error) {
        if (error instanceof ProfileLookupError) {
          return reply
            .status(404)
            .send({ statusCode: 404, code: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
}
