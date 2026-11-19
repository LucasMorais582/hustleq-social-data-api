import { PersistenceError } from '../../../errors/persistence.error.js';
import { saveProfileCollection } from './instagram.profile.repository.js';
import { normalizeHashtags } from '../shared/instagram.normalize.js';
import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { normalizeMediaType } from '../shared/instagram.normalize.js';
import { z } from 'zod/v4';
import { ProfileLookupError } from './instagram.profile.errors.js';
import { fetchInstagramProfile } from '../../../provider/apify/apify.provider.js';
import { type profileRequest } from '../global-schemas/instagram.username.schemas.js';
import { instagramProviderProfileSchema } from './instagram.profile.schemas.js';

interface ScheduledProfileRefresh {
  expectedInstagramId: string;
  refreshMetricsSince: Date;
}

export async function getInstagramProfile(
  request: profileRequest,
  scheduled?: ScheduledProfileRefresh,
) {
  const rawItem = scheduled
    ? await fetchInstagramProfile(request.username, { timeout: 60, waitSecs: 70 })
    : await fetchInstagramProfile(request.username);

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
  if (scheduled && item.id !== scheduled.expectedInstagramId) {
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'O username passou a identificar outro perfil do Instagram',
    );
  }

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

  // Mantém o contrato HTTP existente; a persistência usa os dados completos validados.
  const collectedAt = new Date();
  const ownedPosts = item.latestPosts.filter((post) => post.ownerId === item.id);
  const collection = {
    collectedAt,
    profile: {
      instagramId: item.id,
      username: item.username,
      name: item.fullName ?? null,
      url: item.url ?? null,
      bio: item.biography ?? null,
      profilePhoto: item.profilePicUrlHD ?? null,
      category: item.businessCategoryName ?? null,
      isVerified: item.verified ?? null,
      followers: item.followersCount ?? null,
      following: item.followsCount ?? null,
      postsCount: item.postsCount ?? null,
    },
    posts: ownedPosts.map((post) => {
      const views = post.videoPlayCount ?? post.videoViewCount;
      return {
        instagramPostId: post.id,
        type: normalizeMediaType(post.type),
        url: post.url ?? null,
        caption: post.caption ?? null,
        hashtags: normalizeHashtags(post.hashtags),
        displayUrl: post.displayUrl ?? null,
        images: post.images ?? [],
        timestamp: post.timestamp ? new Date(post.timestamp) : null,
        ownerUsername: post.ownerUsername ?? item.username,
        likesCount: post.likesCount ?? null,
        commentsCount: post.commentsCount ?? null,
        viewsCount: views === null || views === undefined ? null : BigInt(views),
      };
    }),
  };
  try {
    await saveProfileCollection(
      scheduled
        ? { ...collection, refreshMetricsSince: scheduled.refreshMetricsSince }
        : collection,
    );
  } catch {
    throw new PersistenceError();
  }

  return { profile, posts };
}
