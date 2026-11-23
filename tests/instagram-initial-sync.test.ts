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
  latestPosts: [...profileFixture.latestPosts, reelFixture],
});
function gateway() {
  return {
    start: vi.fn().mockImplementation(async (actor: string) => ({
      id: actor.includes('profile') ? 'profile-run' : 'reels-run',
      status: 'RUNNING',
    })),
    get: vi.fn().mockImplementation(async (id: string) => ({
      id,
      status: 'SUCCEEDED',
      defaultDatasetId: id,
      usageTotalUsd: 0.0023,
    })),
    items: vi.fn().mockImplementation(async (id: string) => ({
      items: id === 'profile-run' ? [rawProfile()] : [reelFixture],
      total: 1,
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
      2,
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
    );
    expect(m.fail).not.toHaveBeenCalled();
  });
  it('does not call the Reel Actor for a profile without Reels', async () => {
    const g = gateway();
    g.items.mockResolvedValue({ items: [profileFixture], total: 1 });
    expect(await processInitialProfileSync(job, client, g)).toMatchObject({ status: 'succeeded' });
    expect(g.start).toHaveBeenCalledTimes(1);
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
