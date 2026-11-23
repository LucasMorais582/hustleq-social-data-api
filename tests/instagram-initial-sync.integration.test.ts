import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import profileFixture from './fixtures/instagram/profile-sample.json' with { type: 'json' };
import reelFixture from './fixtures/instagram/reel-documentation-sample.json' with { type: 'json' };
import {
  enqueueInstagramSyncJob,
  claimNextInstagramSyncJob,
} from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import {
  processInitialProfileSync,
  runInitialSyncWorkerOnce,
} from '../src/modules/instagram/jobs/instagram.initial-sync.service.js';
import {
  beginInitialProfileSync,
  prepareInitialSyncRun,
  withOwnedInitialSync,
  SyncJobOwnershipLost,
} from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';

// Apenas o transporte Apify e simulado; fila, custos e snapshots usam PostgreSQL real.
// Schema proprio com commits e limpeza em finally, sem escrever nos registros de public.
describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Initial sync on PostgreSQL', () => {
  it('persists a fenced sync with costs and resumes known Actor runs without repeating the profile call', async () => {
    const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!connection) throw new Error('Configure o banco de desenvolvimento');
    const namespace = `initial_sync_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^initial_sync_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid test schema');
    const url = new URL(connection);
    url.searchParams.set('schema', namespace);
    url.searchParams.set('connection_limit', '4');
    const base = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
    let created = false;
    const inSchema = <T>(
      work: (tx: Prisma.TransactionClient) => Promise<T>,
      options = { timeout: 30000, maxWait: 10000 },
    ) =>
      base.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
        return work(tx);
      }, options);
    const client = {
      providerRun: base.providerRun,
      $transaction: inSchema,
      $queryRaw: (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
        inSchema((tx) => tx.$queryRaw(query, ...values)),
    } as unknown as PrismaClient;
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
      const profile = await inSchema((tx) =>
        tx.instagramProfile.create({
          data: {
            instagramId: profileFixture.id,
            username: 'example_profile',
            ownerUserId: 'external-owner',
          },
        }),
      );
      const input = {
        type: 'INITIAL_PROFILE_SYNC' as const,
        trigger: 'initial' as const,
        instagramProfileId: profile.id,
        activeKey: `profile:${profile.id}`,
      };
      await inSchema((tx) => enqueueInstagramSyncJob(input, tx));
      const job = await inSchema((tx) =>
        claimNextInstagramSyncJob(600000, tx, 'INITIAL_PROFILE_SYNC'),
      );
      const gateway = {
        start: vi.fn().mockImplementation(async (actor: string) => ({
          id: actor.includes('profile') ? 'profile-run' : 'reels-run',
          status: 'RUNNING',
        })),
        get: vi.fn().mockImplementation(async (id: string) => ({
          id,
          status: 'SUCCEEDED',
          defaultDatasetId: id,
          usageTotalUsd: id.includes('profile') ? 0.0023 : 0.0026,
        })),
        items: vi.fn().mockImplementation(async (id: string) => ({
          items: id.includes('profile')
            ? [
                {
                  ...profileFixture,
                  latestPosts: [
                    ...profileFixture.latestPosts,
                    reelFixture,
                    { ...reelFixture, id: 'foreign-post', ownerId: 'different-author' },
                  ],
                },
              ]
            : [reelFixture],
          total: 1,
        })),
      };
      expect(await processInitialProfileSync(job!, client, gateway)).toMatchObject({
        status: 'succeeded',
      });
      const saved = await inSchema((tx) =>
        tx.instagramProfile.findUniqueOrThrow({ where: { id: profile.id } }),
      );
      expect(saved).toMatchObject({
        id: profile.id,
        instagramId: profileFixture.id,
        ownerUserId: 'external-owner',
        syncStatus: 'ready',
        isVerified: null,
      });
      expect(saved.lastSyncedAt).toBeInstanceOf(Date);
      const posts = await inSchema((tx) =>
        tx.instagramPost.findMany({ include: { metricSnapshots: true } }),
      );
      expect(posts).toHaveLength(2);
      expect(posts.find((post) => post.type === 'reel')?.metricSnapshots[0]).toMatchObject({
        viewsCount: 809683n,
        source: 'initial',
        likesHidden: true,
        likesCount: null,
      });
      expect(
        posts.find((post) => post.type === 'photo')?.metricSnapshots[0]?.viewsCount,
      ).toBeNull();
      expect(await inSchema((tx) => tx.instagramProfileSnapshot.count())).toBe(1);
      const runs = await inSchema((tx) =>
        tx.providerRun.findMany({ orderBy: { startedAt: 'asc' } }),
      );
      expect(runs).toHaveLength(2);
      expect(
        runs.every((run) => run.status === 'succeeded' && run.userId === 'external-owner'),
      ).toBe(true);
      expect(runs.map((run) => run.costUsd?.toFixed(6))).toEqual(['0.002300', '0.002600']);
      expect(
        await inSchema((tx) => tx.instagramSyncJob.findUniqueOrThrow({ where: { id: job!.id } })),
      ).toMatchObject({ status: 'SUCCEEDED', activeKey: null });
      // Job concluido nao pode salvar novamente nem iniciar outro Actor.
      expect(await processInitialProfileSync(job!, client, gateway)).toMatchObject({
        status: 'lost',
      });
      expect(gateway.start).toHaveBeenCalledTimes(2);

      // Simula queda depois de persistir o id do Actor de perfil, antes da coleta terminar.
      await inSchema((tx) => enqueueInstagramSyncJob(input, tx));
      const recovering = await inSchema((tx) =>
        claimNextInstagramSyncJob(600000, tx, 'INITIAL_PROFILE_SYNC'),
      );
      const owner = { id: recovering!.id, lockToken: recovering!.lockToken! };
      await beginInitialProfileSync(owner, client);
      const pendingRun = await prepareInitialSyncRun(
        owner,
        'profile',
        'apify/instagram-profile-scraper',
        client,
      );
      await base.providerRun.update({
        where: { id: pendingRun.run.id },
        data: { apifyRunId: 'profile-run-resumed' },
      });
      await inSchema((tx) =>
        tx.instagramSyncJob.update({
          where: { id: recovering!.id },
          data: {
            lockedAt: new Date('2000-01-01T00:00:00Z'),
            leaseExpiresAt: new Date('2000-01-01T00:10:00Z'),
          },
        }),
      );
      gateway.start.mockClear();
      expect(await runInitialSyncWorkerOnce(client, gateway)).toMatchObject({
        status: 'succeeded',
      });
      expect(gateway.start).toHaveBeenCalledTimes(1);
      expect(gateway.start.mock.calls[0]![0]).toBe('apify/instagram-reel-scraper');
      expect(await inSchema((tx) => tx.instagramProfileSnapshot.count())).toBe(1);
      expect(await inSchema((tx) => tx.instagramPost.count())).toBe(2);
      expect(
        await inSchema((tx) =>
          tx.instagramSyncJob.findUniqueOrThrow({ where: { id: recovering!.id } }),
        ),
      ).toMatchObject({ attempts: 1, status: 'SUCCEEDED' });

      // Escritas de dominio tambem sao revertidas se a posse vencer antes do commit.
      await inSchema((tx) => enqueueInstagramSyncJob(input, tx));
      const expiring = await inSchema((tx) =>
        claimNextInstagramSyncJob(10000, tx, 'INITIAL_PROFILE_SYNC'),
      );
      let wrote = false;
      await expect(
        withOwnedInitialSync(
          { id: expiring!.id, lockToken: expiring!.lockToken! },
          async (tx) => {
            await tx.instagramProfile.update({
              where: { id: profile.id },
              data: { bio: 'MUST_ROLL_BACK' },
            });
            wrote = true;
            await tx.$queryRaw`SELECT 1::int AS waited FROM pg_sleep(11)`;
          },
          client,
        ),
      ).rejects.toBeInstanceOf(SyncJobOwnershipLost);
      expect(wrote).toBe(true);
      expect(
        (
          await inSchema((tx) =>
            tx.instagramProfile.findUniqueOrThrow({ where: { id: profile.id } }),
          )
        ).bio,
      ).not.toBe('MUST_ROLL_BACK');
    } finally {
      try {
        if (created) await base.$executeRawUnsafe(`DROP SCHEMA "${namespace}" CASCADE`);
        const [state] = await base.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${namespace}) AS present`;
        expect(state?.present).toBe(false);
      } finally {
        await base.$disconnect();
      }
    }
  }, 180000);
});
