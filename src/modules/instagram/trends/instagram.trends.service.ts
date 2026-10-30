import {
  ProviderError,
  providerFailure,
  isProviderRateLimit,
} from '../../../errors/provider.error.js';
import { normalizeHashtags, normalizeMediaType } from '../shared/instagram.normalize.js';
import { fetchInstagramTrends } from '../../../provider/apify/apify.provider.js';
import {
  instagramProviderTrendResultSchema,
  type InstagramTrendsRequest,
} from './instagram.trends.schemas.js';

const MIN_LIKES_WITHOUT_LOCATION = 1000;

export async function getInstagramTrends(request: InstagramTrendsRequest) {
  const keywords = [...new Set(request.keywords ?? [request.target!])];
  const rawItems = await fetchInstagramTrends({
    keywords,
    searchLimit: request.searchLimit,
    daysBack: request.daysBack,
    minLikes: request.minLikes,
    postType: request.postType,
  });
  const collectedAt = new Date().toISOString();
  const collectedAtMs = Date.parse(collectedAt);
  const cutoff = collectedAtMs - request.daysBack * 24 * 60 * 60 * 1000;

  const result = instagramProviderTrendResultSchema.array().safeParse(rawItems);
  if (!result.success) {
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'A Apify retornou publicações em formato inválido',
    );
  }
  const items = result.data;
  const notices = items.filter((item) => item.recordType === 'notice');
  const noticeMessages = notices
    .map((notice) =>
      ['message', 'errorDescription', 'description', 'reason', 'error', 'notice', 'statusMessage']
        .map((key) => notice[key])
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' — '),
    )
    .filter(Boolean);
  const limited = noticeMessages.find(isProviderRateLimit);
  if (limited) throw providerFailure(limited);
  if (items.length > 0 && notices.length === items.length) {
    throw providerFailure(
      noticeMessages.join(' | ') || 'A Apify terminou apenas com avisos, sem publicações',
    );
  }
  const posts = items.flatMap((item) => {
    if (item.recordType === 'notice') return [];
    if (request.postType !== 'all' && item.type !== request.postType) return [];
    const hasLocation = Boolean(item.locationName?.trim());
    const requiredLikes = hasLocation
      ? request.minLikes
      : Math.max(request.minLikes, MIN_LIKES_WITHOUT_LOCATION);
    if (
      requiredLikes > 0 &&
      (item.likeCount === null || item.likeCount === undefined || item.likeCount < requiredLikes)
    )
      return [];
    const keyword = item.keyword ?? (keywords.length === 1 ? keywords[0] : undefined);
    if (!keyword || !keywords.includes(keyword)) return [];
    return {
      id: item.postId,
      keyword,
      url: item.url ?? null,
      caption: item.caption ?? null,
      hashtags: normalizeHashtags(item.hashtags),
      publishedAt: item.takenAt ?? null,
      author: {
        id: item.ownerId ?? null,
        username: item.ownerUsername ?? null,
      },
      media: {
        type: normalizeMediaType(item.type),
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
      location: item.locationName?.trim() || null,
    };
  });

  const recentPosts = posts.filter((post) => {
    if (!post.publishedAt) return false;
    const publishedAt = Date.parse(post.publishedAt);
    return publishedAt >= cutoff && publishedAt <= collectedAtMs;
  });

  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const selectedPosts = recentPosts.filter((post) => {
    const key = `${post.keyword}:${post.id}`;
    const count = counts.get(post.keyword) ?? 0;
    if (seen.has(key) || count >= request.searchLimit) return false;
    seen.add(key);
    counts.set(post.keyword, count + 1);
    return true;
  });

  return {
    keywords,
    minLikes: request.minLikes,
    postType: request.postType,
    target: request.target,
    collectedAt,
    daysBack: request.daysBack,
    posts: selectedPosts,
  };
}
