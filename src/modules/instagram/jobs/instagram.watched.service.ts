import type { InstagramSyncJob, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import type { TrackedRunGateway } from '../../../provider/apify/apify.tracked-run.js';
import { processProfileBatchSync } from './instagram.daily.service.js';
import {
  readWatchedTargets,
  prepareWatchedRun,
  commitWatchedProfile,
  finishWatchedAttempt,
} from './instagram.watched.repository.js';
import { hasActiveDaily } from './instagram.watched-eligibility.repository.js';
import {
  claimNextInstagramSyncJob,
  reclaimInstagramSyncJob,
} from './instagram.sync-job.repository.js';

export function processWatchedSync(
  job: InstagramSyncJob,
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  return processProfileBatchSync(job, client, gateway, {
    kind: 'watched',
    read: readWatchedTargets,
    prepare: prepareWatchedRun,
    commit: commitWatchedProfile,
    finish: finishWatchedAttempt,
  });
}
export async function runWatchedSyncWorkerOnce(
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  // Inclui retries futuros: Watched começa depois de terminar o Daily, não entre tentativas.
  if (await hasActiveDaily(client)) return null;
  const job =
    (await reclaimInstagramSyncJob(600000, client, 'WATCHED_SYNC')) ??
    (await claimNextInstagramSyncJob(600000, client, 'WATCHED_SYNC'));
  return job ? processWatchedSync(job, client, gateway) : null;
}
