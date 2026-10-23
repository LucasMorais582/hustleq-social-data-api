import { fetchInstagramProfile } from '../../../provider/apify/apify.provider.js';
import { type profileRequest } from '../global-schemas/instagram.username.schemas.js';
import {instagramProviderProfileSchema} from './instagram.profile.schemas.js'

export async function getInstagramProfile(request: profileRequest) {
  const rawItem = await fetchInstagramProfile(request.username);

  const item = instagramProviderProfileSchema.parse(rawItem);

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
    type: post.type,
    caption: post.caption,
    url: post.url,
    displayUrl: post.displayUrl,
    likesCount: post.likesCount,
    commentsCount: post.commentsCount,
    publishedAt: post.timestamp,
  }));

  return { profile, posts };
}
