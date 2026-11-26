import type { InstagramSyncJob, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { ProviderError } from '../../../errors/provider.error.js';
import {
  createTrackedRunGateway,
  executeTrackedActor,
  type TrackedRunGateway,
} from '../../../provider/apify/apify.tracked-run.js';
import {
  initialProfileCollection,
  initialReelUrls,
  initialSyncErrorCode,
} from './instagram.initial-sync.service.js';
import { SyncJobOwnershipLost } from './instagram.initial-sync.repository.js';
import {
  readDailyTargets,
  prepareDailyRun,
  commitDailyProfile,
  finishDailyAttempt,
} from './instagram.daily.repository.js';
import {
  claimNextInstagramSyncJob,
  reclaimInstagramSyncJob,
  renewInstagramSyncJobLease,
} from './instagram.sync-job.repository.js';
import { normalizeInstagramPost } from '../shared/instagram.post.normalize.js';

const LEASE_MS = 600000;
type ProfileBatchStore = {
  kind: 'daily' | 'watched';
  read: typeof readDailyTargets;
  prepare: typeof prepareDailyRun;
  commit: typeof commitDailyProfile;
  finish: typeof finishDailyAttempt;
};
export async function processProfileBatchSync(
  job: InstagramSyncJob,
  client: PrismaClient = getPrismaClient(),
  gateway: TrackedRunGateway | undefined,
  store: ProfileBatchStore,
) {
  const expectedType = store.kind === 'daily' ? 'DAILY_PROFILE_SYNC' : 'WATCHED_SYNC';
  if (job.type !== expectedType || !job.lockToken) throw new Error('INVALID_DAILY_JOB');
  const owner = { id: job.id, lockToken: job.lockToken };
  const heartbeat = async () => {
    if (!(await renewInstagramSyncJobLease(owner, LEASE_MS, client)))
      throw new SyncJobOwnershipLost();
  };
  const failures: Record<string, string> = {};
  try {
    await heartbeat();
    const targets = await store.read(owner, client);
    let transport: TrackedRunGateway;
    const execute = (
      step: 'profile' | 'reels',
      actor: string,
      input: Record<string, unknown>,
      ids: string[],
    ) =>
      executeTrackedActor(
        actor,
        input,
        {
          prepare: () => store.prepare(owner, step, actor, ids, client),
          update: (id, data) => client.providerRun.update({ where: { id }, data }),
        },
        heartbeat,
        transport,
      );
    if (targets.length) {
      transport = gateway ?? createTrackedRunGateway();
      const profiles = await execute(
        'profile',
        'apify/instagram-profile-scraper',
        { usernames: targets.map((p) => p.username) },
        targets.map((p) => p.id),
      );
      const selected = [];
      for (const target of targets) {
        const matches = profiles.filter(
          (raw) =>
            raw &&
            typeof raw === 'object' &&
            (('id' in raw && raw.id === target.instagramId) ||
              ('username' in raw &&
                typeof raw.username === 'string' &&
                raw.username.replace(/^@/, '').toLowerCase() === target.username.toLowerCase())),
        );
        try {
          if (matches.length !== 1)
            throw new ProviderError(
              503,
              'PROVIDER_INVALID_RESPONSE',
              'Perfil ausente ou duplicado na coleta em lote',
            );
          const collection = initialProfileCollection(
            matches[0],
            target.instagramId,
            [],
            new Date(),
          );
          selected.push({ target, raw: matches[0], collection });
        } catch (error) {
          failures[target.id] = initialSyncErrorCode(error, 'DAILY_PROFILE_INVALID');
        }
      }
      const urls = [...new Set(selected.flatMap((p) => initialReelUrls(p.collection)))];
      const expectedReels = new Map(
        selected.flatMap((p) =>
          p.collection.posts
            .filter((post) => post.type === 'reel')
            .map((post) => [post.instagramPostId, p.target.instagramId] as const),
        ),
      );
      const rawReels = urls.length
        ? await execute(
            'reels',
            'apify/instagram-reel-scraper',
            {
              username: urls,
              resultsLimit: 1,
              includeSharesCount: false,
              includeTranscript: false,
              includeDownloadedVideo: false,
            },
            [...expectedReels.keys()],
          )
        : [];
      const byOwner = new Map<string, unknown[]>();
      for (const raw of rawReels) {
        if (!raw || typeof raw !== 'object')
          throw new ProviderError(503, 'PROVIDER_INVALID_RESPONSE', 'Formato de Reel inválido');
        if ('error' in raw && raw.error) normalizeInstagramPost(raw, 'reel');
        if (!('id' in raw) || typeof raw.id !== 'string')
          throw new ProviderError(503, 'PROVIDER_INVALID_RESPONSE', 'Reel sem identificação');
        if (!expectedReels.has(raw.id)) continue;
        const reel = normalizeInstagramPost(raw, 'reel');
        if (reel.ownerId !== expectedReels.get(raw.id))
          throw new ProviderError(
            503,
            'PROVIDER_INVALID_RESPONSE',
            'O Reel pertence a outro autor',
          );
        const list = byOwner.get(reel.ownerId!) ?? [];
        list.push(raw);
        byOwner.set(reel.ownerId!, list);
      }
      for (const entry of selected) {
        await heartbeat();
        const collection = initialProfileCollection(
          entry.raw,
          entry.target.instagramId,
          byOwner.get(entry.target.instagramId) ?? [],
          new Date(),
        );
        await store.commit(
          owner,
          entry.target.id,
          {
            ...collection,
            metricSource: 'daily',
            profileSnapshotCadence: 'new-york-day',
          },
          client,
        );
      }
    }
    const result = await store.finish(owner, failures, undefined, client);
    return {
      status:
        result.status === 'SUCCEEDED'
          ? ('succeeded' as const)
          : result.status === 'FAILED'
            ? ('failed' as const)
            : ('retrying' as const),
      jobId: job.id,
      updated: result.updated,
    };
  } catch (error) {
    if (error instanceof SyncJobOwnershipLost) return { status: 'lost' as const, jobId: job.id };
    try {
      const result = await store.finish(
        owner,
        failures,
        initialSyncErrorCode(
          error,
          store.kind === 'daily' ? 'DAILY_SYNC_FAILED' : 'WATCHED_SYNC_FAILED',
        ),
        client,
      );
      return {
        status:
          result.status === 'FAILED'
            ? ('failed' as const)
            : result.status === 'SUCCEEDED'
              ? ('succeeded' as const)
              : ('retrying' as const),
        jobId: job.id,
        updated: result.updated,
      };
    } catch (failure) {
      if (failure instanceof SyncJobOwnershipLost)
        return { status: 'lost' as const, jobId: job.id };
      throw failure;
    }
  }
}
export function processDailySync(
  job: InstagramSyncJob,
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  return processProfileBatchSync(job, client, gateway, {
    kind: 'daily',
    read: readDailyTargets,
    prepare: prepareDailyRun,
    commit: commitDailyProfile,
    finish: finishDailyAttempt,
  });
}
export async function runDailySyncWorkerOnce(
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  const job =
    (await reclaimInstagramSyncJob(LEASE_MS, client, 'DAILY_PROFILE_SYNC')) ??
    (await claimNextInstagramSyncJob(LEASE_MS, client, 'DAILY_PROFILE_SYNC'));
  return job ? processDailySync(job, client, gateway) : null;
}
