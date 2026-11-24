import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  INSTAGRAM_DAILY_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(5),
  INSTAGRAM_DISCOVER_WAIT_MS: z.coerce.number().int().min(1000).max(3600000).default(1320000),
  INSTAGRAM_MANUAL_REFRESH_DAILY_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
  INSTAGRAM_WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  INSTAGRAM_WORKER_POLL_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  CRON_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).optional(),
  ),
  INSTAGRAM_REFRESH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('hustleq'),
  JWT_AUDIENCE: z.string().min(1).default('hustleq-social-data-api'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const env = envSchema.parse(process.env);
