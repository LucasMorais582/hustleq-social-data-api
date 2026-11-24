import { z } from 'zod/v4';
import { ProviderError } from '../../../errors/provider.error.js';
import { instagramProviderTrendSchema } from '../trends/instagram.trends.schemas.js';
import {
  normalizeHashtags,
  normalizeMediaType,
  normalizeProfileName,
  toMvpMediaType,
} from '../shared/instagram.normalize.js';
import {
  instagramUsernameSchema,
  providerLikesCount,
  providerCount,
} from '../shared/instagram.provider.schemas.js';
import { discoverPostsSchema, type DiscoverTarget } from './instagram.discover.schemas.js';

const providerPost = instagramProviderTrendSchema.extend({
  postId: z.string().trim().min(1),
  shortcode: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullish(),
  ownerFullName: z.string().nullish(),
  ownerUsername: instagramUsernameSchema.nullish(),
  likeCount: providerLikesCount,
  commentCount: providerCount,
  playCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
});
export function normalizeDiscoverPosts(items: unknown[], target: DiscoverTarget, now: Date) {
  const parsed = providerPost.array().safeParse(items);
  if (!parsed.success)
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'A Apify retornou posts em formato inválido',
    );
  const cutoff = now.getTime() - 30 * 86400000;
  const seen = new Set<string>();
  const posts = parsed.data.flatMap((item) => {
    if (item.keyword != null && item.keyword !== target.keyword)
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'A Apify retornou posts de outra busca',
      );
    if (!item.takenAt) return [];
    const time = Date.parse(item.takenAt);
    if (time < cutoff || time > now.getTime() || seen.has(item.postId)) return [];
    seen.add(item.postId);
    const type = normalizeMediaType(item.type);
    const likesHidden = item.likeCount === -1;
    return [
      {
        instagramPostId: item.postId,
        url: item.url ?? (item.shortcode ? `https://www.instagram.com/p/${item.shortcode}/` : null),
        type: toMvpMediaType(type),
        caption: item.caption ?? null,
        hashtags: normalizeHashtags(item.hashtags),
        displayUrl: item.displayUrl ?? null,
        timestamp: new Date(time).toISOString(),
        ownerUsername: item.ownerUsername ?? null,
        ownerFullName: normalizeProfileName(item.ownerFullName),
        likesCount: likesHidden ? null : (item.likeCount ?? null),
        likesHidden,
        commentsCount: item.commentCount ?? null,
        viewsCount: type === 'reel' ? (item.playCount ?? null) : null,
      },
    ];
  });
  posts.sort(
    (a, b) =>
      Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
      (a.instagramPostId < b.instagramPostId ? -1 : a.instagramPostId > b.instagramPostId ? 1 : 0),
  );
  return discoverPostsSchema.parse(posts.slice(0, 50));
}
