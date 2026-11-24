import { withApifyCaller } from '../../../provider/apify/apify.execution-context.js';
import { authenticate, authenticatedUserId } from '../../../auth/authenticate.js';
import { instagramPostRequestSchema } from './instagram.post.schemas.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getInstagramPost } from './instagram.post.service.js';

export async function getPostInstagram(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post(
    '/instagram/post/search',
    {
      onRequest: authenticate,
      schema: {
        security: [{ bearerAuth: [] }],
        body: instagramPostRequestSchema,
      },
    },
    async (request, reply) => {
      const response = await withApifyCaller(authenticatedUserId(request), () =>
        getInstagramPost(request.body),
      );
      return reply.status(200).send({ response });
    },
  );
}
