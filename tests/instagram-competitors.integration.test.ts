import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type * as TrackedRun from '../src/provider/apify/apify.tracked-run.js';
import profileFixture from './fixtures/instagram/profile-sample.json' with { type: 'json' };
import reelFixture from './fixtures/instagram/reel-documentation-sample.json' with { type: 'json' };
import { authHeaders } from './helpers/auth.js';
const state = vi.hoisted(() => ({ client: undefined as unknown, gateway: vi.fn() }));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => state.client,
}));
vi.mock('../src/provider/apify/apify.tracked-run.js', async (original) => ({
  ...(await original<typeof TrackedRun>()),
  createTrackedRunGateway: state.gateway,
}));
import { buildApp } from '../src/app.js';
import { runInitialSyncWorkerOnce } from '../src/modules/instagram/jobs/instagram.initial-sync.service.js';

// HTTP/Prisma/worker reais; somente o transporte para Apify e simulado.
// Usa schema proprio com commits para concorrencia e limpeza em finally.
describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')(
  'MVP competitor relationships on PostgreSQL',
  () => {
    it('persists relation and Initial Sync atomically, preserves owners/history and serializes the active cap', async () => {
      const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
      if (!connection) throw new Error('Configure o banco de desenvolvimento');
      const namespace = `competitor_test_${randomUUID().replaceAll('-', '')}`;
      if (!/^competitor_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid schema');
      const url = new URL(connection);
      url.searchParams.set('schema', namespace);
      url.searchParams.set('connection_limit', '6');
      const base = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
      let created = false;
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
      const runs = new Map<string, { actor: string; input: Record<string, unknown> }>();
      let sequence = 0;
      const gateway = {
        start: vi.fn().mockImplementation(async (actor: string, input: Record<string, unknown>) => {
          const id = `${actor.includes('profile') ? 'profile' : 'reels'}-run-${++sequence}`;
          runs.set(id, { actor, input });
          return { id, status: 'RUNNING' };
        }),
        get: vi.fn().mockImplementation(async (id: string) => ({
          id,
          status: 'SUCCEEDED',
          defaultDatasetId: id,
          usageTotalUsd: id.includes('profile') ? 0.0023 : 0.0026,
        })),
        items: vi.fn().mockImplementation(async (id: string) => {
          const run = runs.get(id)!;
          if (!run.actor.includes('profile')) return { items: [reelFixture], total: 1 };
          const username = (run.input.usernames as string[])[0];
          if (username === 'missing_profile') return { items: [], total: 0 };
          const profile = {
            ...profileFixture,
            id: `instagram-${username}`,
            username,
            latestPosts: [],
          };
          return { items: [profile], total: 1 };
        }),
      };
      state.gateway.mockReturnValue(gateway);
      const app = buildApp();
      const path = '/api/v1/instagram/profiles/source/competitors';
      const headers = authHeaders({ sub: 'watcher' });
      const add = (username: string) =>
        app.inject({ method: 'POST', url: path, headers, payload: { username } });
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
                .map((part) => part.trim())
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
              id: 'source',
              instagramId: 'source-ig',
              username: 'source',
              ownerUserId: 'watcher',
            },
          });
          await tx.instagramProfile.create({
            data: {
              instagramId: 'instagram-rival',
              username: 'rival',
              ownerUserId: 'another-owner',
              reservedForInviteId: 'keep-invite',
            },
          });
        });
        const first = await add('rival');
        expect(first.statusCode, first.body).toBe(201);
        const relation = first.json().response;
        const target = relation.competitorProfileId as string;
        const saved = await inSchema((tx) =>
          tx.instagramProfile.findUniqueOrThrow({ where: { id: target } }),
        );
        expect(saved.ownerUserId).toBe('another-owner');
        expect(saved.reservedForInviteId).toBe('keep-invite');
        expect(saved.syncStatus).toBe('syncing');
        const job = await inSchema((tx) => tx.instagramSyncJob.findFirstOrThrow());
        expect(job).toMatchObject({
          type: 'INITIAL_PROFILE_SYNC',
          userId: 'watcher',
          instagramProfileId: target,
          activeKey: `profile:${target}`,
        });
        expect(await inSchema((tx) => tx.instagramPost.count())).toBe(0);
        const list = await app.inject({ url: path, headers });
        expect(list.json().response.relations[0].competitorProfile.id).toBe(target);
        expect(list.body).not.toContain('ownerUserId');
        expect(list.body).not.toContain('keep-invite');
        expect(
          (await app.inject({ url: `/api/v1/instagram/profiles/${target}`, headers })).statusCode,
        ).toBe(200);
        expect((await add('rival')).json().error.code).toBe('COMPETITOR_ALREADY_REGISTERED');
        expect(await inSchema((tx) => tx.instagramSyncJob.count())).toBe(1);
        // Different relations for one target reuse the active profile job and its original payload.
        await inSchema((tx) =>
          tx.instagramProfile.create({
            data: {
              id: 'source-two',
              instagramId: 'source-two-ig',
              username: 'source_two',
              ownerUserId: 'watcher',
            },
          }),
        );
        expect(
          (
            await app.inject({
              method: 'POST',
              url: path.replace('/source/', '/source-two/'),
              headers,
              payload: { username: 'rival' },
            })
          ).statusCode,
        ).toBe(201);
        expect(
          await inSchema((tx) => tx.instagramSyncJob.findUniqueOrThrow({ where: { id: job.id } })),
        ).toMatchObject({
          id: job.id,
          payload: job.payload,
          attempts: job.attempts,
          runAt: job.runAt,
          userId: job.userId,
        });
        const before = gateway.start.mock.calls.length;
        expect(await runInitialSyncWorkerOnce(client, gateway)).toMatchObject({
          status: 'succeeded',
        });
        expect(gateway.start.mock.calls.length).toBe(before); // Reuses the validated profile run.
        expect(
          await inSchema((tx) =>
            tx.instagramProfileSnapshot.count({ where: { instagramProfileId: target } }),
          ),
        ).toBe(1);
        // Expired relationship revokes access when this is the user's last active link.
        await inSchema((tx) =>
          tx.instagramCompetitor.updateMany({
            where: { instagramProfileId: 'source-two' },
            data: { endedAt: new Date() },
          }),
        );
        const remove = () =>
          app.inject({ method: 'DELETE', url: `${path}/${relation.id}`, headers });
        expect((await remove()).statusCode).toBe(204);
        const endedAt = (
          await inSchema((tx) =>
            tx.instagramCompetitor.findUniqueOrThrow({ where: { id: relation.id } }),
          )
        ).endedAt;
        expect((await remove()).body).toBe('');
        expect(
          (
            await inSchema((tx) =>
              tx.instagramCompetitor.findUniqueOrThrow({ where: { id: relation.id } }),
            )
          ).endedAt,
        ).toEqual(endedAt);
        expect(
          (await app.inject({ url: `/api/v1/instagram/profiles/${target}`, headers })).statusCode,
        ).toBe(403);
        const again = await add('rival');
        expect(again.statusCode).toBe(201);
        expect(again.json().response.id).not.toBe(relation.id);
        expect(
          await inSchema((tx) =>
            tx.instagramProfile.count({ where: { instagramId: 'instagram-rival' } }),
          ),
        ).toBe(1);
        expect(await inSchema((tx) => tx.instagramProfileSnapshot.count())).toBe(1);
        // Missing queue storage rolls back profile identity and relationship together.
        await inSchema((tx) =>
          tx.$executeRawUnsafe('ALTER TABLE "InstagramSyncJob" RENAME TO "UnavailableSyncJob"'),
        );
        try {
          const failure = await add('rollback_target');
          expect(failure.statusCode).toBe(500);
          expect(failure.body).not.toContain('UnavailableSyncJob');
        } finally {
          await inSchema((tx) =>
            tx.$executeRawUnsafe('ALTER TABLE "UnavailableSyncJob" RENAME TO "InstagramSyncJob"'),
          );
        }
        expect(
          await inSchema((tx) =>
            tx.instagramProfile.count({ where: { username: 'rollback_target' } }),
          ),
        ).toBe(0);
        expect(
          await inSchema((tx) => tx.providerRun.count({ where: { instagramProfileId: null } })),
        ).toBeGreaterThan(0); // Cost ledger survives rejection/rollback.
        const contenders = await Promise.all([
          add('candidate_a'),
          add('candidate_b'),
          add('candidate_c'),
        ]);
        expect(contenders.filter((result) => result.statusCode === 201)).toHaveLength(2);
        expect(contenders.filter((result) => result.statusCode === 409)).toHaveLength(1);
        expect(
          await inSchema((tx) =>
            tx.instagramCompetitor.count({
              where: { instagramProfileId: 'source', endedAt: null },
            }),
          ),
        ).toBe(3);
        const untouchedRuns = await inSchema((tx) => tx.providerRun.count());
        for (const method of ['GET', 'DELETE', 'POST'] as const) {
          const denied = await app.inject({
            method,
            url: method === 'DELETE' ? `${path}/${relation.id}` : path,
            headers: authHeaders({ sub: 'intruder' }),
            ...(method === 'POST' ? { payload: { username: 'other' } } : {}),
          });
          expect(denied.statusCode).toBe(403);
        }
        expect(await inSchema((tx) => tx.providerRun.count())).toBe(untouchedRuns);
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
    }, 180000);
  },
);
