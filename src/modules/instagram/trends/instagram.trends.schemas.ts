import { z } from 'zod/v4';

export const instagramTrendsRequestSchema = z
  .object({
    target: z.string().trim().min(1).optional(),
    keywords: z.array(z.string().trim().min(1)).min(1).max(10).optional(),
    minLikes: z.int().nonnegative().default(0),
    postType: z.enum(['all', 'reel', 'photo', 'carousel', 'video']).default('all'),
    daysBack: z.int().min(1).max(30).default(30),
    searchLimit: z.int().min(1).max(250).default(10),
  })
  .refine((input) => Boolean(input.target) !== Boolean(input.keywords), {
    message: 'Informe target ou keywords, exclusivamente',
  });

export type InstagramTrendsRequest = z.infer<typeof instagramTrendsRequestSchema>;

// Contrato próprio do Seemu; não reutiliza os nomes do Actor anterior.
export const instagramProviderTrendSchema = z.object({
  recordType: z.literal('post'),
  postId: z.string().min(1),
  keyword: z.string().nullish(),
  shortcode: z.string().nullish(),
  url: z.url().nullish(),
  type: z.enum(['reel', 'photo', 'carousel', 'video']),
  caption: z.string().nullish(),
  hashtags: z.array(z.string()).nullish(),
  takenAt: z.iso.datetime().nullish(),
  ownerId: z.string().nullish(),
  ownerUsername: z.string().nullish(),
  displayUrl: z.url().nullish(),
  videoUrl: z.url().nullish(),
  carouselImageUrls: z.array(z.url()).nullish(),
  videoDuration: z.number().nonnegative().nullish(),
  likeCount: z.number().nullish(),
  commentCount: z.number().nullish(),
  playCount: z.number().nullish(),
  locationName: z.string().nullish(),
});

export const instagramProviderTrendResultSchema = z.discriminatedUnion('recordType', [
  instagramProviderTrendSchema,
  // O Actor inclui avisos no dataset quando não encontra posts para os filtros.
  z.object({ recordType: z.literal('notice') }).passthrough(),
]);
