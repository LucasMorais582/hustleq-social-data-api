import { z } from 'zod/v4';

export const instagramPostRequestSchema = z.object({
  username: z.string().min(3),
  resultLimits: z.int().min(1).max(50),
});
export type profileRequestWithResultLimits = z.infer<typeof instagramPostRequestSchema>;

export const instagramProviderPostSchema = z.object({
  id: z.string().nullish(),
  shortCode: z.string().nullish(),
  url: z.url().nullish(),
  ownerId: z.string().nullish(),
  ownerUsername: z.string().nullish(),
  ownerFullName: z.string().nullish(),
  type: z.string().nullish(),
  productType: z.string().nullish(),
  caption: z.string().nullish(),
  timestamp: z.iso.datetime().nullish(),
  displayUrl: z.url().nullish(),
  images: z.array(z.url()).nullish(),
  videoUrl: z.url().nullish(),
  alt: z.string().nullish(),
  likesCount: z.number().nullish(),
  commentsCount: z.number().nullish(),
  videoPlayCount: z.number().nullish(),
  hashtags: z.array(z.string()).nullish(),
  mentions: z.array(z.string()).nullish(),
  childPosts: z.array(z.record(z.string(), z.unknown())).nullish(),
  error: z.string().nullish(),
  errorDescription: z.string().nullish(),
  requestErrorMessages: z.array(z.string()).nullish(),
});

export type postRequestApify = z.infer<typeof instagramProviderPostSchema>;
