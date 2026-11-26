import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { withIsolatedPrisma } from './helpers/isolated-prisma.js';
import {
  enqueueInstagramSyncJob,
  claimNextInstagramSyncJob,
} from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import { processInitialProfileSync } from '../src/modules/instagram/jobs/instagram.initial-sync.service.js';
import profile from './fixtures/instagram/profile-sample.json' with { type: 'json' };
import reel from './fixtures/instagram/reel-documentation-sample.json' with { type: 'json' };

describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Initial history on PostgreSQL', () => {
  it('persists more than twelve posts in resumable chunks, tracks three Actors and keeps daily scope separate', async () => {
    await withIsolatedPrisma('initial_history_test', async (client, base) => {
      const record = await base.instagramProfile.create({
        data: { instagramId: profile.id, username: 'example_profile', ownerUserId: 'owner' },
      });
      await enqueueInstagramSyncJob(
        {
          type: 'INITIAL_PROFILE_SYNC',
          trigger: 'initial',
          instagramProfileId: record.id,
          activeKey: `profile:${record.id}`,
        },
        client,
      );
      const job = await claimNextInstagramSyncJob(600000, client, 'INITIAL_PROFILE_SYNC');
      if (!job) throw new Error('Job not claimed');
      const history = Array.from({ length: 35 }, (_, i) => ({
        ...profile.latestPosts[0]!,
        id: `history-${i}`,
        timestamp: new Date(job.createdAt.getTime() - (i + 1) * 86400000).toISOString(),
      }));
      const recentReel = {
        ...reel,
        timestamp: new Date(job.createdAt.getTime() - 86400000).toISOString(),
      };
      const gateway = {
        start: async (actor: string) => ({ id: actor, status: 'RUNNING' }),
        get: async (id: string) => ({
          id,
          status: 'SUCCEEDED',
          defaultDatasetId: id,
          usageTotalUsd: 0.003,
        }),
        items: async (id: string) => {
          const items = id.includes('profile-scraper')
            ? [{ ...profile, latestPosts: [recentReel, history[0]] }]
            : id.includes('post-scraper')
              ? [
                  ...history,
                  history[0],
                  { ...history[0], id: 'foreign', ownerId: 'another-profile' },
                  {
                    ...history[0],
                    id: 'old',
                    timestamp: new Date(job.createdAt.getTime() - 91 * 86400000).toISOString(),
                  },
                ]
              : [recentReel];
          return { items, total: items.length };
        },
      };
      expect(await processInitialProfileSync(job, client, gateway)).toMatchObject({
        status: 'succeeded',
        history: { returnedCount: 36, limitReached: false },
      });
      expect(await base.instagramPost.count()).toBe(36);
      expect(await base.instagramPostMetricSnapshot.count({ where: { source: 'initial' } })).toBe(
        36,
      );
      expect(await base.instagramProfileSnapshot.findFirst()).toMatchObject({
        source: 'initial',
        followers: 425,
      });
      expect(
        await base.instagramPostMetricSnapshot.findFirst({
          where: { instagramPost: { instagramPostId: reel.id } },
        }),
      ).toMatchObject({ viewsCount: 809683n });
      expect(await base.instagramProfile.findUnique({ where: { id: record.id } })).toMatchObject({
        syncStatus: 'ready',
      });
      const saved = await base.instagramSyncJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(saved).toMatchObject({
        status: 'SUCCEEDED',
        payload: { initialHistory: { savedPostIds: expect.any(Array) } },
      });
      expect(
        await base.providerRun.count({
          where: { userId: 'owner', trigger: 'initial', status: 'succeeded' },
        }),
      ).toBe(3);
      expect(await processInitialProfileSync(job, client, gateway)).toMatchObject({
        status: 'lost',
      });
      expect(await base.instagramPostMetricSnapshot.count()).toBe(36);
    });
  }, 300000);
  it('adds nullable source to existing follower snapshots without changing their values', async () => {
    await withIsolatedPrisma('snapshot_source_test', async (client) => {
      await client.$transaction(async (tx) => {
        const profile = await tx.instagramProfile.create({
          data: { instagramId: 'legacy', username: 'legacy' },
        });
        await tx.$executeRawUnsafe('ALTER TABLE "InstagramProfileSnapshot" DROP COLUMN "source"');
        const collectedAt = new Date('2026-11-01T00:00:00Z');
        await tx.$executeRaw`INSERT INTO "InstagramProfileSnapshot" (id, "instagramProfileId", followers, "collectedAt") VALUES ('legacy-snapshot', ${profile.id}, 42, ${collectedAt})`;
        const sql = await readFile(
          new URL(
            '../prisma/migrations/20261126000000_add_profile_snapshot_source/migration.sql',
            import.meta.url,
          ),
          'utf8',
        );
        await tx.$executeRawUnsafe(sql);
        expect(
          await tx.instagramProfileSnapshot.findUnique({ where: { id: 'legacy-snapshot' } }),
        ).toMatchObject({ source: null, followers: 42, collectedAt });
      });
    });
  }, 180000);
});
