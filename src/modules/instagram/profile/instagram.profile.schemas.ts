import { z } from 'zod/v4';

const count = z.int().min(0).max(2147483647).nullish();

export const instagramProviderProfileSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
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
    z.object({
      id: z.string().min(1),
      ownerId: z.string(),
      type: z.string(),
      caption: z.string().nullish(),
      ownerUsername: z.string().nullish(),
      hashtags: z.array(z.string()).nullish(),
      images: z.array(z.url()).nullish(),
      videoPlayCount: z.int().nonnegative().nullish(),
      videoViewCount: z.int().nonnegative().nullish(),
      url: z.url().nullish(),
      displayUrl: z.url().nullish(),
      likesCount: count,
      commentsCount: count,
      timestamp: z.iso.datetime().nullable(),
    }),
  ),
});
export type profileRequestApify = z.infer<typeof instagramProviderProfileSchema>;
