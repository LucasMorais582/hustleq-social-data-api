import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { instagramProviderPostSchema } from './instagram.provider.schemas.js';
import { normalizeHashtags, normalizeMediaType, toMvpMediaType } from './instagram.normalize.js';

export type InstagramPostProvider = 'profile' | 'post' | 'reel';

export function normalizeInstagramPost(raw: unknown, provider: InstagramPostProvider) {
  const result = instagramProviderPostSchema.safeParse(raw);
  if (!result.success) {
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'A Apify retornou uma publicação em formato inválido',
    );
  }
  const item = result.data;
  if (item.error) throw providerFailure(item.errorDescription ?? item.error);
  const type = normalizeMediaType(item.type, item.productType);
  if (provider === 'reel' && type !== 'reel') {
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'O Reel Scraper retornou uma publicação que não é Reel',
    );
  }
  const likesHidden = item.likesCount === -1;
  const images = item.images?.length
    ? item.images
    : type === 'carousel'
      ? (item.childPosts ?? []).flatMap((child) => (child.displayUrl ? [child.displayUrl] : []))
      : type === 'photo' && item.displayUrl
        ? [item.displayUrl]
        : [];
  return {
    id: item.id ?? null,
    ownerId: item.ownerId ?? null,
    ownerUsername: item.ownerUsername ?? null,
    type,
    caption: item.caption ?? null,
    url: item.url ?? (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : null),
    hashtags: normalizeHashtags(item.hashtags),
    displayUrl: item.displayUrl ?? null,
    images,
    timestamp: item.timestamp ?? null,
    likesCount: likesHidden ? null : (item.likesCount ?? null),
    likesHidden,
    commentsCount: item.commentsCount ?? null,
    // Somente o Reel Scraper é a fonte de views dos novos snapshots da MVP.
    viewsCount: provider === 'reel' ? (item.videoPlayCount ?? item.videoViewCount ?? null) : null,
  };
}

// Campos normalizados para os DTOs MVP; cada rota compõe IDs e métricas no seu contrato.
export function toMvpPostData(post: ReturnType<typeof normalizeInstagramPost>) {
  return {
    instagramPostId: post.id,
    url: post.url,
    type: toMvpMediaType(post.type),
    caption: post.caption,
    hashtags: post.hashtags,
    displayUrl: post.displayUrl,
    images: post.images,
    timestamp: post.timestamp,
    ownerUsername: post.ownerUsername,
    likesCount: post.likesCount,
    likesHidden: post.likesHidden,
    commentsCount: post.commentsCount,
    viewsCount: post.viewsCount,
  };
}
