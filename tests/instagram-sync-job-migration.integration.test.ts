import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

// Opt-in: valida a fila no PostgreSQL em schema isolado, sempre revertido.
// Não inicia worker/Actor e não altera os dados do schema public.
describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Instagram sync job migration', () => {
  it('preserves the existing tables and enforces job state, locks and active-key uniqueness', async () => {
    const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!connection) throw new Error('Configure DIRECT_URL ou DATABASE_URL para o teste opt-in');
    const namespace = `sync_job_test_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(connection);
    url.searchParams.set('schema', namespace);
    const client = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
    const rollback = new Error('ROLLBACK_SYNC_JOB_TEST');
    const now = new Date('2026-11-23T12:00:00Z');
    try {
      try {
        await client.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
            await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
            async function applyMigration(name: string) {
              const sql = await readFile(
                new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
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
            await applyMigration('20261117000000_create_instagram_models');
            await applyMigration('20261119000000_add_mvp_tracking_and_cache');
            const profile = await tx.instagramProfile.create({
              data: {
                instagramId: '1234567890123456789',
                username: 'example',
                ownerUserId: 'external-owner',
              },
            });
            const post = await tx.instagramPost.create({
              data: {
                instagramProfileId: profile.id,
                instagramPostId: '9876543210987654321',
                type: 'reel',
              },
            });
            const metric = await tx.instagramPostMetricSnapshot.create({
              data: {
                instagramPostId: post.id,
                source: null,
                viewsCount: 3000000000n,
                collectedAt: now,
              },
            });
            const run = await tx.providerRun.create({
              data: {
                actor: 'fixture-actor',
                trigger: 'search',
                status: 'succeeded',
                costUsd: new Prisma.Decimal('0.123456'),
              },
            });
            await applyMigration('20261123000000_add_instagram_sync_jobs');
            expect(
              await tx.instagramProfile.findUniqueOrThrow({ where: { id: profile.id } }),
            ).toEqual(profile);
            expect(await tx.instagramPost.findUniqueOrThrow({ where: { id: post.id } })).toEqual(
              post,
            );
            expect(
              await tx.instagramPostMetricSnapshot.findUniqueOrThrow({ where: { id: metric.id } }),
            ).toEqual(metric);
            expect(
              (await tx.providerRun.findUniqueOrThrow({ where: { id: run.id } })).costUsd?.toFixed(
                6,
              ),
            ).toBe('0.123456');
            expect(await tx.instagramSyncJob.count()).toBe(0);
            const input = {
              type: 'INITIAL_PROFILE_SYNC' as const,
              trigger: 'initial',
              instagramProfileId: profile.id,
              activeKey: `profile:${profile.id}`,
              runAt: now,
            };
            const job = await tx.instagramSyncJob.create({ data: input });
            expect(job).toMatchObject({
              status: 'PENDING',
              attempts: 0,
              lockedAt: null,
              leaseExpiresAt: null,
              lockToken: null,
              finishedAt: null,
              lastError: null,
              userId: null,
            });
            expect(typeof job.id).toBe('string');
            expect(await tx.instagramSyncJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(
              job,
            );
            // Savepoint protege a transacao de teste de erros SQL esperados.
            async function rejectWrite(work: () => Promise<unknown>, code?: string) {
              await tx.$executeRawUnsafe('SAVEPOINT invalid_job_write');
              let failure: unknown;
              try {
                await work();
              } catch (error) {
                failure = error;
              }
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_job_write');
              await tx.$executeRawUnsafe('RELEASE SAVEPOINT invalid_job_write');
              expect(failure).toBeDefined();
              if (code) expect(failure).toMatchObject({ code });
            }
            await rejectWrite(() => tx.instagramSyncJob.create({ data: input }), 'P2002');
            await rejectWrite(() =>
              tx.instagramSyncJob.create({
                data: { ...input, activeKey: 'negative', attempts: -1 },
              }),
            );
            await rejectWrite(() =>
              tx.instagramSyncJob.create({ data: { ...input, activeKey: null } }),
            );
            await rejectWrite(() =>
              tx.instagramSyncJob.create({ data: { ...input, activeKey: '   ' } }),
            );
            await rejectWrite(() =>
              tx.instagramSyncJob.create({
                data: { ...input, activeKey: 'bad-lock', status: 'RUNNING' },
              }),
            );
            await rejectWrite(() =>
              tx.instagramSyncJob.update({
                where: { id: job.id },
                data: { status: 'SUCCEEDED', activeKey: null },
              }),
            );
            await rejectWrite(
              () =>
                tx.instagramSyncJob.create({
                  data: {
                    ...input,
                    activeKey: 'invalid-profile',
                    instagramProfileId: 'absent-profile',
                  },
                }),
              'P2003',
            );
            await rejectWrite(() =>
              tx.instagramSyncJob.create({
                data: { ...input, activeKey: 'invalid-target', type: 'POST_REFRESH' },
              }),
            );
            const locked = await tx.instagramSyncJob.update({
              where: { id: job.id },
              data: {
                status: 'RUNNING',
                attempts: { increment: 1 },
                lockedAt: now,
                leaseExpiresAt: new Date(now.getTime() + 600000),
                lockToken: 'worker-claim',
              },
            });
            expect(locked).toMatchObject({
              status: 'RUNNING',
              attempts: 1,
              lockToken: 'worker-claim',
            });
            await rejectWrite(() =>
              tx.instagramSyncJob.update({ where: { id: job.id }, data: { leaseExpiresAt: now } }),
            );
            await rejectWrite(() =>
              tx.instagramSyncJob.update({ where: { id: job.id }, data: { lockToken: '' } }),
            );
            const completed = await tx.instagramSyncJob.update({
              where: { id: job.id },
              data: {
                status: 'SUCCEEDED',
                activeKey: null,
                lockedAt: null,
                leaseExpiresAt: null,
                lockToken: null,
                finishedAt: now,
              },
            });
            expect(completed).toMatchObject({ status: 'SUCCEEDED', attempts: 1, activeKey: null });
            // A chave volta a poder ser usada, mantendo o job concluido no historico.
            const next = await tx.instagramSyncJob.create({ data: input });
            expect(next.id).not.toBe(job.id);
            await tx.instagramSyncJob.update({
              where: { id: next.id },
              data: {
                status: 'FAILED',
                activeKey: null,
                finishedAt: now,
                lastError: 'fixture failure',
              },
            });
            for (const type of ['DAILY_PROFILE_SYNC', 'WATCHED_SYNC'] as const) {
              await tx.instagramSyncJob.create({
                data: {
                  ...input,
                  type,
                  trigger: type === 'WATCHED_SYNC' ? 'watched' : 'daily',
                  activeKey: type,
                },
              });
            }
            await tx.instagramSyncJob.create({
              data: {
                type: 'POST_REFRESH',
                trigger: 'on_open',
                instagramPostId: post.id,
                activeKey: `post:${post.id}`,
              },
            });
            const discover = await tx.instagramSyncJob.create({
              data: {
                type: 'DISCOVER_SEARCH',
                trigger: 'discover',
                activeKey: 'discover:fixture',
                payload: { niche: 'food', city: 'Newark', query: null },
              },
            });
            expect(discover.payload).toEqual({ niche: 'food', city: 'Newark', query: null });
            // Varios jobs finalizados com activeKey null podem coexistir.
            expect(await tx.instagramSyncJob.count({ where: { activeKey: null } })).toBe(2);
            expect(await tx.providerRun.count()).toBe(1);
            const [tables] = await tx.$queryRaw<
              { count: bigint }[]
            >`SELECT count(*) FROM information_schema.tables WHERE table_schema = ${namespace} AND table_type = 'BASE TABLE'`;
            expect(tables?.count).toBe(8n);
            throw rollback;
          },
          { timeout: 75000, maxWait: 10000 },
        );
      } catch (error) {
        if (error !== rollback) throw error;
      }
    } finally {
      try {
        const [state] = await client.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${namespace}) AS present`;
        expect(state?.present).toBe(false);
      } finally {
        await client.$disconnect();
      }
    }
  }, 90000);
});
