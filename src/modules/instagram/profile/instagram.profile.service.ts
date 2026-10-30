import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { normalizeMediaType } from '../shared/instagram.normalize.js';
import { z } from 'zod/v4';
import { ProfileLookupError } from './instagram.profile.errors.js';
import { fetchInstagramProfile } from '../../../provider/apify/apify.provider.js';
import { type profileRequest } from '../global-schemas/instagram.username.schemas.js';
import { instagramProviderProfileSchema } from './instagram.profile.schemas.js';

export async function getInstagramProfile(request: profileRequest) {
  const rawItem = await fetchInstagramProfile(request.username);

  if (!rawItem) throw new ProfileLookupError('PROFILE_NOT_FOUND');
  const statusResult = z
    .object({
      private: z.boolean().optional(),
      error: z.string().optional(),
    })
    .safeParse(rawItem);
  if (!statusResult.success)
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'A Apify retornou um perfil em formato inválido',
    );
  const status = statusResult.data;
  if (status.private || status.error === 'private' || status.error === 'private_profile') {
    throw new ProfileLookupError('PROFILE_PRIVATE');
  }
  if (status.error === 'not_found' || status.error === 'profile_not_found') {
    throw new ProfileLookupError('PROFILE_NOT_FOUND');
  }
  if (status.error) throw providerFailure(status.error);
  const result = instagramProviderProfileSchema.safeParse(rawItem);
  if (!result.success)
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'A Apify retornou um perfil em formato inválido',
    );
  const item = result.data;

  const profile = {
    id: item.id,
    username: item.username,
    name: item.fullName,
    biography: item.biography,
    followersCount: item.followersCount,
    followingCount: item.followsCount,
    totalPosts: item.postsCount,
    profilePicUrlHD: item.profilePicUrlHD,
  };

  const posts = item.latestPosts.map((post) => ({
    id: post.id,
    profileId: item.id,
    ownerId: post.ownerId,
    type: normalizeMediaType(post.type),
    caption: post.caption,
    url: post.url,
    displayUrl: post.displayUrl,
    likesCount: post.likesCount,
    commentsCount: post.commentsCount,
    publishedAt: post.timestamp,
  }));

  return { profile, posts };
}
