import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';

function ensureTemporarySchemaRemoved(present: boolean | undefined) {
  if (present) throw new Error('Temporary schema was not removed');
}

export async function withIsolatedPrisma<T>(
  prefix: string,
  work: (client: PrismaClient, base: PrismaClient) => Promise<T>,
) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(prefix)) throw new Error('Invalid schema prefix');
  const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connection) throw new Error('Configure o banco de desenvolvimento');
  const namespace = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(connection);
  url.searchParams.set('schema', namespace);
  url.searchParams.set('connection_limit', '6');
  const base = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
  const inSchema = <R>(
    callback: (tx: Prisma.TransactionClient) => Promise<R>,
    options: {
      timeout?: number;
      maxWait?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    } = {},
  ) =>
    base.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
        return callback(tx);
      },
      { timeout: 30000, maxWait: 10000, ...options },
    );
  const client = {
    providerRun: base.providerRun,
    instagramProfile: base.instagramProfile,
    instagramSyncJob: base.instagramSyncJob,
    instagramPost: base.instagramPost,
    instagramCompetitor: base.instagramCompetitor,
    $transaction: inSchema,
    $queryRaw: (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      inSchema((tx) => tx.$queryRaw(query, ...values)),
  } as unknown as PrismaClient;
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
            new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url),
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
      { timeout: 60000, maxWait: 10000 },
    );
    created = true;
    return await work(client, base);
  } finally {
    try {
      if (created) await base.$executeRawUnsafe(`DROP SCHEMA "${namespace}" CASCADE`);
      const [remaining] = await base.$queryRaw<
        { present: boolean }[]
      >`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${namespace}) AS present`;
      ensureTemporarySchemaRemoved(remaining?.present);
    } finally {
      await base.$disconnect();
    }
  }
}
