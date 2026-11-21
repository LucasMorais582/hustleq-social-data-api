import { z } from 'zod/v4';

import {
  instagramProviderPostSchema,
  instagramUsernameSchema,
  providerCount as count,
} from '../shared/instagram.provider.schemas.js';

export const instagramProviderProfileSchema = z.object({
  id: z.string().trim().min(1),
  username: instagramUsernameSchema,
  fullName: z.string().nullish(),
  url: z.url().nullish(),
  businessCategoryName: z.string().nullish(),
  verified: z.boolean().nullish(),
  biography: z.string().nullish(),
  followersCount: count,
  followsCount: count,
  postsCount: count,
  profilePicUrlHD: z.url().nullish(),
  profilePicUrl: z.url().nullish(),

  latestPosts: z.array(
    instagramProviderPostSchema.extend({
      id: z.string().trim().min(1),
      ownerId: z.string().trim().min(1),
    }),
  ),
});
export type profileRequestApify = z.infer<typeof instagramProviderProfileSchema>;
