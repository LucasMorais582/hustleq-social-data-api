import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  enqueueDailyBatch,
  prepareDailyRun,
} from '../src/modules/instagram/jobs/instagram.daily.repository.js';
import {
  enqueueWatchedBatch,
  readWatchedTargets,
} from '../src/modules/instagram/jobs/instagram.watched.repository.js';
import { findWatchedCandidates } from '../src/modules/instagram/jobs/instagram.watched-eligibility.repository.js';
import {
  runWatchedSyncWorkerOnce,
  processWatchedSync,
} from '../src/modules/instagram/jobs/instagram.watched.service.js';
import { findActiveProfileSyncJob } from '../src/modules/instagram/jobs/instagram.profile-job.repository.js';
import {
  claimNextInstagramSyncJob,
  reclaimInstagramSyncJob,
} from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import { SyncJobOwnershipLost } from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';

describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Watched batches on PostgreSQL', () => {
  it('deduplicates shared targets, fences recovery and respects source eligibility and Daily attempts', async () => {
    const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!connection) throw new Error('Configure o banco de desenvolvimento');
    const namespace = `watched_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^watched_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid schema');
    const url = new URL(connection);
    url.searchParams.set('schema', namespace);
    url.searchParams.set('connection_limit', '6');
    const base = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
    const inSchema = <T>(
      work: (tx: Prisma.TransactionClient) => Promise<T>,
      options: {
        timeout?: number;
        maxWait?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      } = {},
    ) =>
      base.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
          return work(tx);
        },
        { timeout: 30000, maxWait: 10000, ...options },
      );
    const client = {
      providerRun: base.providerRun,
      instagramSyncJob: base.instagramSyncJob,
      $transaction: inSchema,
      $queryRaw: (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
        inSchema((tx) => tx.$queryRaw(query, ...values)),
    } as unknown as PrismaClient;
    const runs = new Map<string, { actor: string; input: Record<string, unknown> }>();
    let sequence = 0;
    const privateBeta = false;
    const post = (name: string, i: number) => ({
      id: `${name}-post-${i}`,
      ownerId: `ig-${name}`,
      ownerUsername: name,
      type: 'Image',
      shortCode: `${name}_${i}`,
      timestamp: new Date(Date.now() - (i + 1) * 60000).toISOString(),
      likesCount: i,
      commentsCount: 0,
      videoPlayCount: 999,
    });
    const reel = {
      id: 'alpha-reel',
      ownerId: 'ig-alpha',
      ownerUsername: 'alpha',
      type: 'Video',
      productType: 'clips',
      shortCode: 'Alpha_Reel',
      timestamp: new Date().toISOString(),
      likesCount: -1,
      commentsCount: null,
      videoPlayCount: 777,
    };
    const rawProfile = (name: string) =>
      name === 'beta' && privateBeta
        ? { id: 'ig-beta', username: 'beta', private: true }
        : {
            id: `ig-${name}`,
            username: name,
            fullName: name,
            followersCount: 42,
            followsCount: 5,
            postsCount: 100,
            latestPosts: [
              ...Array.from({ length: 15 }, (_, i) => post(name, i)),
              ...(name === 'alpha' ? [reel] : []),
              { ...post(name, 99), id: `${name}-pinned-old`, timestamp: '2020-01-01T00:00:00Z' },
              { ...post(name, 0), id: 'foreign', ownerId: 'somebody-else' },
            ],
          };
    const gateway = {
      start: async (actor: string, input: Record<string, unknown>) => {
        const id = `run-${++sequence}`;
        runs.set(id, { actor, input });
        return { id, status: 'RUNNING' };
      },
      get: async (id: string) => ({
        id,
        status: 'SUCCEEDED',
        defaultDatasetId: id,
        usageTotalUsd: runs.get(id)!.actor.includes('profile') ? 0.0023 : 0.0026,
      }),
      items: async (id: string) => {
        const run = runs.get(id)!;
        const items = run.actor.includes('profile')
          ? (run.input.usernames as string[]).map(rawProfile)
          : [reel];
        return { items, total: items.length };
      },
    };
    let created = false;
    try {
      await base.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
          for (const migration of [
            '20261117000000_create_instagram_models',
            '20261119000000_add_mvp_tracking_and_cache',
            '20261123000000_add_instagram_sync_jobs',
          ]) {
            const sql = await readFile(
              new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url),
              'utf8',
            );
            for (const statement of sql
              .replace(/^--.*$/gm, '')
              .split(';')
              .map((p) => p.trim())
              .filter(Boolean)) {
              if (
                /^(BEGIN|COMMIT)$/i.test(statement) ||
                /^CREATE SCHEMA IF NOT EXISTS "public"$/i.test(statement)
              )
                continue;
              await tx.$executeRawUnsafe(statement);
            }
          }
        },
        { timeout: 30000, maxWait: 10000 },
      );
      created = true;
      const now = new Date();
      const old = new Date(now.getTime() - 21 * 3600000);
      await inSchema(async (tx) => {
        await tx.instagramProfile.createMany({
          data: [
            { id: 'one', instagramId: 'ig-one', username: 'one', ownerUserId: 'u1' },
            { id: 'same', instagramId: 'ig-same', username: 'same', ownerUserId: 'u1' },
            { id: 'two', instagramId: 'ig-two', username: 'two', ownerUserId: 'u2' },
            {
              id: 'paused',
              instagramId: 'ig-paused',
              username: 'paused',
              ownerUserId: 'u3',
              monitoringUntil: old,
            },
            { id: 'orphan', instagramId: 'ig-orphan', username: 'orphan' },
            {
              id: 'alpha',
              instagramId: 'ig-alpha',
              username: 'alpha',
              monitoringUntil: old,
              syncStatus: 'ready',
            },
            { id: 'beta', instagramId: 'ig-beta', username: 'beta', syncStatus: 'ready' },
            { id: 'ended', instagramId: 'ig-ended', username: 'ended' },
            {
              id: 'daily',
              instagramId: 'ig-daily',
              username: 'daily',
              ownerUserId: 'daily-owner',
              syncStatus: 'ready',
            },
          ],
        });
        await tx.instagramCompetitor.createMany({
          data: [
            { id: 'one-alpha', instagramProfileId: 'one', competitorProfileId: 'alpha' },
            { id: 'same-alpha', instagramProfileId: 'same', competitorProfileId: 'alpha' },
            { id: 'two-alpha', instagramProfileId: 'two', competitorProfileId: 'alpha' },
            { id: 'one-beta', instagramProfileId: 'one', competitorProfileId: 'beta' },
            { id: 'two-beta', instagramProfileId: 'two', competitorProfileId: 'beta' },
            { instagramProfileId: 'one', competitorProfileId: 'ended', endedAt: now },
            { instagramProfileId: 'paused', competitorProfileId: 'ended' },
            { instagramProfileId: 'orphan', competitorProfileId: 'ended' },
            { instagramProfileId: 'one', competitorProfileId: 'daily' },
          ],
        });
      });
      expect(await inSchema((tx) => findWatchedCandidates(now, tx))).toEqual(
        expect.arrayContaining([
          { id: 'alpha', userId: null },
          { id: 'beta', userId: null },
          { id: 'daily', userId: 'u1' },
        ]),
      );
      expect(
        (await inSchema((tx) => findWatchedCandidates(now, tx))).some((p) => p.id === 'ended'),
      ).toBe(false);
      const queued = await Promise.all([
        enqueueWatchedBatch(['alpha', 'beta'], null, '2026-11-24', client),
        enqueueWatchedBatch(['alpha', 'beta'], null, '2026-11-24', client),
      ]);
      expect(queued.reduce((sum, r) => sum + r.queued, 0)).toBe(2);
      expect(
        await inSchema((tx) => tx.instagramSyncJob.count({ where: { type: 'WATCHED_SYNC' } })),
      ).toBe(1);
      expect(await inSchema((tx) => findActiveProfileSyncJob('beta', tx))).toMatchObject({
        type: 'WATCHED_SYNC',
      });
      // A changed payer must not release the still-active target reservation for a second batch.
      await inSchema((tx) =>
        tx.instagramCompetitor.update({ where: { id: 'two-alpha' }, data: { endedAt: now } }),
      );
      expect(await enqueueWatchedBatch(['alpha'], 'u1', '2026-11-24', client)).toMatchObject({
        queued: 0,
        reused: 1,
      });
      await inSchema((tx) =>
        tx.instagramCompetitor.update({ where: { id: 'two-alpha' }, data: { endedAt: null } }),
      );
      // A Daily prepared-but-failed attempt must not gain three additional paid Watched attempts.
      await enqueueDailyBatch(['daily'], 'daily-owner', '2026-11-24', client);
      expect(await runWatchedSyncWorkerOnce(client, gateway)).toBeNull();
      expect(await enqueueWatchedBatch(['daily'], 'u1', '2026-11-24', client)).toMatchObject({
        queued: 1,
      });
      const daily = await claimNextInstagramSyncJob(600000, client, 'DAILY_PROFILE_SYNC');
      if (!daily?.lockToken) throw new Error('Missing Daily lease');
      await prepareDailyRun(
        { id: daily.id, lockToken: daily.lockToken },
        'profile',
        'actor',
        ['daily'],
        client,
      );
      await inSchema((tx) =>
        tx.instagramSyncJob.update({
          where: { id: daily.id },
          data: {
            status: 'FAILED',
            activeKey: null,
            lockToken: null,
            lockedAt: null,
            leaseExpiresAt: null,
            finishedAt: now,
          },
        }),
      );
      expect(await enqueueWatchedBatch(['daily'], 'u1', '2026-11-24', client)).toMatchObject({
        queued: 0,
        reused: 1,
      });
      // Once Daily attempted it, the queued Watched is completed without any new Actor.
      const blocked = await claimNextInstagramSyncJob(600000, client, 'WATCHED_SYNC');
      // The shared batch was queued first and must run before the skipped target.
      if (!blocked?.lockToken || blocked.instagramProfileId !== 'alpha')
        throw new Error('Unexpected queue order');
      const reservedShared = blocked;
      // Expired worker rotates the token, preserves attempt and cannot write with its old lease.
      const claimed = reservedShared;
      if (!claimed?.lockToken) throw new Error('Missing Watched lease');
      await inSchema((tx) =>
        tx.instagramSyncJob.update({
          where: { id: claimed.id },
          data: {
            lockedAt: new Date('2000-01-01T00:00:00Z'),
            leaseExpiresAt: new Date('2000-01-01T00:10:00Z'),
          },
        }),
      );
      const recovered = await reclaimInstagramSyncJob(600000, client, 'WATCHED_SYNC');
      if (!recovered?.lockToken) throw new Error('Missing recovery');
      expect(recovered.attempts).toBe(claimed.attempts);
      await expect(
        readWatchedTargets({ id: claimed.id, lockToken: claimed.lockToken }, client),
      ).rejects.toBeInstanceOf(SyncJobOwnershipLost);
      expect(await processWatchedSync(recovered, client, gateway)).toMatchObject({
        status: 'succeeded',
        updated: 2,
      });
      expect(runs.size).toBe(2);
      expect([...runs.values()][0]!.input).toEqual({ usernames: ['alpha', 'beta'] });
      const ledger = await inSchema((tx) =>
        tx.providerRun.findMany({ where: { trigger: 'watched' } }),
      );
      expect(ledger).toHaveLength(2);
      expect(ledger.every((r) => r.userId === null && r.instagramProfileId === null)).toBe(true);
      expect(ledger.reduce((sum, r) => sum + Number(r.costUsd), 0)).toBeCloseTo(0.0049, 6);
      expect(
        await inSchema((tx) =>
          tx.instagramPostMetricSnapshot.count({ where: { source: 'daily' } }),
        ),
      ).toBe(24);
      expect(
        await inSchema((tx) =>
          tx.instagramProfileSnapshot.count({
            where: { instagramProfileId: { in: ['alpha', 'beta'] } },
          }),
        ),
      ).toBe(2);
      expect(
        await enqueueWatchedBatch(['alpha', 'beta'], null, '2026-11-24', client),
      ).toMatchObject({ queued: 0, notDue: 2 });
      expect(await runWatchedSyncWorkerOnce(client, gateway)).toMatchObject({
        status: 'succeeded',
        updated: 0,
      });
      expect(runs.size).toBe(2);
      // Removing every active source after enqueue prevents any subsequent Actor call or data change.
      await inSchema(async (tx) => {
        await tx.instagramProfile.update({ where: { id: 'beta' }, data: { lastSyncedAt: old } });
        await tx.instagramCompetitor.update({ where: { id: 'two-beta' }, data: { endedAt: now } });
      });
      expect(await enqueueWatchedBatch(['beta'], 'u1', '2026-11-25', client)).toMatchObject({
        queued: 1,
      });
      await inSchema((tx) =>
        tx.instagramCompetitor.update({ where: { id: 'one-beta' }, data: { endedAt: now } }),
      );
      expect(await runWatchedSyncWorkerOnce(client, gateway)).toMatchObject({
        status: 'succeeded',
        updated: 0,
      });
      expect(runs.size).toBe(2);
      expect(
        await inSchema((tx) =>
          tx.instagramPostMetricSnapshot.count({ where: { source: 'daily' } }),
        ),
      ).toBe(24);
    } finally {
      try {
        if (created) await base.$executeRawUnsafe(`DROP SCHEMA "${namespace}" CASCADE`);
        const [result] = await base.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${namespace}) AS present`;
        expect(result?.present).toBe(false);
      } finally {
        await base.$disconnect();
      }
    }
  }, 300000);
});
