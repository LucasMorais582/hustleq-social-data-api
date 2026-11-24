import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { authHeaders } from './helpers/auth.js';
const state = vi.hoisted(() => ({ client: undefined as unknown, apify: vi.fn() }));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => state.client,
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({ createApifyClient: state.apify }));
import { reconcileProviderRuns } from '../src/provider/apify/apify.reconciliation.service.js';
import { buildApp } from '../src/app.js';

describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Monthly costs on PostgreSQL', () => {
  it('verifies monthly reads, legacy caller costs and reconciliation with concurrency and pagination', async () => {
    const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!connection) throw new Error('Configure o banco de desenvolvimento');
    const namespace = `costs_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^costs_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid schema');
    const url = new URL(connection);
    url.searchParams.set('schema', namespace);
    const base = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
    const inSchema = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
      base.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
          return work(tx);
        },
        { timeout: 30000, maxWait: 10000 },
      );
    state.client = {
      providerRun: {
        create: (args: Prisma.ProviderRunCreateArgs) => base.providerRun.create(args),
        update: (args: Prisma.ProviderRunUpdateArgs) => base.providerRun.update(args),
        groupBy: (args: Prisma.ProviderRunGroupByArgs) =>
          inSchema((tx) => tx.providerRun.groupBy(args as never)),
      },
    };
    const app = buildApp();
    let created = false;
    const get = (month: string) =>
      app.inject({
        url: `/api/v1/internal/costs?month=${month}`,
        headers: authHeaders({ sub: 'hustleq-main', scope: 'service' }),
      });
    try {
      await base.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
          for (const migration of [
            '20261117000000_create_instagram_models',
            '20261119000000_add_mvp_tracking_and_cache',
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
      const row = (
        id: string,
        userId: string | null,
        trigger: string,
        costUsd: string | null,
        status: string,
        startedAt: string,
        finishedAt: string | null = null,
      ) => ({
        id,
        actor: 'fixture-actor',
        userId,
        trigger,
        costUsd,
        status,
        startedAt: new Date(startedAt),
        finishedAt: finishedAt === null ? null : new Date(finishedAt),
      });
      await inSchema((tx) =>
        tx.providerRun.createMany({
          data: [
            row('before', 'a', 'daily', '9', 'succeeded', '2026-10-31T23:59:59.999Z'),
            row(
              'boundary-start',
              'a',
              'initial',
              '0.100001',
              'succeeded',
              '2026-11-01T00:00:00Z',
              '2026-12-01T00:01:00Z',
            ),
            row('failed-billable', 'a', 'initial', '0.000002', 'failed', '2026-11-02T12:00:00Z'),
            row('known-zero', 'b', 'search', '0', 'succeeded', '2026-11-15T12:00:00Z'),
            row('unknown-running', 'b', 'daily', null, 'running', '2026-11-20T12:00:00Z'),
            row('unattributed-known', null, 'initial', '0.2', 'failed', '2026-11-30T23:59:59.999Z'),
            row('unattributed-unknown', null, 'search', null, 'failed', '2026-11-25T12:00:00Z'),
            row('boundary-end', 'a', 'daily', '7', 'succeeded', '2026-12-01T00:00:00Z'),
          ],
        }),
      );
      const before = await inSchema((tx) => tx.providerRun.findMany({ orderBy: { id: 'asc' } }));
      const response = await get('2026-11');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        month: '2026-11',
        totalUsd: null,
        byUser: [
          { userId: 'a', costUsd: 0.100003, runs: 2 },
          { userId: 'b', costUsd: null, runs: 2 },
        ],
        byTrigger: [
          { trigger: 'daily', costUsd: null, runs: 1 },
          { trigger: 'initial', costUsd: 0.300003, runs: 3 },
          { trigger: 'search', costUsd: null, runs: 2 },
        ],
        unattributedUsd: null,
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect((await get('2026-12')).json()).toMatchObject({ totalUsd: 7, unattributedUsd: 0 });
      expect((await get('2027-01')).json()).toEqual({
        month: '2027-01',
        totalUsd: 0,
        byUser: [],
        byTrigger: [],
        unattributedUsd: 0,
      });
      expect(await inSchema((tx) => tx.providerRun.findMany({ orderBy: { id: 'asc' } }))).toEqual(
        before,
      );
      expect(state.apify).not.toHaveBeenCalled();
      // The old post endpoint now records costs for the JWT caller, without changing its DTO.
      state.apify.mockReturnValue({
        actor: () => ({
          call: async () => ({
            id: 'legacy-external',
            status: 'SUCCEEDED',
            usageTotalUsd: 0.015,
            defaultDatasetId: 'fixture',
          }),
        }),
        dataset: () => ({ listItems: async () => ({ items: [] }) }),
      });
      const legacy = await app.inject({
        method: 'POST',
        url: '/api/v1/instagram/post/search',
        headers: authHeaders({ sub: 'legacy-caller' }),
        payload: { username: 'example', resultLimits: 1 },
      });
      expect(legacy.statusCode, legacy.body).toBe(200);
      const ledger = await base.providerRun.findFirstOrThrow({
        where: { apifyRunId: 'legacy-external' },
      });
      expect(ledger).toMatchObject({
        userId: 'legacy-caller',
        trigger: 'search',
        status: 'succeeded',
        items: 0,
      });
      expect(ledger.costUsd?.toString()).toBe('0.015');
      await base.providerRun.update({
        where: { id: 'unknown-running' },
        data: { apifyRunId: 'known-stale' },
      });
      // A worker changes this row after the scan: optimistic reconciliation must not overwrite it.
      const changed = await reconcileProviderRuns(100, base, {
        get: async (id) => {
          await base.providerRun.update({ where: { id: 'unknown-running' }, data: { items: 7 } });
          return { id, status: 'SUCCEEDED', usageTotalUsd: 0.123456 };
        },
      });
      expect(changed).toMatchObject({ inspected: 1, conflicts: 1, updated: 0 });
      expect(
        (await base.providerRun.findUniqueOrThrow({ where: { id: 'unknown-running' } })).costUsd,
      ).toBeNull();
      expect(
        await reconcileProviderRuns(100, base, {
          get: async (id) => ({ id, status: 'SUCCEEDED', usageTotalUsd: 0.123456 }),
        }),
      ).toMatchObject({ updated: 1 });
      expect(
        (
          await base.providerRun.findUniqueOrThrow({ where: { id: 'unknown-running' } })
        ).costUsd?.toString(),
      ).toBe('0.123456');
      await base.providerRun.createMany({
        data: ['cursor-a', 'cursor-b'].map((id) => ({
          id,
          actor: 'fixture',
          trigger: 'search',
          status: 'running',
          apifyRunId: id,
          startedAt: new Date('2026-12-10T00:00:00Z'),
        })),
      });
      const transport = {
        get: async (id: string) => ({ id, status: 'SUCCEEDED', usageTotalUsd: 0.02 }),
      };
      const page1 = await reconcileProviderRuns(1, base, transport);
      expect(page1.nextCursor).toBe('cursor-a');
      const page2 = await reconcileProviderRuns(1, base, transport, page1.nextCursor!);
      expect(page2).toMatchObject({ nextCursor: 'cursor-b', updated: 1 });
      expect((await reconcileProviderRuns(1, base, transport, page2.nextCursor!)).inspected).toBe(
        0,
      );
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
