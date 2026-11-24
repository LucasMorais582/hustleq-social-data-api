import { getStoredInstagramPostMetrics } from '../src/modules/instagram/post/instagram.post.read.service.js';
import {
  assignInstagramProfileOwner,
  clearInstagramProfileReservation,
  updateInstagramProfileMonitoring,
} from '../src/modules/instagram/profile/instagram.profile.internal.service.js';
import { findProfilesForInstagramRefresh } from '../src/modules/instagram/refresh/instagram.refresh.repository.js';
import {
  readStoredInstagramProfile,
  readStoredInstagramPosts,
  readStoredInstagramProfileSnapshots,
} from '../src/modules/instagram/profile/instagram.profile.read.repository.js';
import { serializeStoredInstagramPost } from '../src/modules/instagram/profile/instagram.profile.read.service.js';
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
  it('preserves data, validates metadata and authorized reads, then rolls back the schema', async () => {
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
            await tx.instagramProfile.update({
              where: { id: 'legacy-profile' },
              data: { ownerUserId: 'scheduler-owner' },
            });
            const monitoring = await updateInstagramProfileMonitoring(
              'legacy-profile',
              '2026-11-18T12:00:00Z',
              injected,
            );
            expect(monitoring).toMatchObject({
              id: 'legacy-profile',
              monitoringUntil: '2026-11-18T12:00:00.000Z',
              isVerified: null,
              lastSyncedAt: null,
            });
            expect(await findProfilesForInstagramRefresh(timestamp, tx)).toEqual([
              { id: 'legacy-profile', ownerUserId: 'scheduler-owner' },
            ]);
            // No instante de vencimento e depois dele, o perfil não é elegível.
            expect(
              await findProfilesForInstagramRefresh(new Date('2026-11-18T12:00:00Z'), tx),
            ).toEqual([]);
            expect(
              await findProfilesForInstagramRefresh(new Date('2026-11-19T12:00:00Z'), tx),
            ).toEqual([]);
            expect(
              (await updateInstagramProfileMonitoring('legacy-profile', null, injected))
                .monitoringUntil,
            ).toBeNull();
            expect(
              await findProfilesForInstagramRefresh(new Date('2026-11-19T12:00:00Z'), tx),
            ).toHaveLength(1);
            await tx.instagramProfile.update({
              where: { id: 'legacy-profile' },
              data: { ownerUserId: null },
            });
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
              likesCount: null,
              likesHidden: true,
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
            ).toMatchObject({ source: 'initial', likesHidden: true, likesCount: null });

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
                posts: [{ ...post, likesCount: 5, likesHidden: false }],
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
            // Leituras da MVP: dados salvos, autorização por dono/relação e filtros reais.
            await tx.instagramProfile.update({
              where: { id: 'legacy-profile' },
              data: { reservedForInviteId: 'test-invite', reservedUntil: tomorrow },
            });
            expect(
              await assignInstagramProfileOwner('legacy-profile', 'owner-user', injected),
            ).toEqual({ profileId: 'legacy-profile', ownerUserId: 'owner-user' });
            expect(
              await tx.instagramProfile.findUniqueOrThrow({ where: { id: 'legacy-profile' } }),
            ).toMatchObject({
              ownerUserId: 'owner-user',
              reservedForInviteId: null,
              reservedUntil: null,
            });
            expect(
              await assignInstagramProfileOwner('legacy-profile', 'owner-user', injected),
            ).toMatchObject({ ownerUserId: 'owner-user' });
            await expect(
              assignInstagramProfileOwner('legacy-profile', 'another-owner', injected),
            ).rejects.toMatchObject({ statusCode: 409, code: 'PROFILE_ALREADY_OWNED' });
            await tx.instagramProfile.update({
              where: { id: 'legacy-profile' },
              data: { reservedForInviteId: 'test-invite-2', reservedUntil: tomorrow },
            });
            await clearInstagramProfileReservation('legacy-profile', injected);
            await clearInstagramProfileReservation('legacy-profile', injected);
            expect(
              await tx.instagramProfile.findUniqueOrThrow({ where: { id: 'legacy-profile' } }),
            ).toMatchObject({
              ownerUserId: 'owner-user',
              reservedForInviteId: null,
              reservedUntil: null,
            });
            expect(
              await tx.instagramPost.count({ where: { instagramProfileId: 'legacy-profile' } }),
            ).toBe(2);
            expect(await tx.instagramPostMetricSnapshot.count()).toBe(3);
            const profileRead = await readStoredInstagramProfile(
              'legacy-profile',
              'owner-user',
              injected,
            );
            expect(profileRead?.snapshots).toHaveLength(1);
            expect(profileRead).not.toHaveProperty('ownerUserId');
            expect(profileRead?.isVerified).toBeNull();
            const page = await readStoredInstagramPosts(
              'legacy-profile',
              'owner-user',
              { page: 1, limit: 30, type: 'IMAGE', from: '2026-11-17', to: '2026-11-17' },
              injected,
            );
            expect(page.total).toBe(1);
            expect(page.posts).toHaveLength(1);
            expect(page.posts[0]?.metricSnapshots).toHaveLength(1);
            expect(serializeStoredInstagramPost(page.posts[0]!)).toMatchObject({
              type: 'IMAGE',
              metrics: { likesCount: 5, likesHidden: false, viewsCount: null },
            });
            expect(
              (
                await readStoredInstagramPosts(
                  'legacy-profile',
                  'owner-user',
                  { page: 2, limit: 30, type: 'IMAGE' },
                  injected,
                )
              ).posts,
            ).toEqual([]);
            expect(
              await readStoredInstagramProfileSnapshots(
                'legacy-profile',
                'owner-user',
                { from: '2026-11-18', to: '2026-11-18' },
                injected,
              ),
            ).toHaveLength(1);
            expect(
              await readStoredInstagramProfileSnapshots(
                'legacy-profile',
                'owner-user',
                { to: '2026-11-17' },
                injected,
              ),
            ).toEqual([]);
            await expect(
              readStoredInstagramProfile('legacy-profile', 'unrelated-user', injected),
            ).rejects.toMatchObject({ statusCode: 403 });
            const history = await getStoredInstagramPostMetrics(
              saved.id,
              'owner-user',
              {},
              injected,
            );
            expect(history.postId).toBe(saved.id);
            expect(history.metrics).toHaveLength(2);
            expect(history.metrics[0]).toMatchObject({
              source: 'initial',
              likesCount: null,
              likesHidden: true,
              collectedAt: timestamp.toISOString(),
            });
            expect(history.metrics[1]).toMatchObject({
              source: 'daily',
              likesCount: 5,
              likesHidden: false,
              collectedAt: tomorrow.toISOString(),
            });
            expect(
              (
                await getStoredInstagramPostMetrics(
                  saved.id,
                  'owner-user',
                  { from: '2026-11-18', to: '2026-11-18' },
                  injected,
                )
              ).metrics,
            ).toHaveLength(1);
            expect(
              (
                await getStoredInstagramPostMetrics(
                  saved.id,
                  'owner-user',
                  { to: '2026-11-16' },
                  injected,
                )
              ).metrics,
            ).toEqual([]);
            const legacyHistory = await getStoredInstagramPostMetrics(
              'legacy-post',
              'owner-user',
              {},
              injected,
            );
            expect(legacyHistory.metrics[0]).toMatchObject({
              source: null,
              likesCount: null,
              viewsCount: 3000000000,
            });
            await expect(
              getStoredInstagramPostMetrics(saved.id, 'unrelated-user', {}, injected),
            ).rejects.toMatchObject({ statusCode: 403 });
            await expect(
              getStoredInstagramPostMetrics('missing-post', 'owner-user', {}, injected),
            ).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
            const watched = await tx.instagramProfile.create({
              data: { instagramId: 'watched-ig', username: 'watched' },
            });
            const relation = await tx.instagramCompetitor.create({
              data: { instagramProfileId: 'legacy-profile', competitorProfileId: watched.id },
            });
            expect(
              await readStoredInstagramProfile(watched.id, 'owner-user', injected),
            ).toMatchObject({ id: watched.id, snapshots: [] });
            const watchedPost = await tx.instagramPost.create({
              data: {
                instagramProfileId: watched.id,
                instagramPostId: 'watched-post-ig',
                type: 'reel',
              },
            });
            await tx.instagramPostMetricSnapshot.create({
              data: {
                instagramPostId: watchedPost.id,
                likesCount: 1,
                viewsCount: 123n,
                source: 'initial',
              },
            });
            expect(
              (await getStoredInstagramPostMetrics(watchedPost.id, 'owner-user', {}, injected))
                .metrics[0],
            ).toMatchObject({ source: 'initial', likesCount: 1, viewsCount: 123 });
            await tx.instagramCompetitor.update({
              where: { id: relation.id },
              data: { endedAt: tomorrow },
            });
            await expect(
              readStoredInstagramProfile(watched.id, 'owner-user', injected),
            ).rejects.toMatchObject({ statusCode: 403 });
            await expect(
              getStoredInstagramPostMetrics(watchedPost.id, 'owner-user', {}, injected),
            ).rejects.toMatchObject({ statusCode: 403 });
            await expect(
              readStoredInstagramProfile('missing-profile', 'owner-user', injected),
            ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
            throw rollback;
          },
          { timeout: 75000, maxWait: 10000 },
        );
      } catch (error) {
        if (error !== rollback) throw error;
      }
    } finally {
      try {
        // Verifica o rollback tambem quando uma assercao ou a transacao falha.
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
