import type { InstagramSyncJob, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { ProviderError } from '../../../errors/provider.error.js';
import {
  executeTrackedActor,
  createTrackedRunGateway,
  type TrackedRunGateway,
} from '../../../provider/apify/apify.tracked-run.js';
import { parseInstagramProfileResult } from '../profile/instagram.profile.service.js';
import type { ProfileCollection } from '../profile/instagram.profile.repository.js';
import { normalizeProfileName } from '../shared/instagram.normalize.js';
import { normalizeInstagramPost } from '../shared/instagram.post.normalize.js';
import {
  beginInitialProfileSync,
  prepareInitialSyncRun,
  commitInitialProfileSync,
  failInitialProfileSync,
  SyncJobOwnershipLost,
} from './instagram.initial-sync.repository.js';
import {
  renewInstagramSyncJobLease,
  claimNextInstagramSyncJob,
  reclaimInitialProfileSyncJob,
} from './instagram.sync-job.repository.js';

export const INITIAL_SYNC_LEASE_MS = 600000;
export function initialProfileCollection(
  raw: unknown,
  expectedId: string,
  reels: unknown[],
  collectedAt: Date,
): ProfileCollection {
  const profile = parseInstagramProfileResult(raw, expectedId);
  const unique = new Map<string, ReturnType<typeof normalizeInstagramPost>>();
  for (const item of profile.latestPosts) {
    if (item.ownerId === profile.id && !unique.has(item.id))
      unique.set(item.id, normalizeInstagramPost(item, 'profile'));
  }
  const posts = [...unique.values()]
    .sort((a, b) => {
      const date =
        (b.timestamp ? Date.parse(b.timestamp) : -Infinity) -
        (a.timestamp ? Date.parse(a.timestamp) : -Infinity);
      return (Number.isNaN(date) ? 0 : date) || (a.id! < b.id! ? -1 : a.id === b.id ? 0 : 1);
    })
    .slice(0, 12);
  const byId = new Map(posts.map((post) => [post.id, post]));
  for (const rawReel of reels) {
    const reel = normalizeInstagramPost(rawReel, 'reel');
    const post = byId.get(reel.id);
    if (!post || post.type !== 'reel' || reel.ownerId !== profile.id) {
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'O Reel Scraper retornou um post ou autor inesperado',
      );
    }
    post.viewsCount = reel.viewsCount;
  }
  return {
    collectedAt,
    // Novos posts recebem snapshot neste instante; existentes recebem os dados desta coleta.
    refreshMetricsSince: collectedAt,
    metricSource: 'initial',
    refreshRecentPostsLimit: 12,
    profile: {
      instagramId: profile.id,
      username: profile.username,
      name: normalizeProfileName(profile.fullName),
      url: profile.url ?? null,
      bio: profile.biography ?? null,
      profilePhoto: profile.profilePicUrlHD ?? profile.profilePicUrl ?? null,
      category: profile.businessCategoryName ?? null,
      isVerified: profile.verified ?? null,
      followers: profile.followersCount ?? null,
      following: profile.followsCount ?? null,
      postsCount: profile.postsCount ?? null,
    },
    posts: posts.map((post) => ({
      instagramPostId: post.id!,
      type: post.type,
      url: post.url,
      caption: post.caption,
      hashtags: post.hashtags,
      displayUrl: post.displayUrl,
      images: post.images,
      timestamp: post.timestamp ? new Date(post.timestamp) : null,
      ownerUsername: post.ownerUsername ?? profile.username,
      likesCount: post.likesCount,
      likesHidden: post.likesHidden,
      commentsCount: post.commentsCount,
      viewsCount: post.viewsCount === null ? null : BigInt(post.viewsCount),
    })),
  };
}
export function initialReelUrls(collection: ProfileCollection) {
  return collection.posts.flatMap((post) => {
    if (post.type !== 'reel' || !post.url) return [];
    const url = new URL(post.url);
    const path = url.pathname.match(/^\/(p|reel)\/([a-zA-Z0-9_-]+)\/?$/);
    return url.protocol === 'https:' && /^(www\.)?instagram\.com$/.test(url.hostname) && path
      ? [`https://www.instagram.com/reel/${path[2]}/`]
      : [];
  });
}
export function initialSyncErrorCode(error: unknown, fallback = 'INITIAL_SYNC_FAILED') {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)
  )
    return error.code;
  return fallback;
}

export async function processInitialProfileSync(
  job: InstagramSyncJob,
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  if (job.type !== 'INITIAL_PROFILE_SYNC' || !job.lockToken || !job.instagramProfileId)
    throw new Error('INVALID_INITIAL_SYNC_JOB');
  const owner = { id: job.id, lockToken: job.lockToken };
  const heartbeat = async () => {
    if (!(await renewInstagramSyncJobLease(owner, INITIAL_SYNC_LEASE_MS, client)))
      throw new SyncJobOwnershipLost();
  };
  try {
    await heartbeat();
    const profile = await beginInitialProfileSync(owner, client);
    const executionGateway = gateway ?? createTrackedRunGateway();
    const execute = (step: 'profile' | 'reels', actor: string, input: Record<string, unknown>) =>
      executeTrackedActor(
        actor,
        input,
        {
          prepare: () => prepareInitialSyncRun(owner, step, actor, client),
          update: (id, data) => client.providerRun.update({ where: { id }, data }),
        },
        heartbeat,
        executionGateway,
      );
    const profiles = await execute('profile', 'apify/instagram-profile-scraper', {
      usernames: [profile.username],
    });
    if (profiles.length > 1)
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'A Apify retornou perfis inesperados',
      );
    const first = initialProfileCollection(profiles[0], profile.instagramId, [], new Date());
    const urls = initialReelUrls(first);
    const reels = urls.length
      ? await execute('reels', 'apify/instagram-reel-scraper', {
          username: urls,
          resultsLimit: 1,
          includeSharesCount: false,
          includeTranscript: false,
          includeDownloadedVideo: false,
        })
      : [];
    const collection = initialProfileCollection(
      profiles[0],
      profile.instagramId,
      reels,
      new Date(),
    );
    await commitInitialProfileSync(owner, collection, client);
    return { status: 'succeeded' as const, jobId: job.id };
  } catch (error) {
    if (error instanceof SyncJobOwnershipLost) return { status: 'lost' as const, jobId: job.id };
    try {
      const failed = await failInitialProfileSync(owner, initialSyncErrorCode(error), client);
      return {
        status: failed.status === 'FAILED' ? ('failed' as const) : ('retrying' as const),
        jobId: job.id,
      };
    } catch (failure) {
      if (failure instanceof SyncJobOwnershipLost)
        return { status: 'lost' as const, jobId: job.id };
      throw failure;
    }
  }
}

export async function runInitialSyncWorkerOnce(
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  const job =
    (await reclaimInitialProfileSyncJob(INITIAL_SYNC_LEASE_MS, client)) ??
    (await claimNextInstagramSyncJob(INITIAL_SYNC_LEASE_MS, client, 'INITIAL_PROFILE_SYNC'));
  if (!job) return null;
  return processInitialProfileSync(job, client, gateway);
}
