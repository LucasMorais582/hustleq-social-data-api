import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { savePostCollection } from '../src/modules/instagram/post/instagram.post.repository.js';
import { saveProfileCollection } from '../src/modules/instagram/profile/instagram.profile.repository.js';

// Opt-in: cria um schema isolado dentro de uma transação e sempre faz rollback.
// Não consulta/modifica dados do schema public e não chama a Apify.
describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('MVP migration on PostgreSQL', () => {
  it('preserves legacy data, writes new metadata and rolls back the isolated schema', async () => {
    const connection = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!connection) throw new Error('Configure DIRECT_URL ou DATABASE_URL para o teste opt-in');
    const namespace = `mvp_test_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(connection);
    url.searchParams.set('schema', namespace);
    const client = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
    const rollback = new Error('ROLLBACK_MVP_TEST');
    const timestamp = new Date('2026-11-17T12:00:00Z');
    try {
      try {
        await client.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
            await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
            async function applyMigration(relative: string) {
              const sql = await readFile(new URL(relative, import.meta.url), 'utf8');
              const statements = sql
                .replace(/^--.*$/gm, '')
                .split(';')
                .map((part) => part.trim())
                .filter(Boolean);
              for (const statement of statements) {
                if (
                  /^(BEGIN|COMMIT)$/i.test(statement) ||
                  /^CREATE SCHEMA IF NOT EXISTS "public"$/i.test(statement)
                )
                  continue;
                await tx.$executeRawUnsafe(statement);
              }
            }
            await applyMigration(
              '../prisma/migrations/20261117000000_create_instagram_models/migration.sql',
            );
            await tx.$executeRaw`INSERT INTO "InstagramProfile" (id, "instagramId", username, "updatedAt") VALUES ('legacy-profile', 'legacy-ig', 'legacy', ${timestamp})`;
            await tx.$executeRaw`INSERT INTO "InstagramPost" (id, "instagramProfileId", "instagramPostId", type, timestamp, "updatedAt") VALUES ('legacy-post', 'legacy-profile', 'legacy-post-ig', 'reel', ${timestamp}, ${timestamp})`;
            await tx.$executeRaw`INSERT INTO "InstagramPostMetricSnapshot" (id, "instagramPostId", "likesCount", "viewsCount", "collectedAt") VALUES ('legacy-metric', 'legacy-post', NULL, 3000000000, ${timestamp})`;
            await applyMigration(
              '../prisma/migrations/20261119000000_add_mvp_tracking_and_cache/migration.sql',
            );

            const legacy = await tx.instagramPostMetricSnapshot.findUniqueOrThrow({
              where: { id: 'legacy-metric' },
            });
            expect(legacy).toMatchObject({
              source: null,
              likesCount: null,
              likesHidden: false,
              viewsCount: 3000000000n,
              collectedAt: timestamp,
            });
            expect(
              await tx.instagramProfile.findUniqueOrThrow({ where: { id: 'legacy-profile' } }),
            ).toMatchObject({
              syncStatus: 'pending',
              lastSyncedAt: null,
              reservedUntil: null,
              monitoringUntil: null,
            });
            expect(
              await tx.instagramPost.findUniqueOrThrow({ where: { id: 'legacy-post' } }),
            ).toMatchObject({ lastCollectedAt: null });

            // Compartilha a transação externa; os repositories não abrem outra conexão.
            const injected = {
              $transaction: (work: (value: typeof tx) => Promise<unknown>) => work(tx),
            } as unknown as PrismaClient;
            const post = {
              instagramPostId: 'new-post-ig',
              type: 'photo' as const,
              url: null,
              caption: null,
              hashtags: [],
              displayUrl: null,
              images: [],
              timestamp,
              ownerUsername: 'legacy',
              likesCount: 0,
              commentsCount: 0,
              viewsCount: null,
            };
            await savePostCollection(
              { collectedAt: timestamp, posts: [{ ...post, ownerInstagramId: 'legacy-ig' }] },
              injected,
            );
            const saved = await tx.instagramPost.findUniqueOrThrow({
              where: { instagramPostId: 'new-post-ig' },
            });
            expect(saved.lastCollectedAt).toEqual(timestamp);
            expect(
              await tx.instagramPostMetricSnapshot.findFirstOrThrow({
                where: { instagramPostId: saved.id },
              }),
            ).toMatchObject({ source: 'initial', likesHidden: false, likesCount: 0 });

            const tomorrow = new Date(timestamp.getTime() + 86400000);
            await saveProfileCollection(
              {
                collectedAt: tomorrow,
                refreshMetricsSince: tomorrow,
                profile: {
                  instagramId: 'legacy-ig',
                  username: 'legacy',
                  name: null,
                  url: null,
                  bio: null,
                  profilePhoto: null,
                  category: null,
                  isVerified: null,
                  followers: null,
                  following: null,
                  postsCount: null,
                },
                posts: [{ ...post, likesCount: 5 }],
              },
              injected,
            );
            expect(
              await tx.instagramPostMetricSnapshot.count({ where: { instagramPostId: saved.id } }),
            ).toBe(2);
            expect(
              await tx.instagramPostMetricSnapshot.findFirstOrThrow({
                where: { instagramPostId: saved.id },
                orderBy: { collectedAt: 'desc' },
              }),
            ).toMatchObject({ source: 'daily', likesCount: 5 });
            expect(
              (await tx.instagramPost.findUniqueOrThrow({ where: { id: saved.id } }))
                .lastCollectedAt,
            ).toEqual(tomorrow);
            expect(
              (
                await tx.instagramPostMetricSnapshot.findUniqueOrThrow({
                  where: { id: 'legacy-metric' },
                })
              ).source,
            ).toBeNull();

            await tx.discoverCache.create({
              data: { key: 'test|city|query', results: [{ instagramPostId: 'sample' }] },
            });
            const run = await tx.providerRun.create({
              data: {
                actor: 'test-actor',
                trigger: 'search',
                status: 'succeeded',
                costUsd: new Prisma.Decimal('0.123456'),
                userId: 'external-user',
              },
            });
            expect(run.costUsd?.toFixed(6)).toBe('0.123456');
            const unknownCost = await tx.providerRun.create({
              data: { actor: 'test-actor', trigger: 'search', status: 'failed' },
            });
            expect(unknownCost.costUsd).toBeNull();
            throw rollback;
          },
          { timeout: 45000, maxWait: 10000 },
        );
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const [state] = await client.$queryRaw<
        { present: boolean }[]
      >`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${namespace}) AS present`;
      expect(state?.present).toBe(false);
    } finally {
      await client.$disconnect();
    }
  }, 60000);
});
