import { z } from 'zod/v4';

export function normalizeDiscoverTerm(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/gu, ' ');
}
const normalizedTerm = z
  .string()
  .max(200)
  .regex(/^[^\p{Cc}]*$/u);
const term = z.string().max(400).transform(normalizeDiscoverTerm).pipe(normalizedTerm.min(1));
export const discoverQuerySchema = z.strictObject({
  niche: term,
  city: term,
  query: z
    .string()
    .max(400)
    .optional()
    .transform((value) => (value === undefined ? null : normalizeDiscoverTerm(value) || null))
    .pipe(normalizedTerm.min(1).nullable()),
});
export type DiscoverQuery = z.infer<typeof discoverQuerySchema>;
export function discoverKey(query: DiscoverQuery) {
  return JSON.stringify([query.niche, query.city, query.query]);
}
export function discoverKeyword(query: DiscoverQuery) {
  return [query.niche, query.city, query.query].filter(Boolean).join(' ');
}
export const discoverTargetSchema = z
  .object({
    niche: z.string().min(1).max(200),
    city: z.string().min(1).max(200),
    query: z.string().max(200).nullable(),
    key: z.string().min(1).max(2000),
    keyword: z.string().min(1).max(602),
  })
  .superRefine((target, ctx) => {
    if (target.key !== discoverKey(target) || target.keyword !== discoverKeyword(target))
      ctx.addIssue({ code: 'custom', message: 'Busca incompatível com a chave de cache' });
  });
export type DiscoverTarget = z.infer<typeof discoverTargetSchema>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const discoverPostSchema = z.strictObject({
  instagramPostId: z.string().min(1),
  url: z.string().nullable(),
  type: z.enum(['IMAGE', 'CAROUSEL', 'REEL']),
  caption: z.string().nullable(),
  hashtags: z.array(z.string()),
  displayUrl: z.string().nullable(),
  timestamp: z.iso.datetime(),
  ownerUsername: z.string().nullable(),
  ownerFullName: z.string().nullable(),
  likesCount: count,
  likesHidden: z.boolean(),
  commentsCount: count,
  viewsCount: count,
});
export const discoverPostsSchema = z.array(discoverPostSchema).max(50);
export const discoverResponseSchema = z.strictObject({
  fromCache: z.boolean(),
  fetchedAt: z.iso.datetime(),
  niche: z.string(),
  city: z.string(),
  query: z.string().nullable(),
  posts: discoverPostsSchema,
});
