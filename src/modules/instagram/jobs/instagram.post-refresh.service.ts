import type { InstagramSyncJob, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { ProviderError } from '../../../errors/provider.error.js';
import {
  executeTrackedActor,
  createTrackedRunGateway,
  type TrackedRunGateway,
} from '../../../provider/apify/apify.tracked-run.js';
import { normalizeInstagramPost } from '../shared/instagram.post.normalize.js';
import { canonicalPostUrl } from '../post/instagram.post.refresh.repository.js';
import { SyncJobOwnershipLost } from './instagram.initial-sync.repository.js';
import { initialSyncErrorCode } from './instagram.initial-sync.service.js';
import {
  readPostRefreshTarget,
  preparePostRefreshRun,
  commitPostRefresh,
  failPostRefresh,
} from './instagram.post-refresh.repository.js';
import {
  reclaimInstagramSyncJob,
  claimNextInstagramSyncJob,
  renewInstagramSyncJobLease,
} from './instagram.sync-job.repository.js';

const LEASE_MS = 600000;
export async function processPostRefresh(
  job: InstagramSyncJob,
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  if (job.type !== 'POST_REFRESH' || !job.lockToken || !job.instagramPostId)
    throw new Error('INVALID_POST_REFRESH_JOB');
  const owner = { id: job.id, lockToken: job.lockToken };
  const heartbeat = async () => {
    if (!(await renewInstagramSyncJobLease(owner, LEASE_MS, client)))
      throw new SyncJobOwnershipLost();
  };
  try {
    await heartbeat();
    const post = await readPostRefreshTarget(owner, client);
    const url = canonicalPostUrl(post.url, post.type);
    const reel = post.type === 'reel';
    const actor = reel ? 'apify/instagram-reel-scraper' : 'apify/instagram-scraper';
    const input = reel
      ? {
          username: [url],
          resultsLimit: 1,
          includeSharesCount: false,
          includeTranscript: false,
          includeDownloadedVideo: false,
        }
      : { directUrls: [url], resultsType: 'posts', resultsLimit: 1, addParentData: false };
    const items = await executeTrackedActor(
      actor,
      input,
      {
        prepare: () => preparePostRefreshRun(owner, actor, client),
        update: (id, data) => client.providerRun.update({ where: { id }, data }),
      },
      heartbeat,
      gateway ?? createTrackedRunGateway(),
    );
    if (items.length !== 1)
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'A Apify não retornou exatamente o post solicitado',
      );
    const metric = normalizeInstagramPost(items[0], reel ? 'reel' : 'post');
    if (
      metric.id !== post.instagramPostId ||
      metric.ownerId !== post.instagramProfile.instagramId ||
      metric.type !== post.type
    )
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'O post ou autor retornado não corresponde ao solicitado',
      );
    await commitPostRefresh(owner, metric, client);
    return { status: 'succeeded' as const, jobId: job.id };
  } catch (error) {
    if (error instanceof SyncJobOwnershipLost) return { status: 'lost' as const, jobId: job.id };
    try {
      const failed = await failPostRefresh(
        owner,
        initialSyncErrorCode(error, 'POST_REFRESH_FAILED'),
        client,
      );
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
export async function runPostRefreshWorkerOnce(
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  const job =
    (await reclaimInstagramSyncJob(LEASE_MS, client, 'POST_REFRESH')) ??
    (await claimNextInstagramSyncJob(LEASE_MS, client, 'POST_REFRESH'));
  return job ? processPostRefresh(job, client, gateway) : null;
}
