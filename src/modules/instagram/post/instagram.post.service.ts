import { PersistenceError } from '../../../errors/persistence.error.js';
import { savePostCollection } from './instagram.post.repository.js';
import type { PostCollection } from './instagram.post.repository.js';
import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { normalizeInstagramPost } from '../shared/instagram.post.normalize.js';
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

    const normalized = normalizeInstagramPost(item, 'post');

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
      collectedPosts.push({
        ownerInstagramId: data.ownerId,
        instagramPostId: data.id,
        type: normalized.type,
        url: normalized.url,
        caption: normalized.caption,
        hashtags: normalized.hashtags,
        displayUrl: normalized.displayUrl,
        images: normalized.images,
        timestamp: data.timestamp ? new Date(data.timestamp) : null,
        ownerUsername: normalized.ownerUsername,
        likesCount: normalized.likesCount,
        likesHidden: normalized.likesHidden,
        commentsCount: data.commentsCount ?? null,
        viewsCount: null,
      });
    }

    const post = {
      id: item.id,
      shortCode: item.shortCode,
      url: normalized.url,

      author: {
        id: item.ownerId,
        username: normalized.ownerUsername,
      },

      type: normalized.type,
      productType: item.productType,
      caption: normalized.caption,
      publishedAt: normalized.timestamp,

      coverUrl: normalized.displayUrl,
      images: normalized.images,
      videoUrl: item.videoUrl,

      metrics: {
        likesCount: normalized.likesCount,
        likesHidden: normalized.likesHidden,
        commentsCount: item.commentsCount,
        playsCount: normalized.viewsCount,
      },

      hashtags: normalized.hashtags,
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
