import { z } from 'zod/v4';
import { instagramUsernameSchema } from '../shared/instagram.provider.schemas.js';

const id = z.string().trim().min(1).max(200);
export const competitorParamsSchema = z.strictObject({ instagramProfileId: id });
export const competitorRelationParamsSchema = competitorParamsSchema.extend({ relationId: id });
export const competitorSearchSchema = z.strictObject({
  username: instagramUsernameSchema,
});
export const competitorConfirmationSchema = z.strictObject({
  confirmed: z.literal(true),
  confirmationToken: z.string().min(1).max(20000),
});
export const competitorListSchema = z.strictObject({
  status: z.enum(['active', 'ended', 'all']).default('active'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const competitorIdentitySchema = z.strictObject({
  instagramId: id,
  username: z.string().min(1),
  name: z.string().nullable(),
  bio: z.string().nullable(),
  profilePhoto: z.url().nullable(),
  url: z.url().nullable(),
  category: z.string().nullable(),
  isVerified: z.boolean().nullable(),
});
export type CompetitorIdentity = z.infer<typeof competitorIdentitySchema>;
