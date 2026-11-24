import { z } from 'zod/v4';

export const instagramCostsQuerySchema = z.strictObject({
  month: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/),
});
const cost = z.number().nonnegative().nullable();
const runs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const instagramCostsResponseSchema = z.strictObject({
  month: instagramCostsQuerySchema.shape.month,
  totalUsd: cost,
  byUser: z.array(z.strictObject({ userId: z.string(), costUsd: cost, runs })),
  byTrigger: z.array(z.strictObject({ trigger: z.string(), costUsd: cost, runs })),
  unattributedUsd: cost,
});
