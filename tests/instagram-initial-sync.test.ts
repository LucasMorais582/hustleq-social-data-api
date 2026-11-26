import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstagramSyncJob, PrismaClient, ProviderRun } from '@prisma/client';
import type * as InitialRepo from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';
import type * as QueueRepo from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import profileFixture from './fixtures/instagram/profile-sample.json' with { type: 'json' };
import reelFixture from './fixtures/instagram/reel-documentation-sample.json' with { type: 'json' };
const m = vi.hoisted(() => ({
  begin: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  fail: vi.fn(),
  renew: vi.fn(),
  claim: vi.fn(),
  reclaim: vi.fn(),
}));
vi.mock('../src/modules/instagram/jobs/instagram.initial-sync.repository.js', async (original) => ({
  ...(await original<typeof InitialRepo>()),
  beginInitialProfileSync: m.begin,
  prepareInitialSyncRun: m.prepare,
  commitInitialProfileSync: m.commit,
  failInitialProfileSync: m.fail,
}));
vi.mock('../src/modules/instagram/jobs/instagram.sync-job.repository.js', async (original) => ({
  ...(await original<typeof QueueRepo>()),
  renewInstagramSyncJobLease: m.renew,
  claimNextInstagramSyncJob: m.claim,
  reclaimInitialProfileSyncJob: m.reclaim,
}));
import {
  initialProfileCollection,
  initialReelUrls,
  processInitialProfileSync,
  runInitialSyncWorkerOnce,
} from '../src/modules/instagram/jobs/instagram.initial-sync.service.js';
import { SyncJobOwnershipLost } from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';
const now = new Date('2026-11-23T12:00:00Z');
const job = {
  id: 'job',
  type: 'INITIAL_PROFILE_SYNC',
  instagramProfileId: 'internal-profile',
  lockToken: 'token',
  createdAt: now,
} as InstagramSyncJob;
const client = {
  providerRun: { update: vi.fn().mockResolvedValue({}) },
} as unknown as PrismaClient;
const rawProfile = () => ({
  ...profileFixture,
  latestPosts: [
    ...profileFixture.latestPosts,
    { ...reelFixture, timestamp: '2026-11-20T12:00:00.000Z' },
  ],
});
function gateway() {
  return {
    start: vi.fn().mockImplementation(async (actor: string) => ({
      id: actor.includes('profile')
        ? 'profile-run'
        : actor.includes('post-scraper')
          ? 'posts-run'
          : 'reels-run',
      status: 'RUNNING',
    })),
    get: vi.fn().mockImplementation(async (id: string) => ({
      id,
      status: 'SUCCEEDED',
      defaultDatasetId: id,
      usageTotalUsd: 0.0023,
    })),
    items: vi.fn().mockImplementation(async (id: string) => ({
      items: id === 'profile-run' ? [rawProfile()] : id === 'posts-run' ? [] : [reelFixture],
      total: id === 'posts-run' ? 0 : 1,
    })),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.renew.mockResolvedValue(true);
  m.begin.mockResolvedValue({
    id: 'internal-profile',
    instagramId: profileFixture.id,
    username: 'example_profile',
    history: {
      from: new Date(now.getTime() - 90 * 86400000).toISOString(),
      to: now.toISOString(),
      limit: 500,
      savedPostIds: [],
      limitReached: false,
    },
  });
  m.prepare.mockImplementation(async (_owner: unknown, step: string) => ({
    run: { id: `local-${step}`, apifyRunId: null } as ProviderRun,
    fresh: true,
  }));
  m.commit.mockResolvedValue(undefined);
  m.fail.mockResolvedValue({ status: 'PENDING' });
  m.reclaim.mockResolvedValue(null);
  m.claim.mockResolvedValue(null);
});
describe('Initial Profile Sync', () => {
  it('requests the durable 90-day window and configured ceiling from the Post Scraper', async () => {
    const g = gateway();
    await processInitialProfileSync(job, client, g);
    expect(g.start).toHaveBeenNthCalledWith(2, 'apify/instagram-post-scraper', {
      username: ['example_profile'],
      resultsLimit: 500,
      onlyPostsNewerThan: new Date(now.getTime() - 90 * 86400000).toISOString(),
      skipPinnedPosts: false,
      includeMusicData: false,
    });
    expect(m.prepare).toHaveBeenCalledWith(
      expect.any(Object),
      'history-reels',
      'apify/instagram-reel-scraper',
      client,
    );
  });
  it('keeps more than twelve own posts in the window, including its boundary, and rejects older/future/unknown dates', () => {
    const from = new Date(now.getTime() - 90 * 86400000);
    const post = profileFixture.latestPosts[0]!;
    const recent = Array.from({ length: 40 }, (_, i) => ({
      ...post,
      id: `recent-${i}`,
      timestamp: new Date(now.getTime() - i * 86400000).toISOString(),
    }));
    const result = initialProfileCollection(
      {
        ...profileFixture,
        latestPosts: [
          { ...post, id: 'boundary', timestamp: from.toISOString() },
          { ...post, id: 'old-pinned', timestamp: new Date(from.getTime() - 1).toISOString() },
          { ...post, id: 'future', timestamp: new Date(now.getTime() + 1).toISOString() },
          { ...post, id: 'unknown', timestamp: null },
          { ...recent[0]!, id: 'foreign', ownerId: 'another-profile' },
          ...recent,
          recent[0]!,
        ],
      },
      profileFixture.id,
      [],
      now,
      { from: from.toISOString(), to: now.toISOString(), limit: 500 },
    );
    expect(result.posts).toHaveLength(41);
    expect(result.posts.at(-1)?.instagramPostId).toBe('boundary');
    expect(result.posts[0]?.instagramPostId).toBe('recent-0');
  });
  it('caps sorted history, reports a reached ceiling, and enriches only the retained Reels', async () => {
    m.begin.mockResolvedValue({
      id: 'internal-profile',
      instagramId: profileFixture.id,
      username: 'example_profile',
      history: {
        from: '2026-08-25T12:00:00.000Z',
        to: now.toISOString(),
        limit: 2,
      },
    });
    const g = gateway();
    g.items.mockImplementation(async (id) => {
      const items =
        id === 'profile-run'
          ? [rawProfile()]
          : id === 'posts-run'
            ? [1, 2, 3].map((n) => ({
                ...profileFixture.latestPosts[0]!,
                id: `new-${n}`,
                timestamp: `2026-11-${20 + n}T12:00:00.000Z`,
              }))
            : [];
      return { items, total: items.length };
    });
    expect(await processInitialProfileSync(job, client, g)).toMatchObject({
      status: 'succeeded',
      history: { returnedCount: 2, limitReached: true },
    });
    expect(
      m.commit.mock.calls[0]![1].posts.map(
        (post: { instagramPostId: string }) => post.instagramPostId,
      ),
    ).toEqual(['new-3', 'new-2']);
    expect(g.start).toHaveBeenCalledTimes(2);
  });
  it('does not silently replace a failed historical collection with only the twelve recent posts', async () => {
    const g = gateway();
    g.items.mockImplementation(async (id) => {
      if (id === 'posts-run') throw new Error('historical collection failed');
      return { items: [rawProfile()], total: 1 };
    });
    expect(await processInitialProfileSync(job, client, g)).toMatchObject({ status: 'retrying' });
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('sorts by publication date, ignores posts from other authors and saves only twelve returned posts', () => {
    const posts = Array.from({ length: 15 }, (_, i) => ({
      ...profileFixture.latestPosts[0]!,
      id: String(i),
      timestamp: `2026-11-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
    }));
    const result = initialProfileCollection(
      {
        ...profileFixture,
        latestPosts: [{ ...posts[0]!, ownerId: 'other', id: 'foreign' }, ...posts],
      },
      profileFixture.id,
      [],
      now,
    );
    expect(result.posts).toHaveLength(12);
    expect(result.posts.map((post) => post.instagramPostId)).toEqual([
      '14',
      '13',
      '12',
      '11',
      '10',
      '9',
      '8',
      '7',
      '6',
      '5',
      '4',
      '3',
    ]);
    expect(result).toMatchObject({ metricSource: 'initial', refreshRecentPostsLimit: 12 });
  });
  it('uses Reel Scraper views only, preserves nulls/zero and normalizes profile fields', () => {
    const result = initialProfileCollection(rawProfile(), profileFixture.id, [reelFixture], now);
    expect(result.profile).toMatchObject({
      username: 'example_profile',
      name: null,
      isVerified: null,
      profilePhoto: 'https://example.com/profile.jpg',
    });
    expect(result.posts.find((post) => post.type === 'reel')).toMatchObject({
      viewsCount: 809683n,
      likesCount: null,
      likesHidden: true,
    });
    expect(result.posts.find((post) => post.type === 'photo')?.viewsCount).toBeNull();
    expect(initialReelUrls(result)).toEqual(['https://www.instagram.com/reel/Fixture_Reel/']);
  });
  it.each([
    { ...reelFixture, ownerId: 'other' },
    { ...reelFixture, id: 'unexpected' },
  ])('rejects unrelated enrichment', (reel) => {
    expect(() => initialProfileCollection(rawProfile(), profileFixture.id, [reel], now)).toThrow(
      'inesperado',
    );
  });
  it('keeps unknown views null if the Reel Scraper omits the field', () => {
    const result = initialProfileCollection(
      rawProfile(),
      profileFixture.id,
      [{ ...reelFixture, videoPlayCount: null, videoViewCount: null }],
      now,
    );
    expect(result.posts.find((post) => post.type === 'reel')?.viewsCount).toBeNull();
  });
  it('does not request arbitrary external URLs or downloads', () => {
    const collection = initialProfileCollection(rawProfile(), profileFixture.id, [], now);
    collection.posts.find((post) => post.type === 'reel')!.url = 'https://example.com/reel/foo';
    expect(initialReelUrls(collection)).toEqual([]);
  });
  it('executes profile then selected Reel URLs and commits the complete collection once', async () => {
    const g = gateway();
    expect(await processInitialProfileSync(job, client, g)).toMatchObject({ status: 'succeeded' });
    expect(g.start).toHaveBeenNthCalledWith(
      3,
      'apify/instagram-reel-scraper',
      expect.objectContaining({
        username: ['https://www.instagram.com/reel/Fixture_Reel/'],
        includeTranscript: false,
        includeDownloadedVideo: false,
      }),
    );
    expect(m.commit).toHaveBeenCalledWith(
      { id: job.id, lockToken: job.lockToken },
      expect.objectContaining({
        metricSource: 'initial',
        posts: expect.arrayContaining([expect.objectContaining({ viewsCount: 809683n })]),
      }),
      client,
      false,
      expect.any(Function),
    );
    expect(m.fail).not.toHaveBeenCalled();
  });
  it('does not call the Reel Actor for a profile without Reels', async () => {
    const g = gateway();
    g.items.mockImplementation(async (id) => ({
      items: id === 'profile-run' ? [profileFixture] : [],
      total: id === 'profile-run' ? 1 : 0,
    }));
    expect(await processInitialProfileSync(job, client, g)).toMatchObject({ status: 'succeeded' });
    expect(g.start).toHaveBeenCalledTimes(2);
  });
  it('keeps previous data and schedules retry on provider or identity errors', async () => {
    const g = gateway();
    g.items.mockResolvedValue({
      items: [{ ...profileFixture, id: 'different-instagram-id' }],
      total: 1,
    });
    expect(await processInitialProfileSync(job, client, g)).toMatchObject({ status: 'retrying' });
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.fail).toHaveBeenCalledWith(expect.any(Object), 'PROVIDER_INVALID_RESPONSE', client);
  });
  it('handles a private profile without treating it as a successful sync', async () => {
    const g = gateway();
    g.items.mockResolvedValue({ items: [{ private: true }], total: 1 });
    await processInitialProfileSync(job, client, g);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.fail).toHaveBeenCalledWith(expect.any(Object), 'PROFILE_PRIVATE', client);
  });
  it('does not persist results after ownership is lost', async () => {
    m.renew.mockResolvedValue(false);
    const g = gateway();
    expect(await processInitialProfileSync(job, client, g)).toMatchObject({ status: 'lost' });
    expect(g.start).not.toHaveBeenCalled();
    expect(m.fail).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('does not mark failure through a stale lease after the final transaction rejects it', async () => {
    m.commit.mockRejectedValue(new SyncJobOwnershipLost());
    expect(await processInitialProfileSync(job, client, gateway())).toMatchObject({
      status: 'lost',
    });
    expect(m.fail).not.toHaveBeenCalled();
  });
  it('reports a final failure and does not log raw storage details', async () => {
    m.commit.mockRejectedValue(new Error('secret database SQL'));
    m.fail.mockResolvedValue({ status: 'FAILED' });
    expect(await processInitialProfileSync(job, client, gateway())).toMatchObject({
      status: 'failed',
    });
    expect(m.fail).toHaveBeenCalledWith(expect.any(Object), 'INITIAL_SYNC_FAILED', client);
  });
  it('does not bootstrap collections from every pending profile or consume other job types', async () => {
    expect(await runInitialSyncWorkerOnce(client, gateway())).toBeNull();
    expect(m.claim).toHaveBeenCalledWith(600000, client, 'INITIAL_PROFILE_SYNC');
  });
});
