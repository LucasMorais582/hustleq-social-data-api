import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('hustleq'),
  JWT_AUDIENCE: z.string().min(1).default('hustleq-social-data-api'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const env = envSchema.parse(process.env);
