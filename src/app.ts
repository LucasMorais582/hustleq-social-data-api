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

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(swagger, {
    openapi: {
      info: {
        title: 'HustleQ Social Data API',
        description: 'Normalized social data API for HustleQ Beta.',
        version: '0.1.0',
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
