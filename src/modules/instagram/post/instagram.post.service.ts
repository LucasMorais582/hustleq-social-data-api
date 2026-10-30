import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { normalizeMediaType, normalizeHashtags } from '../shared/instagram.normalize.js';
import type { profileRequestWithResultLimits } from './instagram.post.schemas.js';
import { fetchInstagramPost } from '../../../provider/apify/apify.provider.js';
import { instagramProviderPostSchema } from './instagram.post.schemas.js';

export async function getInstagramPost(request: profileRequestWithResultLimits) {
  const rawItems = await fetchInstagramPost(request.username, request.resultLimits);

  return rawItems.map((rawItem) => {
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
}
