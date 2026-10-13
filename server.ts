import { env } from './src/config/env.js';
import { buildApp } from './src/app.js';

const app = buildApp();

try {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
} catch (error) {
  app.log.error(error, 'Failed to start server');
  process.exit(1);
}
