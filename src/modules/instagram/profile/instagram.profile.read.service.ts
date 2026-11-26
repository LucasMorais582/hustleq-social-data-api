import { serializeStoredPostMetric } from '../shared/instagram.metric.serialize.js';
import { instagramUsernameSchema } from '../shared/instagram.provider.schemas.js';
import { ApiError } from '../../../errors/api.error.js';
import {
  normalizeHashtags,
  normalizeProfileName,
  toMvpMediaType,
} from '../shared/instagram.normalize.js';
import type { ReadRange } from '../shared/instagram.read.schemas.js';
import {
  storedProfileResponseSchema,
  publicProfileSnapshotSchema,
  type ProfilePostsQuery,
} from './instagram.profile.read.schemas.js';
import {
  readStoredInstagramProfile,
  readStoredInstagramPosts,
  readStoredInstagramProfileSnapshots,
  type StoredPostRead,
} from './instagram.profile.read.repository.js';

export function serializeStoredInstagramPost(post: StoredPostRead) {
  const metric = post.metricSnapshots[0];
  return {
    id: post.id,
    instagramPostId: post.instagramPostId,
    url: post.url,
    type: toMvpMediaType(post.type),
    caption: post.caption,
    hashtags: normalizeHashtags(post.hashtags),
    displayUrl: post.displayUrl,
    images: post.images,
    timestamp: post.timestamp?.toISOString() ?? null,
    ownerUsername:
      post.ownerUsername === null ? null : instagramUsernameSchema.parse(post.ownerUsername),
    metrics: metric ? serializeStoredPostMetric(metric, post.type) : null,
  };
}
export async function getStoredInstagramProfile(profileId: string, userId: string) {
  const record = await readStoredInstagramProfile(profileId, userId);
  if (!record) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
  const { snapshots, lastSyncedAt, ...profile } = record;
  const snapshot = snapshots[0];
  return storedProfileResponseSchema.parse({
    ...profile,
    username: instagramUsernameSchema.parse(profile.username),
    name: normalizeProfileName(profile.name),
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    metrics: snapshot ? { ...snapshot, collectedAt: snapshot.collectedAt.toISOString() } : null,
  });
}
export async function getStoredInstagramProfilePosts(
  profileId: string,
  userId: string,
  query: ProfilePostsQuery,
) {
  const { posts, total } = await readStoredInstagramPosts(profileId, userId, query);
  return {
    profileId,
    posts: posts.map(serializeStoredInstagramPost),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}
export async function getStoredInstagramProfileSnapshots(
  profileId: string,
  userId: string,
  range: ReadRange,
) {
  const snapshots = await readStoredInstagramProfileSnapshots(profileId, userId, range);
  return {
    profileId,
    snapshots: snapshots.map((snapshot) =>
      publicProfileSnapshotSchema.parse({
        ...snapshot,
        collectedAt: snapshot.collectedAt.toISOString(),
      }),
    ),
  };
}
