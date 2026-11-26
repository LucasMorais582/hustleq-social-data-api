import { describe, expect, it } from 'vitest';
import { withIsolatedPrisma } from './helpers/isolated-prisma.js';
import { enqueueDailyBatch } from '../src/modules/instagram/jobs/instagram.daily.repository.js';
import { saveProfileCollection } from '../src/modules/instagram/profile/instagram.profile.repository.js';
import {
  getInstagramLocalDate,
  newYorkDayBounds,
} from '../src/modules/instagram/shared/instagram.snapshot-day.js';

describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')('Daily calendar on PostgreSQL', () => {
  it('ignores recent lastSyncedAt, saves the missing day and prevents concurrent duplicates', async () => {
    await withIsolatedPrisma('daily_calendar_test', async (client, base) => {
      const now = new Date();
      const date = getInstagramLocalDate(now);
      const { from } = newYorkDayBounds(date);
      const profile = await base.instagramProfile.create({
        data: {
          instagramId: 'calendar-profile',
          username: 'calendar_test',
          ownerUserId: 'owner',
          lastSyncedAt: now,
        },
      });
      await base.instagramProfileSnapshot.create({
        data: {
          instagramProfileId: profile.id,
          followers: 10,
          collectedAt: new Date(from.getTime() - 60000),
        },
      });
      expect(await enqueueDailyBatch([profile.id], 'owner', date, client)).toMatchObject({
        queued: 1,
        notDue: 0,
      });
      const collection = {
        collectedAt: now,
        profileSnapshotCadence: 'new-york-day' as const,
        metricSource: 'daily' as const,
        profile: {
          instagramId: profile.instagramId,
          username: profile.username,
          name: null,
          url: null,
          bio: null,
          profilePhoto: null,
          category: null,
          isVerified: null,
          followers: 11,
          following: null,
          postsCount: null,
        },
        posts: [],
      };
      await Promise.all([
        saveProfileCollection(collection, client),
        saveProfileCollection(collection, client),
      ]);
      const snapshots = await base.instagramProfileSnapshot.findMany({
        where: { instagramProfileId: profile.id },
        orderBy: { collectedAt: 'asc' },
      });
      expect(snapshots.map((snapshot) => snapshot.followers)).toEqual([10, 11]);
      expect(await enqueueDailyBatch([profile.id], 'owner', date, client)).toMatchObject({
        queued: 0,
        notDue: 1,
      });
    });
  }, 180000);
});
