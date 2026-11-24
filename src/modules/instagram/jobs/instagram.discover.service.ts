import type { InstagramSyncJob, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import {
  executeTrackedActor,
  createTrackedRunGateway,
  type TrackedRunGateway,
} from '../../../provider/apify/apify.tracked-run.js';
import { SyncJobOwnershipLost } from './instagram.initial-sync.repository.js';
import {
  claimNextInstagramSyncJob,
  reclaimInstagramSyncJob,
  renewInstagramSyncJobLease,
} from './instagram.sync-job.repository.js';
import {
  DISCOVER_ACTOR,
  readDiscoverTarget,
  prepareDiscoverRun,
  commitDiscoverSearch,
  failDiscoverSearch,
} from './instagram.discover.repository.js';

const LEASE_MS = 600000;
export async function processDiscoverSearch(
  job: InstagramSyncJob,
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  if (job.type !== 'DISCOVER_SEARCH' || !job.lockToken) throw new Error('INVALID_DISCOVER_JOB');
  const owner = { id: job.id, lockToken: job.lockToken };
  const heartbeat = async () => {
    if (!(await renewInstagramSyncJobLease(owner, LEASE_MS, client)))
      throw new SyncJobOwnershipLost();
  };
  try {
    await heartbeat();
    const target = await readDiscoverTarget(owner, client);
    const items = await executeTrackedActor(
      DISCOVER_ACTOR,
      {
        keywords: [target.keyword],
        maxPostsPerKeyword: 50,
        postType: 'all',
        minLikes: 0,
        dateFrom: '30 days',
      },
      {
        prepare: () => prepareDiscoverRun(owner, client),
        update: (id, data) => client.providerRun.update({ where: { id }, data }),
      },
      heartbeat,
      gateway ?? createTrackedRunGateway(),
    );
    await commitDiscoverSearch(owner, items, client);
    return { status: 'succeeded' as const, jobId: job.id };
  } catch (error) {
    if (error instanceof SyncJobOwnershipLost) return { status: 'lost' as const, jobId: job.id };
    try {
      const failed = await failDiscoverSearch(owner, error, client);
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
export async function runDiscoverWorkerOnce(
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  const job =
    (await reclaimInstagramSyncJob(LEASE_MS, client, 'DISCOVER_SEARCH')) ??
    (await claimNextInstagramSyncJob(LEASE_MS, client, 'DISCOVER_SEARCH'));
  return job ? processDiscoverSearch(job, client, gateway) : null;
}
