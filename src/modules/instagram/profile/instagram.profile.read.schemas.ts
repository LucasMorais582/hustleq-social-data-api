import { z } from 'zod/v4';
import {
  publicCountSchema,
  publicPostMetricSchema,
  readRangeFields,
  validateReadRange,
} from '../shared/instagram.read.schemas.js';

export const instagramProfilePostsQuerySchema = z
  .strictObject({
    ...readRangeFields,
    type: z.enum(['IMAGE', 'CAROUSEL', 'REEL']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .superRefine((value, ctx) => {
    validateReadRange(value, ctx);
    if ((value.page - 1) * value.limit > 2147483647) {
      ctx.addIssue({ code: 'custom', path: ['page'], message: 'Página fora da faixa suportada' });
    }
  });
export type ProfilePostsQuery = z.infer<typeof instagramProfilePostsQuerySchema>;
export const publicProfileSnapshotSchema = z.object({
  followers: publicCountSchema,
  following: publicCountSchema,
  postsCount: publicCountSchema,
  collectedAt: z.iso.datetime(),
});
export const storedProfileResponseSchema = z.object({
  id: z.string(),
  instagramId: z.string(),
  username: z.string(),
  name: z.string().nullable(),
  url: z.string().nullable(),
  bio: z.string().nullable(),
  profilePhoto: z.string().nullable(),
  category: z.string().nullable(),
  isVerified: z.boolean().nullable(),
  syncStatus: z.enum(['pending', 'syncing', 'ready', 'failed']),
  lastSyncedAt: z.iso.datetime().nullable(),
  metrics: publicProfileSnapshotSchema.nullable(),
});
export const storedPostResponseSchema = z.object({
  id: z.string(),
  instagramPostId: z.string(),
  url: z.string().nullable(),
  type: z.enum(['IMAGE', 'CAROUSEL', 'REEL']),
  caption: z.string().nullable(),
  hashtags: z.array(z.string()),
  displayUrl: z.string().nullable(),
  images: z.array(z.string()),
  timestamp: z.iso.datetime().nullable(),
  ownerUsername: z.string().nullable(),
  metrics: publicPostMetricSchema.nullable(),
});
export const profilePostsResponseSchema = z.object({
  profileId: z.string(),
  posts: z.array(storedPostResponseSchema),
  pagination: z.object({
    page: z.int().positive(),
    limit: z.int().positive().max(50),
    total: z.int().nonnegative(),
    totalPages: z.int().nonnegative(),
  }),
});
export const profileSnapshotsResponseSchema = z.object({
  profileId: z.string(),
  snapshots: z.array(publicProfileSnapshotSchema),
});
