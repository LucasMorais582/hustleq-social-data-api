import { PersistenceError } from '../../../errors/persistence.error.js';
import { savePostCollection } from './instagram.post.repository.js';
import type { PostCollection } from './instagram.post.repository.js';
import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { normalizeMediaType, normalizeHashtags } from '../shared/instagram.normalize.js';
import type { profileRequestWithResultLimits } from './instagram.post.schemas.js';
import { fetchInstagramPost } from '../../../provider/apify/apify.provider.js';
import {
  instagramProviderPostSchema,
  instagramPersistablePostSchema,
} from './instagram.post.schemas.js';

export async function getInstagramPost(request: profileRequestWithResultLimits) {
  const rawItems = await fetchInstagramPost(request.username, request.resultLimits);

  const collectedAt = new Date();
  const collectedPosts: PostCollection['posts'] = [];
  const posts = rawItems.map((rawItem) => {
    const result = instagramProviderPostSchema.safeParse(rawItem);
    if (!result.success)
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'A Apify retornou uma publicação em formato inválido',
      );
    const item = result.data;

    if (item.error) {
      throw providerFailure(item.errorDescription ?? `Falha ao buscar publicação: ${item.error}`);
    }

    // Sem identidade externa não inventa autor/ID para persistência; mantém a visualização.
    if (item.id && item.ownerId) {
      const persistable = instagramPersistablePostSchema.safeParse(item);
      if (!persistable.success) {
        throw new ProviderError(
          503,
          'PROVIDER_INVALID_RESPONSE',
          'A Apify retornou dados de publicação incompatíveis com a persistência',
        );
      }
      const data = persistable.data;
      const views = data.videoPlayCount ?? data.videoViewCount;
      collectedPosts.push({
        ownerInstagramId: data.ownerId,
        instagramPostId: data.id,
        type: normalizeMediaType(data.type),
        url: data.url ?? null,
        caption: data.caption ?? null,
        hashtags: normalizeHashtags(data.hashtags),
        displayUrl: data.displayUrl ?? null,
        images: data.images ?? [],
        timestamp: data.timestamp ? new Date(data.timestamp) : null,
        ownerUsername: data.ownerUsername ?? null,
        likesCount: data.likesCount ?? null,
        commentsCount: data.commentsCount ?? null,
        viewsCount: views === null || views === undefined ? null : BigInt(views),
      });
    }

    const post = {
      id: item.id,
      shortCode: item.shortCode,
      url: item.url,

      author: {
        id: item.ownerId,
        username: item.ownerUsername,
      },

      type: normalizeMediaType(item.type),
      productType: item.productType,
      caption: item.caption,
      publishedAt: item.timestamp,

      coverUrl: item.displayUrl,
      images: item.images ?? [],
      videoUrl: item.videoUrl,

      metrics: {
        likesCount: item.likesCount,
        commentsCount: item.commentsCount,
        playsCount: item.videoPlayCount,
      },

      hashtags: normalizeHashtags(item.hashtags),
      mentions: item.mentions ?? [],
    };

    return post;
  });
  if (collectedPosts.length > 0) {
    try {
      await savePostCollection({ collectedAt, posts: collectedPosts });
    } catch {
      throw new PersistenceError();
    }
  }
  return posts;
}
