import { z } from 'zod/v4';

export const instagramProviderProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  fullName: z.string(),
  biography: z.string(),
  followersCount: z.number(),
  followsCount: z.number(),
  postsCount: z.number(),
  profilePicUrlHD: z.string(),

  latestPosts: z.array(
    z.object({
      id: z.string(),
      ownerId: z.string(),
      type: z.string(),
      caption: z.string(),
      url: z.url(),
      displayUrl: z.string(),
      likesCount: z.number().nullable(),
      commentsCount: z.number(),
      timestamp: z.iso.datetime().nullable(),
    }),
  ),
});
export type profileRequestApify = z.infer<typeof instagramProviderProfileSchema>;
