import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstagramSyncJob, PrismaClient, ProviderRun } from '@prisma/client';
import type * as Repo from '../src/modules/instagram/jobs/instagram.post-refresh.repository.js';
import type * as Queue from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
import reel from './fixtures/instagram/reel-documentation-sample.json' with { type: 'json' };
import carousel from './fixtures/instagram/post-carousel-sample.json' with { type: 'json' };
const m = vi.hoisted(() => ({
  target: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  fail: vi.fn(),
  renew: vi.fn(),
  claim: vi.fn(),
  reclaim: vi.fn(),
}));
vi.mock('../src/modules/instagram/jobs/instagram.post-refresh.repository.js', async (original) => ({
  ...(await original<typeof Repo>()),
  readPostRefreshTarget: m.target,
  preparePostRefreshRun: m.prepare,
  commitPostRefresh: m.commit,
  failPostRefresh: m.fail,
}));
vi.mock('../src/modules/instagram/jobs/instagram.sync-job.repository.js', async (original) => ({
  ...(await original<typeof Queue>()),
  renewInstagramSyncJobLease: m.renew,
  claimNextInstagramSyncJob: m.claim,
  reclaimInstagramSyncJob: m.reclaim,
}));
import {
  processPostRefresh,
  runPostRefreshWorkerOnce,
} from '../src/modules/instagram/jobs/instagram.post-refresh.service.js';
import { SyncJobOwnershipLost } from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';
const job = {
  id: 'job',
  type: 'POST_REFRESH',
  lockToken: 'token',
  instagramPostId: 'post',
  trigger: 'refresh',
} as InstagramSyncJob;
const client = { providerRun: { update: vi.fn() } } as unknown as PrismaClient;
function gateway() {
  return {
    start: vi.fn().mockResolvedValue({ id: 'apify-run', status: 'RUNNING' }),
    get: vi.fn().mockResolvedValue({
      id: 'apify-run',
      status: 'SUCCEEDED',
      defaultDatasetId: 'dataset',
      usageTotalUsd: 0.0026,
    }),
    items: vi.fn().mockResolvedValue({ items: [reel], total: 1 }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.renew.mockResolvedValue(true);
  m.target.mockResolvedValue({
    id: 'post',
    instagramPostId: reel.id,
    type: 'reel',
    url: `https://www.instagram.com/p/${reel.shortCode}/`,
    instagramProfile: { instagramId: reel.ownerId },
  });
  m.prepare.mockResolvedValue({
    run: { id: 'local', status: 'running', apifyRunId: null } as ProviderRun,
    fresh: true,
  });
  m.commit.mockResolvedValue(undefined);
  m.fail.mockResolvedValue({ status: 'PENDING' });
  m.claim.mockResolvedValue(null);
  m.reclaim.mockResolvedValue(null);
});
describe('durable Post Refresh worker', () => {
  it('uses Reel Scraper for a single canonical URL and preserves hidden likes', async () => {
    const g = gateway();
    expect(await processPostRefresh(job, client, g)).toEqual({ status: 'succeeded', jobId: 'job' });
    expect(g.start).toHaveBeenCalledWith('apify/instagram-reel-scraper', {
      username: [`https://www.instagram.com/reel/${reel.shortCode}/`],
      resultsLimit: 1,
      includeSharesCount: false,
      includeTranscript: false,
      includeDownloadedVideo: false,
    });
    expect(m.commit).toHaveBeenCalledWith(
      { id: 'job', lockToken: 'token' },
      expect.objectContaining({
        id: reel.id,
        likesCount: null,
        likesHidden: true,
        commentsCount: null,
        viewsCount: reel.videoPlayCount,
      }),
      client,
    );
    expect(client.providerRun.update).toHaveBeenCalledWith({
      where: { id: 'local' },
      data: expect.objectContaining({ status: 'succeeded' }),
    });
  });
  it.each(['carousel', 'photo'] as const)(
    'uses a post URL for %s without importing views',
    async (type) => {
      const g = gateway();
      const raw = { ...carousel, type: type === 'carousel' ? 'Sidecar' : 'Image' };
      m.target.mockResolvedValue({
        instagramPostId: raw.id,
        type,
        url: `https://www.instagram.com/p/${raw.shortCode}/`,
        instagramProfile: { instagramId: raw.ownerId },
      });
      g.items.mockResolvedValue({ items: [raw] as unknown as (typeof reel)[], total: 1 });
      expect((await processPostRefresh(job, client, g)).status).toBe('succeeded');
      expect(g.start).toHaveBeenCalledWith('apify/instagram-scraper', {
        directUrls: [`https://www.instagram.com/p/${raw.shortCode}/`],
        resultsType: 'posts',
        resultsLimit: 1,
        addParentData: false,
      });
      expect(m.commit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ likesCount: 0, viewsCount: null }),
        client,
      );
    },
  );
  it.each(
    [
      [],
      [{ ...reel, id: 'wrong' }],
      [{ ...reel, ownerId: 'wrong' }],
      [{ ...reel, type: 'Image', productType: undefined }],
      [reel, reel],
      [{ error: 'not_found' }],
    ].map((items) => ({ items })),
  )('preserves history on invalid/mismatched output $items', async ({ items }) => {
    const g = gateway();
    g.items.mockResolvedValue({ items: items as (typeof reel)[], total: items.length });
    expect((await processPostRefresh(job, client, g)).status).toBe('retrying');
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.fail).toHaveBeenCalled();
  });
  it('resumes a known run instead of starting a second charged execution', async () => {
    const g = gateway();
    m.prepare.mockResolvedValue({
      run: { id: 'local', apifyRunId: 'known', status: 'succeeded' },
      fresh: false,
    });
    expect((await processPostRefresh(job, client, g)).status).toBe('succeeded');
    expect(g.start).not.toHaveBeenCalled();
    expect(g.get).toHaveBeenCalledWith('known');
  });
  it('does not repeat an ambiguous POST after recovery', async () => {
    const g = gateway();
    m.prepare.mockResolvedValue({
      run: { id: 'local', apifyRunId: null, status: 'running' },
      fresh: false,
    });
    expect((await processPostRefresh(job, client, g)).status).toBe('retrying');
    expect(g.start).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('does not overwrite metrics if the actor fails or is rate limited', async () => {
    const g = gateway();
    g.get.mockResolvedValue({
      id: 'apify-run',
      status: 'FAILED',
      statusMessage: 'Please wait 29 more minutes',
    } as never);
    expect((await processPostRefresh(job, client, g)).status).toBe('retrying');
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('finishes after the third failed attempt', async () => {
    const g = gateway();
    g.items.mockRejectedValue(new Error('download failed'));
    m.fail.mockResolvedValue({ status: 'FAILED' });
    expect((await processPostRefresh(job, client, g)).status).toBe('failed');
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('does not update snapshots after losing its lease', async () => {
    const g = gateway();
    m.renew.mockResolvedValue(false);
    expect((await processPostRefresh(job, client, g)).status).toBe('lost');
    expect(g.start).not.toHaveBeenCalled();
    expect(m.fail).not.toHaveBeenCalled();
  });
  it('does not write failure with an obsolete token after commit fencing', async () => {
    m.commit.mockRejectedValue(new SyncJobOwnershipLost());
    expect((await processPostRefresh(job, client, gateway())).status).toBe('lost');
    expect(m.fail).not.toHaveBeenCalled();
  });
  it('reclaims only post refresh jobs, without consuming another attempt', async () => {
    m.reclaim.mockResolvedValue(job);
    expect((await runPostRefreshWorkerOnce(client, gateway()))?.status).toBe('succeeded');
    expect(m.reclaim).toHaveBeenCalledWith(600000, client, 'POST_REFRESH');
    expect(m.claim).not.toHaveBeenCalled();
  });
  it('claims only POST_REFRESH tasks', async () => {
    expect(await runPostRefreshWorkerOnce(client, gateway())).toBeNull();
    expect(m.claim).toHaveBeenCalledWith(600000, client, 'POST_REFRESH');
  });
});
