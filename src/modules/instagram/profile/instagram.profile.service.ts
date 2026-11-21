import { PersistenceError } from '../../../errors/persistence.error.js';
import { saveProfileCollection } from './instagram.profile.repository.js';
import { normalizeProfileName } from '../shared/instagram.normalize.js';
import { normalizeInstagramPost } from '../shared/instagram.post.normalize.js';
import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import { z } from 'zod/v4';
import { ProfileLookupError } from './instagram.profile.errors.js';
import { fetchInstagramProfile } from '../../../provider/apify/apify.provider.js';
import { type profileRequest } from '../global-schemas/instagram.username.schemas.js';
import { instagramProviderProfileSchema } from './instagram.profile.schemas.js';

interface ScheduledProfileRefresh {
  expectedInstagramId: string;
  refreshMetricsSince: Date;
}

export async function lookupInstagramProfile(
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

  return item;
}

export async function getInstagramProfile(
  request: profileRequest,
  scheduled?: ScheduledProfileRefresh,
) {
  const item = await lookupInstagramProfile(request, scheduled);

  const profile = {
    id: item.id,
    username: item.username,
    name: normalizeProfileName(item.fullName),
    biography: item.biography,
    followersCount: item.followersCount,
    followingCount: item.followsCount,
    totalPosts: item.postsCount,
    profilePicUrlHD: item.profilePicUrlHD ?? item.profilePicUrl ?? null,
  };

  const normalized = item.latestPosts.map((raw) => ({
    raw,
    post: normalizeInstagramPost(raw, 'profile'),
  }));
  const posts = normalized.map(({ raw, post }) => ({
    id: raw.id,
    profileId: item.id,
    ownerId: raw.ownerId,
    type: post.type,
    caption: post.caption,
    url: post.url,
    displayUrl: post.displayUrl,
    images: post.images,
    likesCount: post.likesCount,
    likesHidden: post.likesHidden,
    commentsCount: post.commentsCount,
    publishedAt: post.timestamp,
  }));

  const collectedAt = new Date();
  const collection = {
    collectedAt,
    profile: {
      instagramId: item.id,
      username: item.username,
      name: normalizeProfileName(item.fullName),
      url: item.url ?? null,
      bio: item.biography ?? null,
      profilePhoto: item.profilePicUrlHD ?? item.profilePicUrl ?? null,
      category: item.businessCategoryName ?? null,
      isVerified: item.verified ?? null,
      followers: item.followersCount ?? null,
      following: item.followsCount ?? null,
      postsCount: item.postsCount ?? null,
    },
    posts: normalized
      .filter(({ raw }) => raw.ownerId === item.id)
      .map(({ raw, post }) => ({
        instagramPostId: raw.id,
        type: post.type,
        url: post.url,
        caption: post.caption,
        hashtags: post.hashtags,
        displayUrl: post.displayUrl,
        images: post.images,
        timestamp: post.timestamp ? new Date(post.timestamp) : null,
        ownerUsername: post.ownerUsername ?? item.username,
        likesCount: post.likesCount,
        likesHidden: post.likesHidden,
        commentsCount: post.commentsCount,
        viewsCount: null,
      })),
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
