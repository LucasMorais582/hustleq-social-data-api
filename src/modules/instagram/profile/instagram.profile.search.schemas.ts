import { z } from 'zod/v4';
import { instagramUsernameSchema } from '../shared/instagram.provider.schemas.js';
import { publicCountSchema } from '../shared/instagram.read.schemas.js';

export const instagramProfileSearchQuerySchema = z.strictObject({
  username: instagramUsernameSchema,
});
export const profileOwnershipStatusSchema = z.enum([
  'available',
  'owned_by_me',
  'owned_by_other',
  'reserved',
]);
export type ProfileOwnershipStatus = z.infer<typeof profileOwnershipStatusSchema>;
export const instagramProfileSearchResponseSchema = z.union([
  z.object({ username: z.string(), ownershipStatus: z.literal('not_found') }),
  z.object({
    instagramId: z.string(),
    username: z.string(),
    name: z.string().nullable(),
    bio: z.string().nullable(),
    profilePhoto: z.string().nullable(),
    isVerified: z.boolean().nullable(),
    followers: publicCountSchema,
    following: publicCountSchema,
    postsCount: publicCountSchema,
    ownershipStatus: profileOwnershipStatusSchema,
  }),
]);
