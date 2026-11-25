import { describe, expect, it, vi } from 'vitest';
import { withIsolatedPrisma } from './helpers/isolated-prisma.js';
import { authHeaders } from './helpers/auth.js';
import type * as Tracked from '../src/provider/apify/apify.tracked-run.js';
const state = vi.hoisted(() => ({ client: undefined as unknown, factory: vi.fn() }));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => state.client,
}));
vi.mock('../src/provider/apify/apify.tracked-run.js', async (original) => ({
  ...(await original<typeof Tracked>()),
  createTrackedRunGateway: state.factory,
}));
import { buildApp } from '../src/app.js';
import { enqueueDailyBatch } from '../src/modules/instagram/jobs/instagram.daily.repository.js';
import { findProfilesForInstagramRefresh } from '../src/modules/instagram/refresh/instagram.refresh.repository.js';
import { findWatchedCandidates } from '../src/modules/instagram/jobs/instagram.watched-eligibility.repository.js';

describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')(
  'Owner removal, attribution and re-invitation on PostgreSQL',
  () => {
    it('serializes detach, preserves history/incoming watches, cancels pending work and accepts a new invitation/owner', async () => {
      await withIsolatedPrisma('owner_remove_test', async (client, db) => {
        state.client = client;
        const app = buildApp();
        const now = new Date();
        const old = new Date(now.getTime() - 25 * 3600000);
        const service = authHeaders({ sub: 'hustleq-main', scope: 'service' });
        const ownerPath = '/api/v1/internal/instagram/profiles/A/owner';
        const remove = (userId = 'user-A') =>
          app.inject({ method: 'DELETE', url: ownerPath + `?userId=${userId}`, headers: service });
        const assign = (userId: string) =>
          app.inject({ method: 'POST', url: ownerPath, headers: service, payload: { userId } });
        const start = vi.fn().mockResolvedValue({ id: 'new-invite-run', status: 'RUNNING' });
        state.factory.mockReturnValue({
          start,
          get: async () => ({
            id: 'new-invite-run',
            status: 'SUCCEEDED',
            defaultDatasetId: 'fixture',
            usageTotalUsd: 0.0023,
          }),
          items: async () => ({
            total: 1,
            items: [
              {
                id: 'ig-A',
                username: 'alpha',
                fullName: 'Alpha',
                followersCount: 10,
                followsCount: 2,
                postsCount: 1,
                latestPosts: [],
              },
            ],
          }),
        });
        try {
          await db.instagramProfile.createMany({
            data: [
              {
                id: 'A',
                instagramId: 'ig-A',
                username: 'alpha',
                ownerUserId: 'user-A',
                syncStatus: 'ready',
                lastSyncedAt: old,
              },
              {
                id: 'B',
                instagramId: 'ig-B',
                username: 'beta',
                ownerUserId: 'user-A',
                syncStatus: 'ready',
                lastSyncedAt: old,
              },
              { id: 'C', instagramId: 'ig-C', username: 'target' },
              { id: 'D', instagramId: 'ig-D', username: 'other', ownerUserId: 'user-D' },
            ],
          });
          await db.instagramCompetitor.createMany({
            data: [
              { id: 'outgoing', instagramProfileId: 'A', competitorProfileId: 'C' },
              {
                id: 'already-ended',
                instagramProfileId: 'A',
                competitorProfileId: 'B',
                endedAt: old,
              },
              { id: 'incoming', instagramProfileId: 'D', competitorProfileId: 'A' },
            ],
          });
          await db.instagramProfileSnapshot.create({
            data: {
              instagramProfileId: 'A',
              followers: 5,
              following: 2,
              postsCount: 2,
              collectedAt: old,
            },
          });
          await db.instagramPost.createMany({
            data: [
              {
                id: 'post-A',
                instagramProfileId: 'A',
                instagramPostId: 'ig-post-A',
                type: 'photo',
                timestamp: old,
              },
              {
                id: 'post-running-A',
                instagramProfileId: 'A',
                instagramPostId: 'ig-running-A',
                type: 'photo',
                timestamp: old,
              },
              {
                id: 'post-B',
                instagramProfileId: 'B',
                instagramPostId: 'ig-post-B',
                type: 'photo',
                timestamp: old,
              },
            ],
          });
          await db.instagramPostMetricSnapshot.create({
            data: {
              instagramPostId: 'post-A',
              likesCount: 3,
              commentsCount: 1,
              source: 'initial',
              collectedAt: old,
            },
          });
          await db.providerRun.createMany({
            data: [
              {
                id: 'initial-null',
                actor: 'fixture',
                trigger: 'initial',
                instagramProfileId: 'A',
                status: 'succeeded',
                costUsd: '0.01',
              },
              {
                id: 'initial-running-null',
                actor: 'fixture',
                trigger: 'initial',
                instagramProfileId: 'A',
                status: 'running',
              },
              {
                id: 'initial-other-user',
                actor: 'fixture',
                trigger: 'initial',
                instagramProfileId: 'A',
                userId: 'original-payer',
                status: 'succeeded',
                costUsd: '0.03',
              },
              {
                id: 'initial-other-profile',
                actor: 'fixture',
                trigger: 'initial',
                instagramProfileId: 'B',
                status: 'succeeded',
              },
              {
                id: 'search-null',
                actor: 'fixture',
                trigger: 'search',
                instagramProfileId: 'A',
                status: 'succeeded',
              },
            ],
          });
          expect((await assign('user-A')).statusCode).toBe(200);
          expect(
            (await db.providerRun.findUniqueOrThrow({ where: { id: 'initial-null' } })).userId,
          ).toBe('user-A');
          expect(
            (await db.providerRun.findUniqueOrThrow({ where: { id: 'initial-running-null' } }))
              .userId,
          ).toBe('user-A');
          expect(
            (await db.providerRun.findUniqueOrThrow({ where: { id: 'initial-other-user' } }))
              .userId,
          ).toBe('original-payer');
          expect(
            (await db.providerRun.findUniqueOrThrow({ where: { id: 'initial-other-profile' } }))
              .userId,
          ).toBeNull();
          expect(
            (await db.providerRun.findUniqueOrThrow({ where: { id: 'search-null' } })).userId,
          ).toBeNull();
          const shared = await enqueueDailyBatch(['A', 'B'], 'user-A', '2026-11-25', client);
          expect(shared.queued).toBe(2);
          await db.instagramSyncJob.createMany({
            data: [
              {
                id: 'initial-A',
                type: 'INITIAL_PROFILE_SYNC',
                trigger: 'initial',
                instagramProfileId: 'A',
                activeKey: 'profile:A',
              },
              {
                id: 'post-refresh-A',
                type: 'POST_REFRESH',
                trigger: 'refresh',
                instagramPostId: 'post-A',
                activeKey: 'post:post-A',
                userId: 'user-A',
              },
              {
                id: 'post-refresh-B',
                type: 'POST_REFRESH',
                trigger: 'refresh',
                instagramPostId: 'post-B',
                activeKey: 'post:post-B',
                userId: 'user-A',
              },
              {
                id: 'running-A',
                type: 'POST_REFRESH',
                status: 'RUNNING',
                trigger: 'refresh',
                instagramPostId: 'post-running-A',
                activeKey: 'post:post-running-A',
                userId: 'user-A',
                lockedAt: now,
                leaseExpiresAt: new Date(now.getTime() + 600000),
                lockToken: 'running-token',
              },
              {
                id: 'single-daily-A',
                type: 'DAILY_PROFILE_SYNC',
                trigger: 'daily',
                instagramProfileId: 'A',
                activeKey: 'daily:old:A',
                userId: 'user-A',
                payload: {
                  daily: {
                    ownerUserId: 'user-A',
                    date: '2026-11-24',
                    profileIds: ['A'],
                    remainingProfileIds: ['A'],
                  },
                },
              },
            ],
          });
          const history = {
            posts: await db.instagramPost.findMany({ orderBy: { id: 'asc' } }),
            snapshots: await db.instagramProfileSnapshot.findMany(),
            metrics: await db.instagramPostMetricSnapshot.findMany(),
          };
          const before = {
            profile: await db.instagramProfile.findUnique({ where: { id: 'A' } }),
            relations: await db.instagramCompetitor.findMany(),
            jobs: await db.instagramSyncJob.findMany(),
          };
          const mismatch = await remove('wrong-owner');
          expect(mismatch.statusCode).toBe(409);
          expect(mismatch.json().error.code).toBe('OWNER_MISMATCH');
          expect(await db.instagramProfile.findUnique({ where: { id: 'A' } })).toEqual(
            before.profile,
          );
          expect(await db.instagramCompetitor.findMany()).toEqual(before.relations);
          expect(await db.instagramSyncJob.findMany()).toEqual(before.jobs);
          const removed = await Promise.all([remove(), remove()]);
          expect(removed.map((r) => r.statusCode)).toEqual([204, 204]);
          expect(removed.every((r) => r.body === '')).toBe(true);
          expect(
            (await db.instagramProfile.findUniqueOrThrow({ where: { id: 'A' } })).ownerUserId,
          ).toBeNull();
          expect(
            (await db.instagramCompetitor.findUniqueOrThrow({ where: { id: 'outgoing' } })).endedAt,
          ).not.toBeNull();
          expect(
            (await db.instagramCompetitor.findUniqueOrThrow({ where: { id: 'incoming' } })).endedAt,
          ).toBeNull();
          expect(
            (await db.instagramCompetitor.findUniqueOrThrow({ where: { id: 'already-ended' } }))
              .endedAt,
          ).toEqual(old);
          for (const id of ['initial-A', 'post-refresh-A', 'single-daily-A'])
            expect(await db.instagramSyncJob.findUnique({ where: { id } })).toMatchObject({
              status: 'FAILED',
              activeKey: null,
              lastError: 'PROFILE_OWNER_REMOVED',
            });
          expect(
            await db.instagramSyncJob.findUnique({ where: { id: 'running-A' } }),
          ).toMatchObject({ status: 'RUNNING', lockToken: 'running-token' });
          expect(
            await db.instagramSyncJob.findUnique({ where: { id: 'post-refresh-B' } }),
          ).toMatchObject({ status: 'PENDING', activeKey: 'post:post-B' });
          const batch = await db.instagramSyncJob.findUniqueOrThrow({
            where: { id: shared.jobId! },
          });
          expect(batch.status).toBe('PENDING');
          expect(batch.payload).toMatchObject({
            daily: { remainingProfileIds: ['B'], skippedProfileIds: ['A'] },
          });
          expect(await db.instagramPost.findMany({ orderBy: { id: 'asc' } })).toEqual(
            history.posts,
          );
          expect(await db.instagramProfileSnapshot.findMany()).toEqual(history.snapshots);
          expect(await db.instagramPostMetricSnapshot.findMany()).toEqual(history.metrics);
          expect(
            (await findProfilesForInstagramRefresh(new Date(), client)).some((p) => p.id === 'A'),
          ).toBe(false);
          const watched = await findWatchedCandidates(new Date(), client);
          expect(watched.some((p) => p.id === 'C')).toBe(false);
          expect(watched).toContainEqual({ id: 'A', userId: 'user-D' });
          expect(
            (
              await app.inject({
                url: '/api/v1/instagram/profiles/A',
                headers: authHeaders({ sub: 'user-A' }),
              })
            ).statusCode,
          ).toBe(403);
          expect(
            (
              await app.inject({
                url: '/api/v1/instagram/profiles/A',
                headers: authHeaders({ sub: 'user-D' }),
              })
            ).statusCode,
          ).toBe(200);
          expect(start).not.toHaveBeenCalled();
          const reserved = await app.inject({
            method: 'POST',
            url: '/api/v1/internal/instagram/profiles',
            headers: service,
            payload: {
              username: 'alpha',
              inviteId: 'new-invite',
              reservedUntil: new Date(Date.now() + 86400000).toISOString(),
            },
          });
          expect(reserved.statusCode, reserved.body).toBe(201);
          expect(reserved.json().profileId).toBe('A');
          const newJob = await db.instagramSyncJob.findUniqueOrThrow({
            where: { activeKey: 'profile:A' },
          });
          expect(newJob.id).not.toBe('initial-A');
          expect((await remove()).statusCode).toBe(204);
          expect(
            (await db.instagramSyncJob.findUniqueOrThrow({ where: { id: newJob.id } })).status,
          ).toBe('PENDING');
          expect(
            (await db.instagramProfile.findUniqueOrThrow({ where: { id: 'A' } }))
              .reservedForInviteId,
          ).toBe('new-invite');
          expect((await assign('new-owner')).statusCode).toBe(200);
          expect(
            (await db.providerRun.findUniqueOrThrow({ where: { id: 'initial-null' } })).userId,
          ).toBe('user-A');
          expect(
            (await db.providerRun.findFirstOrThrow({ where: { apifyRunId: 'new-invite-run' } }))
              .userId,
          ).toBe('new-owner');
          expect((await remove()).statusCode).toBe(409);
          expect(
            (
              await app.inject({
                url: '/api/v1/instagram/profiles/A',
                headers: authHeaders({ sub: 'new-owner' }),
              })
            ).statusCode,
          ).toBe(200);
        } finally {
          await app.close();
          state.client = undefined;
        }
      });
    }, 300000);
  },
);
