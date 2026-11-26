import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { enqueueDailyBatch } from '../src/modules/instagram/jobs/instagram.daily.repository.js';
import {
  runDailySyncWorkerOnce,
  processDailySync,
} from '../src/modules/instagram/jobs/instagram.daily.service.js';
import { findActiveProfileSyncJob } from '../src/modules/instagram/jobs/instagram.profile-job.repository.js';
import {
  claimNextInstagramSyncJob,
  reclaimInstagramSyncJob,
} from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import { readDailyTargets } from '../src/modules/instagram/jobs/instagram.daily.repository.js';
import { SyncJobOwnershipLost } from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';
import { findProfilesForInstagramRefresh } from '../src/modules/instagram/refresh/instagram.refresh.repository.js';
import {
  getInstagramLocalDate,
  newYorkDayBounds,
} from '../src/modules/instagram/shared/instagram.snapshot-day.js';

describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Daily batching on PostgreSQL', () => {
  it('isolates owner costs, commits good profiles, resumes partial batches and applies calendar guards', async () => {
    const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!connection) throw new Error('Configure o banco de desenvolvimento');
    const namespace = `daily_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^daily_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid schema');
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
      $transaction: inSchema,
      $queryRaw: (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
        inSchema((tx) => tx.$queryRaw(query, ...values)),
    } as unknown as PrismaClient;
    const runs = new Map<string, { actor: string; input: Record<string, unknown> }>();
    let sequence = 0;
    let privateBeta = true;
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
            '20261126000000_add_profile_snapshot_source',
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
      const date = getInstagramLocalDate(now);
      const old = new Date(newYorkDayBounds(date).from.getTime() - 1000);
      await inSchema(async (tx) => {
        await tx.instagramProfile.createMany({
          data: [
            {
              id: 'alpha',
              instagramId: 'ig-alpha',
              username: 'alpha',
              ownerUserId: 'owner',
              lastSyncedAt: old,
              syncStatus: 'ready',
            },
            {
              id: 'beta',
              instagramId: 'ig-beta',
              username: 'beta',
              ownerUserId: 'owner',
              syncStatus: 'ready',
            },
            {
              id: 'other',
              instagramId: 'ig-other',
              username: 'other',
              ownerUserId: 'different-owner',
            },
            { id: 'orphan', instagramId: 'ig-orphan', username: 'orphan', ownerUserId: null },
            {
              id: 'expired',
              instagramId: 'ig-expired',
              username: 'expired',
              ownerUserId: 'owner',
              monitoringUntil: old,
            },
          ],
        });
        await tx.instagramProfileSnapshot.create({
          data: {
            instagramProfileId: 'alpha',
            followers: 1,
            following: 1,
            postsCount: 1,
            collectedAt: old,
          },
        });
        await tx.instagramPost.create({
          data: {
            id: 'old-post',
            instagramProfileId: 'alpha',
            instagramPostId: 'alpha-old',
            type: 'photo',
            timestamp: new Date('2020-01-01'),
            hashtags: [],
            images: [],
          },
        });
        await tx.instagramPostMetricSnapshot.create({
          data: { instagramPostId: 'old-post', likesCount: 9, source: null, collectedAt: old },
        });
      });
      const candidates = await inSchema((tx) => findProfilesForInstagramRefresh(now, tx));
      expect(candidates.map((p) => p.id).sort()).toEqual(['alpha', 'beta', 'other']);
      const attempts = await Promise.all([
        enqueueDailyBatch(['alpha', 'beta'], 'owner', date, client),
        enqueueDailyBatch(['alpha', 'beta'], 'owner', date, client),
      ]);
      expect(attempts.reduce((sum, item) => sum + item.queued, 0)).toBe(2);
      expect(await inSchema((tx) => tx.instagramSyncJob.count())).toBe(1);
      expect(await inSchema((tx) => findActiveProfileSyncJob('beta', tx))).toMatchObject({
        type: 'DAILY_PROFILE_SYNC',
      });
      // A mixed-owner request cannot include the other user's profile in its paid batch.
      expect(await enqueueDailyBatch(['other'], 'owner', date, client)).toMatchObject({
        queued: 0,
        notDue: 1,
      });
      expect(await runDailySyncWorkerOnce(client, gateway)).toMatchObject({
        status: 'retrying',
        updated: 1,
      });
      expect(runs.size).toBe(2);
      expect([...runs.values()][0]!.input).toEqual({ usernames: ['alpha', 'beta'] });
      const ledger = await inSchema((tx) => tx.providerRun.findMany());
      expect(ledger).toHaveLength(2);
      expect(
        ledger.every(
          (run) =>
            run.userId === 'owner' && run.instagramProfileId === null && run.trigger === 'daily',
        ),
      ).toBe(true);
      expect(ledger.reduce((sum, run) => sum + Number(run.costUsd), 0)).toBeCloseTo(0.0049, 6);
      expect(
        await inSchema((tx) =>
          tx.instagramProfileSnapshot.count({ where: { instagramProfileId: 'alpha' } }),
        ),
      ).toBe(2);
      expect(
        await inSchema((tx) =>
          tx.instagramPostMetricSnapshot.count({
            where: { instagramPost: { instagramProfileId: 'alpha' }, source: 'daily' },
          }),
        ),
      ).toBe(12);
      expect(
        await inSchema((tx) => tx.instagramPost.count({ where: { instagramPostId: 'foreign' } })),
      ).toBe(0);
      expect(
        await inSchema((tx) =>
          tx.instagramPost.count({ where: { instagramPostId: 'alpha-pinned-old' } }),
        ),
      ).toBe(0);
      const reelMetric = await inSchema((tx) =>
        tx.instagramPostMetricSnapshot.findFirstOrThrow({
          where: { instagramPost: { instagramPostId: 'alpha-reel' } },
        }),
      );
      expect(reelMetric).toMatchObject({
        likesCount: null,
        likesHidden: true,
        viewsCount: 777n,
        source: 'daily',
      });
      expect(
        await inSchema((tx) =>
          tx.instagramPostMetricSnapshot.count({ where: { instagramPostId: 'old-post' } }),
        ),
      ).toBe(1);
      const savedAlpha = await inSchema((tx) =>
        tx.instagramProfile.findUniqueOrThrow({ where: { id: 'alpha' } }),
      );
      expect(savedAlpha.lastSyncedAt!.getTime()).toBeGreaterThan(old.getTime());
      expect(await inSchema((tx) => findActiveProfileSyncJob('alpha', tx))).toBeNull();
      expect(await inSchema((tx) => findActiveProfileSyncJob('beta', tx))).not.toBeNull();
      // Recovery of the second attempt retains completed membership and the paid profile run.
      await inSchema((tx) =>
        tx.instagramSyncJob.updateMany({
          where: { status: 'PENDING' },
          data: { runAt: new Date(0) },
        }),
      );
      const claimed = await claimNextInstagramSyncJob(600000, client, 'DAILY_PROFILE_SYNC');
      if (!claimed?.lockToken) throw new Error('No lease');
      await inSchema((tx) =>
        tx.instagramSyncJob.update({
          where: { id: claimed.id },
          data: {
            lockedAt: new Date('2000-01-01T00:00:00Z'),
            leaseExpiresAt: new Date('2000-01-01T00:10:00Z'),
          },
        }),
      );
      const reclaimed = await reclaimInstagramSyncJob(600000, client, 'DAILY_PROFILE_SYNC');
      if (!reclaimed?.lockToken) throw new Error('No recovery');
      expect(reclaimed.attempts).toBe(claimed.attempts);
      await expect(
        readDailyTargets({ id: claimed.id, lockToken: claimed.lockToken }, client),
      ).rejects.toBeInstanceOf(SyncJobOwnershipLost);
      expect(await processDailySync(reclaimed, client, gateway)).toMatchObject({
        status: 'retrying',
        updated: 1,
      });
      await inSchema((tx) =>
        tx.instagramSyncJob.updateMany({
          where: { status: 'PENDING' },
          data: { runAt: new Date(0) },
        }),
      );
      expect(await runDailySyncWorkerOnce(client, gateway)).toMatchObject({
        status: 'failed',
        updated: 1,
      });
      expect(runs.size).toBe(2);
      expect(
        (await inSchema((tx) => tx.instagramProfile.findUniqueOrThrow({ where: { id: 'alpha' } })))
          .lastSyncedAt,
      ).toEqual(savedAlpha.lastSyncedAt);
      expect(
        (await inSchema((tx) => tx.instagramProfile.findUniqueOrThrow({ where: { id: 'beta' } })))
          .syncStatus,
      ).toBe('ready');
      expect(await enqueueDailyBatch(['beta'], 'owner', date, client)).toMatchObject({
        queued: 0,
        reused: 1,
      });
      privateBeta = false;
      expect(
        await enqueueDailyBatch(
          ['alpha', 'beta'],
          'owner',
          getInstagramLocalDate(new Date(now.getTime() + 86400000)),
          client,
        ),
      ).toMatchObject({ queued: 2, notDue: 0 });
      expect(await runDailySyncWorkerOnce(client, gateway)).toMatchObject({
        status: 'succeeded',
        updated: 1,
      });
      expect(runs.size).toBe(3);
      expect(
        await inSchema((tx) =>
          tx.instagramPostMetricSnapshot.count({
            where: { instagramPost: { instagramProfileId: 'beta' }, source: 'daily' },
          }),
        ),
      ).toBe(12);
      // Monitoring is checked again at execution, not just when the job was queued.
      expect(await enqueueDailyBatch(['other'], 'different-owner', date, client)).toMatchObject({
        queued: 1,
      });
      await inSchema((tx) =>
        tx.instagramProfile.update({ where: { id: 'other' }, data: { monitoringUntil: old } }),
      );
      expect(await runDailySyncWorkerOnce(client, gateway)).toMatchObject({
        status: 'succeeded',
        updated: 0,
      });
      expect(runs.size).toBe(3);
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
  }, 240000);
});
