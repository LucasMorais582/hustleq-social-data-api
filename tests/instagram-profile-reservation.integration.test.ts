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
import { reserveVerifiedInstagramProfile } from '../src/modules/instagram/profile/instagram.profile.reservation.repository.js';

// HTTP/Prisma/worker reais; somente o transporte para Apify e simulado.
// Usa schema proprio com commits para concorrencia e limpeza em finally.
describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')(
  'Profile invitation reservation on PostgreSQL',
  () => {
    it('queues the verified run, syncs without a second profile call and serializes competing invitations', async () => {
      const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
      if (!connection) throw new Error('Configure o banco de desenvolvimento');
      const namespace = `profile_reserve_test_${randomUUID().replaceAll('-', '')}`;
      if (!/^profile_reserve_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid schema');
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
          const profile =
            username === 'second_profile'
              ? { ...profileFixture, id: 'second-instagram-id', username, latestPosts: [] }
              : { ...profileFixture, latestPosts: [...profileFixture.latestPosts, reelFixture] };
          return { items: [profile], total: 1 };
        }),
      };
      state.gateway.mockReturnValue(gateway);
      const app = buildApp();
      const path = '/api/v1/internal/instagram/profiles';
      const headers = authHeaders({ sub: 'hustleq-main', scope: 'service' });
      const future = new Date(Date.now() + 172800000).toISOString();
      const reserve = (inviteId: string, username = '@Example_Profile') =>
        app.inject({
          method: 'POST',
          url: path,
          headers,
          payload: { username, inviteId, reservedUntil: future },
        });
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
        const first = await reserve('invite-A');
        expect(first.statusCode).toBe(201);
        const profileId = first.json().profileId as string;
        expect(first.json()).toEqual({ profileId, username: 'example_profile', status: 'syncing' });
        expect(typeof profileId).toBe('string');
        expect(await inSchema((tx) => tx.instagramProfileSnapshot.count())).toBe(0);
        expect(await inSchema((tx) => tx.instagramPost.count())).toBe(0);
        const pending = await inSchema((tx) => tx.instagramSyncJob.findFirstOrThrow());
        expect(pending).toMatchObject({
          type: 'INITIAL_PROFILE_SYNC',
          status: 'PENDING',
          attempts: 0,
          instagramProfileId: profileId,
        });
        const lookup = await inSchema((tx) => tx.providerRun.findFirstOrThrow());
        expect(lookup).toMatchObject({
          instagramProfileId: profileId,
          userId: null,
          status: 'succeeded',
        });
        expect(lookup.costUsd?.toFixed(6)).toBe('0.002300');
        expect(await runInitialSyncWorkerOnce(client, gateway)).toMatchObject({
          status: 'succeeded',
        });
        expect(
          gateway.start.mock.calls.filter(([actor]) => String(actor).includes('profile')),
        ).toHaveLength(1);
        expect(
          gateway.start.mock.calls.filter(([actor]) => String(actor).includes('reel')),
        ).toHaveLength(1);
        expect(await inSchema((tx) => tx.instagramProfileSnapshot.count())).toBe(1);
        expect(await inSchema((tx) => tx.instagramPost.count())).toBe(2);
        expect(
          await inSchema((tx) =>
            tx.instagramProfile.findUniqueOrThrow({ where: { id: profileId } }),
          ),
        ).toMatchObject({
          ownerUserId: null,
          reservedForInviteId: 'invite-A',
          syncStatus: 'ready',
        });
        expect(await inSchema((tx) => tx.providerRun.count())).toBe(2);

        // Uma execucao de outro perfil nao pode ser movida para uma reserva nova.
        await expect(
          reserveVerifiedInstagramProfile(
            {
              identity: {
                instagramId: 'wrong-run-target',
                username: 'wrongtarget',
                name: null,
                url: null,
                bio: null,
                profilePhoto: null,
                category: null,
                isVerified: null,
              },
              inviteId: 'wrong-run-invite',
              reservedUntil: new Date(future),
              providerRunId: lookup.id,
            },
            client,
          ),
        ).rejects.toThrow('VERIFIED_PROFILE_RUN_NOT_FOUND');
        expect(
          await inSchema((tx) =>
            tx.instagramProfile.findUnique({ where: { instagramId: 'wrong-run-target' } }),
          ),
        ).toBeNull();
        expect(
          (await inSchema((tx) => tx.providerRun.findUniqueOrThrow({ where: { id: lookup.id } })))
            .instagramProfileId,
        ).toBe(profileId);

        // Libera uma reserva vencida e disputa o mesmo perfil entre dois convites.
        await inSchema((tx) =>
          tx.instagramProfile.update({
            where: { id: profileId },
            data: { reservedUntil: new Date('2000-01-01T00:00:00Z') },
          }),
        );
        const competing = await Promise.all([reserve('invite-B'), reserve('invite-C')]);
        expect(competing.map((response) => response.statusCode).sort()).toEqual([201, 409]);
        const winner = competing[0]!.statusCode === 201 ? 'invite-B' : 'invite-C';
        expect(competing.find((response) => response.statusCode === 409)!.json().error.code).toBe(
          'PROFILE_RESERVED',
        );
        expect(competing.find((response) => response.statusCode === 201)!.json()).toEqual({
          profileId,
          username: 'example_profile',
          status: 'ready',
        });
        expect((await reserve(winner)).json()).toMatchObject({ profileId, status: 'ready' });
        expect(await inSchema((tx) => tx.instagramProfile.count())).toBe(1);
        expect(await inSchema((tx) => tx.instagramSyncJob.count())).toBe(1);
        expect(await inSchema((tx) => tx.instagramProfileSnapshot.count())).toBe(1);

        // Falha real do acesso a fila deve reverter perfil/reserva e vinculacao do custo.
        await inSchema((tx) =>
          tx.$executeRawUnsafe(
            'ALTER TABLE "InstagramSyncJob" RENAME TO "InstagramSyncJob_unavailable"',
          ),
        );
        const failed = await reserve('invite-failure', 'second_profile');
        expect(failed.statusCode).toBe(500);
        expect(
          await inSchema((tx) =>
            tx.instagramProfile.findUnique({ where: { instagramId: 'second-instagram-id' } }),
          ),
        ).toBeNull();
        const lastRun = await inSchema((tx) =>
          tx.providerRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } }),
        );
        expect(lastRun).toMatchObject({ instagramProfileId: null, status: 'succeeded' });
        expect(lastRun.costUsd?.toFixed(6)).toBe('0.002300');
        await inSchema((tx) =>
          tx.$executeRawUnsafe(
            'ALTER TABLE "InstagramSyncJob_unavailable" RENAME TO "InstagramSyncJob"',
          ),
        );
        const searchPath = '/api/v1/instagram/profiles/search';
        const preview = (username: string, userId = 'preview-user') =>
          app.inject({
            url: `${searchPath}?username=${username}`,
            headers: authHeaders({ sub: userId }),
          });
        expect((await preview('example_profile')).json().ownershipStatus).toBe('reserved');
        const assigned = await app.inject({
          method: 'POST',
          url: `${path}/${profileId}/owner`,
          headers,
          payload: { userId: 'external-owner' },
        });
        expect(assigned.statusCode).toBe(200);
        const owned = await reserve('invite-after-owner');
        expect(owned.statusCode).toBe(409);
        expect(owned.json().error.code).toBe('PROFILE_ALREADY_OWNED');
        const beforePreview = await inSchema((tx) =>
          tx.instagramProfile.findUniqueOrThrow({ where: { id: profileId } }),
        );
        expect((await preview('example_profile', 'external-owner')).json().ownershipStatus).toBe(
          'owned_by_me',
        );
        expect((await preview('example_profile')).json().ownershipStatus).toBe('owned_by_other');
        expect((await preview('second_profile')).json().ownershipStatus).toBe('available');
        expect((await preview('missing_profile')).json()).toEqual({
          username: 'missing_profile',
          ownershipStatus: 'not_found',
        });
        expect(
          await inSchema((tx) =>
            tx.instagramProfile.findUnique({ where: { instagramId: 'second-instagram-id' } }),
          ),
        ).toBeNull();
        expect(
          await inSchema((tx) =>
            tx.instagramProfile.findUniqueOrThrow({ where: { id: profileId } }),
          ),
        ).toEqual(beforePreview);
        expect(await inSchema((tx) => tx.instagramSyncJob.count())).toBe(1);
        const searchRuns = await inSchema((tx) =>
          tx.providerRun.findMany({ where: { trigger: 'search' } }),
        );
        expect(searchRuns).toHaveLength(5);
        expect(
          searchRuns.every(
            (run) => run.userId === 'preview-user' || run.userId === 'external-owner',
          ),
        ).toBe(true);
        expect(await inSchema((tx) => tx.instagramPost.count())).toBe(2);
        expect(await inSchema((tx) => tx.instagramProfileSnapshot.count())).toBe(1);
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
