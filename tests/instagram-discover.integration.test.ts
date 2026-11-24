import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { authHeaders } from './helpers/auth.js';
import type * as Tracked from '../src/provider/apify/apify.tracked-run.js';
const state = vi.hoisted(() => ({ client: undefined as unknown, factory: vi.fn() }));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => state.client,
}));
vi.mock('../src/provider/apify/apify.tracked-run.js', async (original) => ({
  ...(await original<typeof Tracked>()),
  createTrackedRunGateway: state.factory,
}));
import { buildApp } from '../src/app.js';
import {
  runDiscoverWorkerOnce,
  processDiscoverSearch,
} from '../src/modules/instagram/jobs/instagram.discover.service.js';
import { beginDiscover } from '../src/modules/instagram/discover/instagram.discover.repository.js';
import { discoverKey } from '../src/modules/instagram/discover/instagram.discover.schemas.js';
import { commitDiscoverSearch } from '../src/modules/instagram/jobs/instagram.discover.repository.js';
import {
  claimNextInstagramSyncJob,
  reclaimInstagramSyncJob,
} from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import { SyncJobOwnershipLost } from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';

describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')(
  'Discover HTTP and worker on PostgreSQL',
  () => {
    it('shares cache misses, attributes runs once, keeps expired data on failure and fences obsolete workers', async () => {
      const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
      if (!connection) throw new Error('Configure o banco de desenvolvimento');
      const namespace = `discover_test_${randomUUID().replaceAll('-', '')}`;
      if (!/^discover_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid schema');
      const url = new URL(connection);
      url.searchParams.set('schema', namespace);
      url.searchParams.set('connection_limit', '8');
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
      const runs = new Map<string, string>();
      let sequence = 0;
      let fail = false;
      let empty = false;
      const gateway = {
        start: vi.fn().mockImplementation(async (_actor: string, input: { keywords: string[] }) => {
          const id = `run-${++sequence}`;
          runs.set(id, input.keywords[0]!);
          return { id, status: 'RUNNING' };
        }),
        get: vi.fn().mockImplementation(async (id: string) => ({
          id,
          status: fail ? 'FAILED' : 'SUCCEEDED',
          statusMessage: fail ? 'Free tier: please wait 29 more minutes' : undefined,
          defaultDatasetId: id,
          usageTotalUsd: 0.006,
        })),
        items: vi.fn().mockImplementation(async (id: string) => ({
          items: empty
            ? []
            : [
                {
                  recordType: 'post',
                  postId: '90071992547409939999',
                  keyword: runs.get(id),
                  shortcode: 'ABC',
                  type: 'reel',
                  takenAt: new Date().toISOString(),
                  ownerUsername: 'Example',
                  ownerFullName: 'Example',
                  likeCount: 0,
                  commentCount: null,
                  playCount: 123,
                  hashtags: ['4', '#RJ'],
                  locationName: null,
                },
              ],
          total: empty ? 0 : 1,
        })),
      };
      state.factory.mockReturnValue(gateway);
      const app = buildApp();
      let created = false;
      const path = '/api/v1/instagram/discover?niche=Food&city=Newark';
      const headers = (sub: string) => authHeaders({ sub });
      const waitForJob = async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const job = await inSchema((tx) =>
            tx.instagramSyncJob.findFirst({
              where: { type: 'DISCOVER_SEARCH', status: 'PENDING' },
            }),
          );
          if (job) return job;
          await setTimeout(10);
        }
        throw new Error('Discover task was not enqueued');
      };
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
        const first = app.inject({ url: path, headers: headers('first') }).then((result) => result);
        const other = app
          .inject({
            url: '/api/v1/instagram/discover?niche=%20FOOD%20&city=NEWARK&query=%20',
            headers: headers('other'),
          })
          .then((result) => result);
        const job = await waitForJob();
        expect(await inSchema((tx) => tx.instagramSyncJob.count())).toBe(1);
        expect(await runDiscoverWorkerOnce(client, gateway)).toMatchObject({ status: 'succeeded' });
        const responses = await Promise.all([first, other]);
        expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
        expect(responses.map((r) => r.json().fromCache).sort()).toEqual([false, true]);
        expect(responses[0]!.json().posts[0]).toMatchObject({
          instagramPostId: '90071992547409939999',
          likesCount: 0,
          hashtags: ['rj'],
          ownerUsername: 'example',
        });
        expect(gateway.start).toHaveBeenCalledTimes(1);
        const run = await inSchema((tx) => tx.providerRun.findFirstOrThrow());
        expect(run.userId).toBe(job.userId);
        expect(run.trigger).toBe('discover');
        expect(run.costUsd?.toFixed(6)).toBe('0.006000');
        const hit = await app.inject({ url: path, headers: headers('third') });
        expect(hit.statusCode).toBe(200);
        expect(hit.json().fromCache).toBe(true);
        expect(gateway.start).toHaveBeenCalledTimes(1);
        expect(await inSchema((tx) => tx.instagramProfile.count())).toBe(0);
        expect(await inSchema((tx) => tx.instagramPost.count())).toBe(0);
        expect(await inSchema((tx) => tx.instagramProfileSnapshot.count())).toBe(0);
        // A service warm-up has no fictional user assignment.
        const warm = app
          .inject({
            url: path.replace('Newark', 'Boston'),
            headers: authHeaders({ sub: 'hustleq-main', scope: 'service' }),
          })
          .then((result) => result);
        await waitForJob();
        expect(await runDiscoverWorkerOnce(client, gateway)).toMatchObject({ status: 'succeeded' });
        expect((await warm).json().fromCache).toBe(false);
        expect(await inSchema((tx) => tx.providerRun.count({ where: { userId: null } }))).toBe(1);
        // Expired cache is neither returned nor overwritten if the next three attempts fail.
        const key = discoverKey({ niche: 'food', city: 'newark', query: null });
        await inSchema((tx) =>
          tx.discoverCache.update({
            where: { key },
            data: { fetchedAt: new Date(Date.now() - 86400000) },
          }),
        );
        const expired = await inSchema((tx) =>
          tx.discoverCache.findUniqueOrThrow({ where: { key } }),
        );
        fail = true;
        const failing = app
          .inject({ url: path, headers: headers('retry-user') })
          .then((result) => result);
        await waitForJob();
        for (let i = 1; i <= 3; i++) {
          expect(await runDiscoverWorkerOnce(client, gateway)).toMatchObject({
            status: i === 3 ? 'failed' : 'retrying',
          });
          if (i < 3)
            await inSchema((tx) =>
              tx.instagramSyncJob.updateMany({
                where: { status: 'PENDING', type: 'DISCOVER_SEARCH' },
                data: { runAt: new Date(0) },
              }),
            );
        }
        const failure = await failing;
        expect(failure.statusCode, failure.body).toBe(429);
        expect(failure.json().error.message).toContain('please wait');
        expect(failure.json()).not.toHaveProperty('posts');
        expect(
          await inSchema((tx) => tx.discoverCache.findUniqueOrThrow({ where: { key } })),
        ).toEqual(expired);
        expect(
          await inSchema((tx) => tx.providerRun.count({ where: { userId: 'retry-user' } })),
        ).toBe(3);
        fail = false;
        empty = true;
        // Recovery rotates the lease token without another attempt; the old worker cannot publish cache.
        const recoveryQuery = { niche: 'food', city: 'recovery', query: null };
        const recovery = await beginDiscover(recoveryQuery, 'recovery-user', client);
        expect(recovery.created).toBe(true);
        const leased = await claimNextInstagramSyncJob(600000, client, 'DISCOVER_SEARCH');
        if (!leased?.lockToken) throw new Error('No lease');
        await inSchema((tx) =>
          tx.instagramSyncJob.update({
            where: { id: leased.id },
            data: {
              lockedAt: new Date('2000-01-01T00:00:00Z'),
              leaseExpiresAt: new Date('2000-01-01T00:10:00Z'),
            },
          }),
        );
        const reclaimed = await reclaimInstagramSyncJob(600000, client, 'DISCOVER_SEARCH');
        if (!reclaimed?.lockToken) throw new Error('No recovery');
        expect(reclaimed.attempts).toBe(leased.attempts);
        expect(reclaimed.lockToken).not.toBe(leased.lockToken);
        await expect(
          commitDiscoverSearch({ id: leased.id, lockToken: leased.lockToken }, [], client),
        ).rejects.toBeInstanceOf(SyncJobOwnershipLost);
        expect(
          await inSchema((tx) =>
            tx.discoverCache.findUnique({ where: { key: discoverKey(recoveryQuery) } }),
          ),
        ).toBeNull();
        expect(await processDiscoverSearch(reclaimed, client, gateway)).toMatchObject({
          status: 'succeeded',
        });
        expect(
          (
            await inSchema((tx) =>
              tx.discoverCache.findUniqueOrThrow({ where: { key: discoverKey(recoveryQuery) } }),
            )
          ).results,
        ).toEqual([]);
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
  },
);
