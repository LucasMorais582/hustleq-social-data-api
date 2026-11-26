import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma, type InstagramSyncJob } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  enqueueInstagramSyncJob,
  claimNextInstagramSyncJob,
  renewInstagramSyncJobLease,
  completeInstagramSyncJob,
  failInstagramSyncJob,
} from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';

// Concorrencia real precisa de commits visiveis entre conexoes. Este teste cria
// apenas um schema aleatorio proprio e o remove em finally; nao altera public.
describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Instagram queue on PostgreSQL', () => {
  it('deduplicates concurrent enqueue, skips locked rows and fences transitions and retries', async () => {
    const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!connection) throw new Error('Configure DIRECT_URL ou DATABASE_URL para o teste opt-in');
    const namespace = `sync_queue_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^sync_queue_test_[a-f0-9]{32}$/.test(namespace))
      throw new Error('Schema de teste invalido');
    const url = new URL(connection);
    url.searchParams.set('schema', namespace);
    url.searchParams.set('connection_limit', '4');
    const client = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
    let created = false;
    const inSchema = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
          return work(tx);
        },
        { timeout: 30000, maxWait: 10000 },
      );
    try {
      await client.$transaction(
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
      const profile = await inSchema((tx) =>
        tx.instagramProfile.create({
          data: { instagramId: 'queue-fixture', username: 'queuefixture' },
        }),
      );
      const input = {
        type: 'INITIAL_PROFILE_SYNC' as const,
        trigger: 'initial' as const,
        instagramProfileId: profile.id,
        activeKey: `profile:${profile.id}`,
      };
      const enqueued = await Promise.all([
        inSchema((tx) => enqueueInstagramSyncJob(input, tx)),
        inSchema((tx) => enqueueInstagramSyncJob(input, tx)),
      ]);
      expect(enqueued[0]?.id).toBe(enqueued[1]?.id);
      expect(await inSchema((tx) => tx.instagramSyncJob.count())).toBe(1);
      let release!: () => void;
      let ready!: (job: InstagramSyncJob | null) => void;
      let rejectReady!: (error: unknown) => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const claimed = new Promise<InstagramSyncJob | null>((resolve, reject) => {
        ready = resolve;
        rejectReady = reject;
      });
      const holding = inSchema(async (tx) => {
        const first = await claimNextInstagramSyncJob(600000, tx);
        ready(first);
        await released;
        return first;
      });
      void holding.catch(rejectReady);
      let first: InstagramSyncJob | null = null;
      try {
        first = await claimed;
        expect(first).toMatchObject({ status: 'RUNNING', attempts: 1 });
        // Segunda conexao nao deve esperar nem capturar a linha bloqueada pela primeira.
        expect(await inSchema((tx) => claimNextInstagramSyncJob(600000, tx))).toBeNull();
      } finally {
        release();
        await holding;
      }
      const owner = { id: first!.id, lockToken: first!.lockToken! };
      expect(
        await inSchema((tx) =>
          completeInstagramSyncJob({ ...owner, lockToken: 'wrong-worker' }, tx),
        ),
      ).toBe(false);
      expect(await inSchema((tx) => renewInstagramSyncJobLease(owner, 600000, tx))).toBe(true);
      const retry = await inSchema((tx) => failInstagramSyncJob(owner, 'PROVIDER_UNAVAILABLE', tx));
      expect(retry).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lockToken: null,
        finishedAt: null,
        activeKey: input.activeKey,
      });
      expect(retry!.runAt.getTime() - retry!.updatedAt.getTime()).toBe(60000);
      expect(await inSchema((tx) => claimNextInstagramSyncJob(600000, tx))).toBeNull();
      expect(await inSchema((tx) => completeInstagramSyncJob(owner, tx))).toBe(false);
      expect(
        await inSchema((tx) => failInstagramSyncJob(owner, 'PROVIDER_UNAVAILABLE', tx)),
      ).toBeNull();
      // Avanca a disponibilidade sem aguardar minutos no teste.
      await inSchema((tx) =>
        tx.instagramSyncJob.update({
          where: { id: owner.id },
          data: { runAt: new Date('2000-01-01T00:00:00Z') },
        }),
      );
      const second = await inSchema((tx) => claimNextInstagramSyncJob(600000, tx));
      expect(second).toMatchObject({ id: owner.id, attempts: 2 });
      expect(second!.lockToken).not.toBe(owner.lockToken);
      const owner2 = { id: second!.id, lockToken: second!.lockToken! };
      const retry2 = await inSchema((tx) =>
        failInstagramSyncJob(owner2, 'PROVIDER_UNAVAILABLE', tx),
      );
      expect(retry2!.runAt.getTime() - retry2!.updatedAt.getTime()).toBe(300000);
      await inSchema((tx) =>
        tx.instagramSyncJob.update({
          where: { id: owner.id },
          data: { runAt: new Date('2000-01-01T00:00:00Z') },
        }),
      );
      const third = await inSchema((tx) => claimNextInstagramSyncJob(600000, tx));
      const owner3 = { id: third!.id, lockToken: third!.lockToken! };
      const failed = await inSchema((tx) =>
        failInstagramSyncJob(owner3, 'PROVIDER_UNAVAILABLE', tx),
      );
      expect(failed).toMatchObject({
        status: 'FAILED',
        attempts: 3,
        activeKey: null,
        lockToken: null,
        lastError: 'PROVIDER_UNAVAILABLE',
      });
      expect(failed?.finishedAt).toBeInstanceOf(Date);
      expect(await inSchema((tx) => claimNextInstagramSyncJob(600000, tx))).toBeNull();
      const next = await inSchema((tx) => enqueueInstagramSyncJob(input, tx));
      expect(next.id).not.toBe(owner.id);
      const nextClaim = await inSchema((tx) => claimNextInstagramSyncJob(600000, tx));
      const nextOwner = { id: nextClaim!.id, lockToken: nextClaim!.lockToken! };
      expect(await inSchema((tx) => completeInstagramSyncJob(nextOwner, tx))).toBe(true);
      expect(await inSchema((tx) => completeInstagramSyncJob(nextOwner, tx))).toBe(false);
      await inSchema((tx) => enqueueInstagramSyncJob(input, tx));
      const expired = await inSchema((tx) => claimNextInstagramSyncJob(600000, tx));
      // Simula uma posse vencida. O worker antigo nao pode renovar/concluir/reagendar.
      await inSchema((tx) =>
        tx.instagramSyncJob.update({
          where: { id: expired!.id },
          data: {
            lockedAt: new Date('2000-01-01T00:00:00Z'),
            leaseExpiresAt: new Date('2000-01-01T00:10:00Z'),
          },
        }),
      );
      const staleOwner = { id: expired!.id, lockToken: expired!.lockToken! };
      expect(await inSchema((tx) => renewInstagramSyncJobLease(staleOwner, 600000, tx))).toBe(
        false,
      );
      expect(await inSchema((tx) => completeInstagramSyncJob(staleOwner, tx))).toBe(false);
      expect(
        await inSchema((tx) => failInstagramSyncJob(staleOwner, 'PROVIDER_UNAVAILABLE', tx)),
      ).toBeNull();
      // Sem repetir automaticamente um Actor que ainda pode estar executando.
      expect(await inSchema((tx) => claimNextInstagramSyncJob(600000, tx))).toBeNull();
      expect(await inSchema((tx) => tx.providerRun.count())).toBe(0);
    } finally {
      try {
        if (created) {
          await client.$executeRawUnsafe(`DROP SCHEMA "${namespace}" CASCADE`);
        }
        const [state] = await client.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${namespace}) AS present`;
        expect(state?.present).toBe(false);
      } finally {
        await client.$disconnect();
      }
    }
  }, 120000);
});
