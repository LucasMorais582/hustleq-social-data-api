import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { authHeaders } from './helpers/auth.js';
import reel from './fixtures/instagram/reel-documentation-sample.json' with { type: 'json' };
import type * as Tracked from '../src/provider/apify/apify.tracked-run.js';
const state = vi.hoisted(() => ({ client: undefined as unknown, gateway: vi.fn() }));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => state.client,
}));
vi.mock('../src/provider/apify/apify.tracked-run.js', async (original) => ({
  ...(await original<typeof Tracked>()),
  createTrackedRunGateway: state.gateway,
}));
import { buildApp } from '../src/app.js';
import { runPostRefreshWorkerOnce } from '../src/modules/instagram/jobs/instagram.post-refresh.service.js';
import { requestStoredPostRefresh } from '../src/modules/instagram/post/instagram.post.refresh.repository.js';
import { claimNextInstagramSyncJob } from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import {
  withOwnedSync,
  SyncJobOwnershipLost,
} from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';

describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Post Refresh on PostgreSQL', () => {
  it('deduplicates concurrent requests, persists snapshots atomically and enforces UTC quota across posts', async () => {
    const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!connection) throw new Error('Configure o banco de desenvolvimento');
    const namespace = `post_refresh_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^post_refresh_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid schema');
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
    state.client = client;
    const g = {
      start: vi.fn().mockResolvedValue({ id: 'apify-run', status: 'RUNNING' }),
      get: vi.fn().mockResolvedValue({
        id: 'apify-run',
        status: 'SUCCEEDED',
        defaultDatasetId: 'dataset',
        usageTotalUsd: 0.0026,
      }),
      items: vi.fn().mockResolvedValue({ items: [reel], total: 1 }),
    };
    state.gateway.mockReturnValue(g);
    const app = buildApp();
    let created = false;
    const headers = authHeaders({ sub: 'owner' });
    const path = '/api/v1/instagram/posts/post';
    const refresh = (postId = 'post') =>
      app.inject({ method: 'POST', url: `/api/v1/instagram/posts/${postId}/refresh`, headers });
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
      await inSchema(async (tx) => {
        await tx.instagramProfile.create({
          data: {
            id: 'profile',
            instagramId: reel.ownerId,
            username: 'owner',
            ownerUserId: 'owner',
          },
        });
        for (const [id, external, type] of [
          ['post', reel.id, 'reel'],
          ['post-two', 'second', 'photo'],
          ['post-three', 'third', 'photo'],
        ] as const)
          await tx.instagramPost.create({
            data: {
              id,
              instagramProfileId: 'profile',
              instagramPostId: external,
              type,
              url: `https://www.instagram.com/p/${reel.shortCode}/`,
              hashtags: [],
              images: [],
              caption: 'unchanged content',
            },
          });
        await tx.instagramPostMetricSnapshot.create({
          data: {
            instagramPostId: 'post',
            likesCount: 4,
            likesHidden: false,
            commentsCount: 2,
            viewsCount: 5n,
            source: null,
            collectedAt: new Date('2020-01-01'),
          },
        });
      });
      const first = await app.inject({ url: path, headers });
      expect(first.statusCode, first.body).toBe(202);
      expect(first.json().post.metrics.likesCount).toBe(4);
      const duplicate = await Promise.all([refresh(), app.inject({ url: path, headers })]);
      expect(duplicate.every((result) => result.statusCode === 202)).toBe(true);
      expect(await inSchema((tx) => tx.instagramSyncJob.count())).toBe(1);
      expect(g.start).not.toHaveBeenCalled();
      expect(await runPostRefreshWorkerOnce(client, g)).toMatchObject({ status: 'succeeded' });
      const metrics = await inSchema((tx) =>
        tx.instagramPostMetricSnapshot.findMany({
          where: { instagramPostId: 'post' },
          orderBy: { collectedAt: 'asc' },
        }),
      );
      expect(metrics).toHaveLength(2);
      expect(metrics[0]).toMatchObject({ likesCount: 4, source: null });
      expect(metrics[1]).toMatchObject({
        likesCount: null,
        likesHidden: true,
        viewsCount: BigInt(reel.videoPlayCount),
        source: 'on_open',
      });
      expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
      const saved = await inSchema((tx) =>
        tx.instagramPost.findUniqueOrThrow({ where: { id: 'post' } }),
      );
      expect(saved.caption).toBe('unchanged content');
      expect(saved.lastCollectedAt).toEqual(metrics[1]!.collectedAt);
      expect((await refresh()).statusCode).toBe(202);
      expect((await refresh()).statusCode).toBe(202);
      // Paid failures retry three times, preserve historical snapshots and still consume one quota unit.
      g.get.mockResolvedValue({
        id: 'apify-run',
        status: 'FAILED',
        statusMessage: 'provider failure',
      } as never);
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(await runPostRefreshWorkerOnce(client, g)).toMatchObject({
          status: attempt === 3 ? 'failed' : 'retrying',
        });
        if (attempt < 3)
          await inSchema((tx) =>
            tx.instagramSyncJob.updateMany({
              where: { status: 'PENDING' },
              data: { runAt: new Date(0) },
            }),
          );
      }
      expect(await inSchema((tx) => tx.instagramPostMetricSnapshot.count())).toBe(2);
      expect(
        (await inSchema((tx) => tx.instagramPost.findUniqueOrThrow({ where: { id: 'post' } })))
          .lastCollectedAt,
      ).toEqual(saved.lastCollectedAt);
      const [clock] = await inSchema(
        (tx) => tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`,
      );
      if (!clock) throw new Error('No clock');
      const start = new Date(clock.now);
      start.setUTCHours(0, 0, 0, 0);
      await inSchema(async (tx) => {
        const count = await tx.instagramSyncJob.count({
          where: { userId: 'owner', trigger: 'refresh', createdAt: { gte: start } },
        });
        for (let i = count; i < 9; i++)
          await tx.instagramSyncJob.create({
            data: {
              type: 'POST_REFRESH',
              status: 'FAILED',
              trigger: 'refresh',
              instagramPostId: 'post',
              userId: 'owner',
              attempts: 3,
              finishedAt: clock.now,
              createdAt: clock.now,
              lastError: 'TEST_FAILURE',
            },
          });
        // Yesterday's task must not consume today's quota.
        await tx.instagramSyncJob.create({
          data: {
            type: 'POST_REFRESH',
            status: 'FAILED',
            trigger: 'refresh',
            instagramPostId: 'post',
            userId: 'owner',
            attempts: 3,
            finishedAt: clock.now,
            createdAt: new Date(start.getTime() - 1),
            lastError: 'TEST_FAILURE',
          },
        });
      });
      const quota = await Promise.all([refresh('post-two'), refresh('post-three')]);
      expect(quota.map((result) => result.statusCode).sort()).toEqual([202, 429]);
      expect(quota.find((result) => result.statusCode === 429)!.json().error.code).toBe(
        'MANUAL_REFRESH_LIMIT_REACHED',
      );
      const accepted = quota[0]!.statusCode === 202 ? 'post-two' : 'post-three';
      expect((await refresh(accepted)).statusCode).toBe(202); // Dedup bypasses exhausted quota.
      expect(
        (await app.inject({ url: path, headers: authHeaders({ sub: 'intruder' }) })).statusCode,
      ).toBe(403);
      // Missing posts cannot consume quota or create a task.
      const beforeJobs = await inSchema((tx) => tx.instagramSyncJob.count());
      await expect(
        requestStoredPostRefresh('missing', 'owner', 'refresh', 10, client),
      ).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
      expect(await inSchema((tx) => tx.instagramSyncJob.count())).toBe(beforeJobs);
      // A transaction that loses its lease must roll back its post changes.
      await inSchema((tx) =>
        tx.instagramSyncJob.updateMany({
          where: { status: 'PENDING' },
          data: { runAt: new Date(0) },
        }),
      );
      const leased = await claimNextInstagramSyncJob(5000, client, 'POST_REFRESH');
      if (!leased?.lockToken) throw new Error('No job');
      await expect(
        withOwnedSync(
          { id: leased.id, lockToken: leased.lockToken },
          async (tx) => {
            await tx.instagramPost.update({
              where: { id: accepted },
              data: { caption: 'must rollback' },
            });
            await tx.$queryRaw`SELECT 1 AS waited FROM pg_sleep(5.1)`;
          },
          client,
          'POST_REFRESH',
        ),
      ).rejects.toBeInstanceOf(SyncJobOwnershipLost);
      expect(
        (await inSchema((tx) => tx.instagramPost.findUniqueOrThrow({ where: { id: accepted } })))
          .caption,
      ).toBe('unchanged content');
    } finally {
      await app.close();
      try {
        if (created) await base.$executeRawUnsafe(`DROP SCHEMA "${namespace}" CASCADE`);
        const [result] = await base.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${namespace}) AS present`;
        expect(result?.present).toBe(false);
      } finally {
        await base.$disconnect();
        state.client = undefined;
      }
    }
  }, 240000);
});
