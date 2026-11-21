import { z } from 'zod/v4';

export const instagramUsernameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, '').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9._]{1,30}$/));
export const providerCount = z.int().min(0).max(2147483647).nullish();
export const providerLikesCount = z.int().min(-1).max(2147483647).nullish();
const views = z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullish();

export const instagramProviderPostSchema = z.object({
  id: z.string().trim().min(1).nullish(),
  shortCode: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullish(),
  url: z.url().nullish(),
  ownerId: z.string().trim().min(1).nullish(),
  ownerUsername: instagramUsernameSchema.nullish(),
  ownerFullName: z.string().nullish(),
  type: z.string().nullish(),
  productType: z.string().nullish(),
  caption: z.string().nullish(),
  timestamp: z.iso.datetime().nullish(),
  displayUrl: z.url().nullish(),
  images: z.array(z.url()).nullish(),
  videoUrl: z.url().nullish(),
  alt: z.string().nullish(),
  likesCount: providerLikesCount,
  commentsCount: providerCount,
  videoPlayCount: views,
  videoViewCount: views,
  hashtags: z.array(z.string()).nullish(),
  mentions: z.array(z.string()).nullish(),
  childPosts: z
    .array(
      z.object({
        type: z.string().nullish(),
        displayUrl: z.url().nullish(),
      }),
    )
    .nullish(),
  error: z.string().nullish(),
  errorDescription: z.string().nullish(),
  requestErrorMessages: z.array(z.string()).nullish(),
});
