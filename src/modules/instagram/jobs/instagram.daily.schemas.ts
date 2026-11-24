import { z } from 'zod/v4';
const ids = z.array(z.string().min(1)).max(10);
export const dailyMetadataSchema = z
  .object({
    daily: z.object({
      ownerUserId: z.string().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      profileIds: ids.min(1),
      remainingProfileIds: ids,
      completedProfileIds: ids.default([]),
      skippedProfileIds: ids.default([]),
      failures: z.record(z.string(), z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)).default({}),
    }),
    providerSteps: z.record(z.string(), z.array(z.string())).default({}),
    providerAttempts: z.record(z.string(), z.int().min(1)).default({}),
    runTargets: z.record(z.string(), z.array(z.string())).default({}),
  })
  .passthrough();
