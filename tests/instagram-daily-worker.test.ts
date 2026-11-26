import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstagramSyncJob, PrismaClient, ProviderRun } from '@prisma/client';
import type * as Repo from '../src/modules/instagram/jobs/instagram.daily.repository.js';
import type * as Queue from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import profile from './fixtures/instagram/profile-sample.json' with { type: 'json' };
import reel from './fixtures/instagram/reel-documentation-sample.json' with { type: 'json' };
const m = vi.hoisted(() => ({
  targets: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  finish: vi.fn(),
  renew: vi.fn(),
  claim: vi.fn(),
  reclaim: vi.fn(),
}));
vi.mock('../src/modules/instagram/jobs/instagram.daily.repository.js', async (original) => ({
  ...(await original<typeof Repo>()),
  readDailyTargets: m.targets,
  prepareDailyRun: m.prepare,
  commitDailyProfile: m.commit,
  finishDailyAttempt: m.finish,
}));
vi.mock('../src/modules/instagram/jobs/instagram.sync-job.repository.js', async (original) => ({
  ...(await original<typeof Queue>()),
  renewInstagramSyncJobLease: m.renew,
  claimNextInstagramSyncJob: m.claim,
  reclaimInstagramSyncJob: m.reclaim,
}));
import {
  processDailySync,
  runDailySyncWorkerOnce,
} from '../src/modules/instagram/jobs/instagram.daily.service.js';
import { SyncJobOwnershipLost } from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';
const job = {
  id: 'batch',
  type: 'DAILY_PROFILE_SYNC',
  lockToken: 'token',
  attempts: 1,
} as InstagramSyncJob;
const client = { providerRun: { update: vi.fn() } } as unknown as PrismaClient;
const targets = [
  { id: 'first', instagramId: profile.id, username: 'example_profile' },
  { id: 'second', instagramId: 'second-external', username: 'second' },
];
function gateway() {
  return {
    start: vi.fn().mockImplementation(async (actor: string) => ({
      id: actor.includes('profile') ? 'profiles-run' : 'reels-run',
      status: 'RUNNING',
    })),
    get: vi.fn().mockImplementation(async (id: string) => ({
      id,
      status: 'SUCCEEDED',
      defaultDatasetId: id,
      usageTotalUsd: 0.006,
    })),
    items: vi.fn().mockImplementation(async (id: string) => ({
      items:
        id === 'profiles-run'
          ? [
              { ...profile, latestPosts: [reel, ...profile.latestPosts] },
              { ...profile, id: 'second-external', username: 'second', latestPosts: [] },
            ]
          : [reel],
      total: id === 'profiles-run' ? 2 : 1,
    })),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.targets.mockResolvedValue(targets);
  m.renew.mockResolvedValue(true);
  m.prepare.mockImplementation(async (_owner, step) => ({
    run: { id: `local-${step}`, apifyRunId: null } as ProviderRun,
    fresh: true,
  }));
  m.commit.mockResolvedValue(undefined);
  m.finish.mockResolvedValue({ status: 'SUCCEEDED', updated: 2 });
  m.claim.mockResolvedValue(null);
  m.reclaim.mockResolvedValue(null);
});
describe('Daily Profile Sync batching', () => {
  it('collects profiles in one call and batches their reels, preserving daily source and New York calendar snapshots', async () => {
    const g = gateway();
    expect(await processDailySync(job, client, g)).toMatchObject({
      status: 'succeeded',
      updated: 2,
    });
    expect(g.start).toHaveBeenCalledWith('apify/instagram-profile-scraper', {
      usernames: ['example_profile', 'second'],
    });
    expect(g.start).toHaveBeenCalledTimes(2);
    expect(m.commit).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'first',
      expect.objectContaining({
        metricSource: 'daily',
        profileSnapshotCadence: 'new-york-day',
        refreshRecentPostsLimit: 12,
        posts: expect.arrayContaining([expect.objectContaining({ viewsCount: 809683n })]),
      }),
      client,
    );
    expect(m.commit).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'second',
      expect.objectContaining({ metricSource: 'daily' }),
      client,
    );
  });
  it('saves good profiles when another profile is private', async () => {
    const g = gateway();
    g.items.mockImplementation(async (id) => ({
      items:
        id === 'profiles-run'
          ? [
              { ...profile, latestPosts: [] },
              { username: 'second', private: true },
            ]
          : [],
      total: id === 'profiles-run' ? 2 : 0,
    }));
    m.finish.mockResolvedValue({ status: 'PENDING', updated: 1 });
    expect((await processDailySync(job, client, g)).status).toBe('retrying');
    expect(m.commit).toHaveBeenCalledTimes(1);
    expect(m.finish).toHaveBeenCalledWith(
      expect.anything(),
      { second: 'PROFILE_PRIVATE' },
      undefined,
      client,
    );
  });
  it('never saves a profile whose username now belongs to a different Instagram ID', async () => {
    const g = gateway();
    g.items.mockResolvedValue({
      items: [{ ...profile, id: 'wrong', username: 'example_profile' }],
      total: 1,
    });
    await processDailySync(job, client, g);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.finish.mock.calls[0]![1]).toMatchObject({
      first: 'PROVIDER_INVALID_RESPONSE',
      second: 'PROVIDER_INVALID_RESPONSE',
    });
  });
  it('uses already-paid runs when retrying only the remaining subset', async () => {
    const g = gateway();
    m.targets.mockResolvedValue([targets[1]]);
    m.prepare.mockResolvedValue({
      run: { id: 'local-profile', apifyRunId: 'profiles-run', status: 'succeeded' },
      fresh: false,
    });
    await processDailySync(job, client, g);
    expect(g.start).not.toHaveBeenCalled();
    expect(m.commit).toHaveBeenCalledTimes(1);
    expect(m.commit.mock.calls[0]![1]).toBe('second');
  });
  it('completes a batch whose profiles became ineligible without starting an Actor', async () => {
    m.targets.mockResolvedValue([]);
    const g = gateway();
    expect((await processDailySync(job, client, g)).status).toBe('succeeded');
    expect(g.start).not.toHaveBeenCalled();
    expect(m.prepare).not.toHaveBeenCalled();
  });
  it('does not turn a Reel error row into a successful snapshot with null views', async () => {
    const g = gateway();
    const original = g.items.getMockImplementation()!;
    g.items.mockImplementation(async (id) =>
      id === 'reels-run' ? { items: [{ error: 'not_found' }], total: 1 } : original(id),
    );
    m.finish.mockResolvedValue({ status: 'PENDING', updated: 0 });
    expect((await processDailySync(job, client, g)).status).toBe('retrying');
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('keeps previous data when the Reel Actor fails', async () => {
    const g = gateway();
    g.get.mockImplementation(async (id) => ({
      id,
      status: id === 'reels-run' ? 'FAILED' : 'SUCCEEDED',
      defaultDatasetId: id,
      usageTotalUsd: 0.002,
    }));
    m.finish.mockResolvedValue({ status: 'PENDING', updated: 0 });
    expect((await processDailySync(job, client, g)).status).toBe('retrying');
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('rejects views from the wrong author', async () => {
    const g = gateway();
    const original = g.items.getMockImplementation()!;
    g.items.mockImplementation(async (id) =>
      id === 'reels-run' ? { items: [{ ...reel, ownerId: 'foreign' }], total: 1 } : original(id),
    );
    await processDailySync(job, client, g);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.finish).toHaveBeenCalledWith(
      expect.anything(),
      {},
      'PROVIDER_INVALID_RESPONSE',
      client,
    );
  });
  it('preserves null views if the provider omits a requested reel', async () => {
    const g = gateway();
    const original = g.items.getMockImplementation()!;
    g.items.mockImplementation(async (id) =>
      id === 'reels-run' ? { items: [], total: 0 } : original(id),
    );
    await processDailySync(job, client, g);
    expect(
      m.commit.mock.calls[0]![2].posts.find((p: { type: string }) => p.type === 'reel').viewsCount,
    ).toBeNull();
  });
  it('never starts a new charged run after an uncertain start', async () => {
    const g = gateway();
    m.prepare.mockResolvedValue({
      run: { id: 'local', apifyRunId: null, status: 'running' },
      fresh: false,
    });
    m.finish.mockResolvedValue({ status: 'PENDING', updated: 0 });
    expect((await processDailySync(job, client, g)).status).toBe('retrying');
    expect(g.start).not.toHaveBeenCalled();
  });
  it('finishes after the third failed attempt without changing profile syncStatus', async () => {
    const g = gateway();
    g.start.mockRejectedValue(new Error('uncertain'));
    m.finish.mockResolvedValue({ status: 'FAILED', updated: 0 });
    expect((await processDailySync(job, client, g)).status).toBe('failed');
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('does not persist or retry with a lost lease', async () => {
    m.renew.mockResolvedValue(false);
    const g = gateway();
    expect((await processDailySync(job, client, g)).status).toBe('lost');
    expect(g.start).not.toHaveBeenCalled();
    expect(m.finish).not.toHaveBeenCalled();
  });
  it('leaves already committed profiles intact after a subsequent ownership loss', async () => {
    m.commit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new SyncJobOwnershipLost());
    expect((await processDailySync(job, client, gateway())).status).toBe('lost');
    expect(m.finish).not.toHaveBeenCalled();
  });
  it('claims Daily tasks only and prioritizes lease recovery', async () => {
    m.reclaim.mockResolvedValue(job);
    expect((await runDailySyncWorkerOnce(client, gateway()))?.status).toBe('succeeded');
    expect(m.reclaim).toHaveBeenCalledWith(600000, client, 'DAILY_PROFILE_SYNC');
    expect(m.claim).not.toHaveBeenCalled();
  });
  it('returns idle when no Daily task is due', async () => {
    expect(await runDailySyncWorkerOnce(client, gateway())).toBeNull();
    expect(m.claim).toHaveBeenCalledWith(600000, client, 'DAILY_PROFILE_SYNC');
  });
});
