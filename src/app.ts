import { instagramCompetitorRoutes } from './modules/instagram/competitors/instagram.competitors.routes.js';
import { CompetitorError } from './modules/instagram/competitors/instagram.competitors.errors.js';
import { ProfileLookupError } from './modules/instagram/profile/instagram.profile.errors.js';
import { instagramRefreshRoutes } from './modules/instagram/refresh/instagram.refresh.routes.js';
import { PersistenceError } from './errors/persistence.error.js';
import { ProviderError } from './errors/provider.error.js';
import jwt from '@fastify/jwt';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { env } from './config/env.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { getProfileInstagram } from './modules/instagram/profile/instagram.profile.routes.js';
import { getPostInstagram } from './modules/instagram/post/instagram.post.routes.js';
import { getTrendsInstagram } from './modules/instagram/trends/instagram.trends.routes.js';

export function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } }).withTypeProvider<ZodTypeProvider>();

  app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { algorithm: 'HS256', iss: env.JWT_ISSUER, aud: env.JWT_AUDIENCE, expiresIn: '1h' },
    verify: {
      algorithms: ['HS256'],
      allowedIss: env.JWT_ISSUER,
      allowedAud: env.JWT_AUDIENCE,
      requiredClaims: ['exp', 'sub'],
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof ProviderError ||
      error instanceof PersistenceError ||
      error instanceof CompetitorError ||
      error instanceof ProfileLookupError
    ) {
      return reply
        .status(error.statusCode)
        .send({ statusCode: error.statusCode, code: error.code, message: error.message });
    }
    return reply.send(error);
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(swagger, {
    openapi: {
      info: {
        title: 'HustleQ Social Data API',
        description: 'Normalized social data API for HustleQ Beta.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
    },
    transform: jsonSchemaTransform,
  });

  app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    transformSpecification: (swaggerObject) => swaggerObject,
  });

  app.register(instagramCompetitorRoutes, { prefix: '/api/v1' });
  app.register(instagramRefreshRoutes, { prefix: '/api' });
  app.register(healthRoutes, { prefix: '/api/v1' });
  app.register(getProfileInstagram, { prefix: '/api/v1' });
  app.register(getPostInstagram, { prefix: '/api/v1' });
  app.register(getTrendsInstagram, { prefix: '/api/v1' });

  app.get('/', async () => ({
    name: 'HustleQ Social Data API',
    version: '0.1.0',
    documentation: '/docs',
    health: '/api/v1/health',
  }));

  return app;
}
