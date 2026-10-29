import { fetchInstagramTrends } from '../../../provider/apify/apify.provider.js';
import {
  instagramProviderTrendResultSchema,
  type InstagramTrendsRequest,
} from './instagram.trends.schemas.js';

export async function getInstagramTrends(request: InstagramTrendsRequest) {
  const rawItems = await fetchInstagramTrends(
    request.target,
    request.searchLimit,
    request.daysBack,
  );
  const collectedAt = new Date().toISOString();
  const collectedAtMs = Date.parse(collectedAt);
  const cutoff = collectedAtMs - request.daysBack * 24 * 60 * 60 * 1000;

  const items = rawItems.map((rawItem) => instagramProviderTrendResultSchema.parse(rawItem));
  const posts = items.flatMap((item) => {
    if (item.recordType === 'notice') return [];
    return {
      id: item.postId,
      url: item.url ?? null,
      caption: item.caption ?? null,
      hashtags: item.hashtags ?? [],
      publishedAt: item.takenAt ?? null,
      author: {
        id: item.ownerId ?? null,
        username: item.ownerUsername ?? null,
      },
      media: {
        type: item.type ?? null,
        coverUrl: item.displayUrl ?? null,
        videoUrl: item.videoUrl ?? null,
        durationSeconds: item.videoDuration ?? null,
        images: item.carouselImageUrls ?? [],
      },
      metrics: {
        likesCount: item.likeCount ?? null,
        commentsCount: item.commentCount ?? null,
        playsCount: item.playCount ?? null,
      },
      location: item.locationName ?? null,
    };
  });

  const recentPosts = posts.filter((post) => {
    if (!post.publishedAt) return false;
    const publishedAt = Date.parse(post.publishedAt);
    return publishedAt >= cutoff && publishedAt <= collectedAtMs;
  });

  return {
    target: request.target,
    collectedAt,
    daysBack: request.daysBack,
    posts: recentPosts.slice(0, request.searchLimit),
  };
}
