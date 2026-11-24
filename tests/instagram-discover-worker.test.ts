import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstagramSyncJob, PrismaClient, ProviderRun } from '@prisma/client';
import type * as Repo from '../src/modules/instagram/jobs/instagram.discover.repository.js';
import type * as Queue from '../src/modules/instagram/jobs/instagram.sync-job.repository.js';
const m = vi.hoisted(() => ({
  target: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  fail: vi.fn(),
  renew: vi.fn(),
  claim: vi.fn(),
  reclaim: vi.fn(),
}));
vi.mock('../src/modules/instagram/jobs/instagram.discover.repository.js', async (original) => ({
  ...(await original<typeof Repo>()),
  readDiscoverTarget: m.target,
  prepareDiscoverRun: m.prepare,
  commitDiscoverSearch: m.commit,
  failDiscoverSearch: m.fail,
}));
vi.mock('../src/modules/instagram/jobs/instagram.sync-job.repository.js', async (original) => ({
  ...(await original<typeof Queue>()),
  renewInstagramSyncJobLease: m.renew,
  claimNextInstagramSyncJob: m.claim,
  reclaimInstagramSyncJob: m.reclaim,
}));
import {
  processDiscoverSearch,
  runDiscoverWorkerOnce,
} from '../src/modules/instagram/jobs/instagram.discover.service.js';
import { SyncJobOwnershipLost } from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';
const job = {
  id: 'job',
  type: 'DISCOVER_SEARCH',
  lockToken: 'token',
  trigger: 'discover',
} as InstagramSyncJob;
const client = { providerRun: { update: vi.fn() } } as unknown as PrismaClient;
function gateway() {
  return {
    start: vi.fn().mockResolvedValue({ id: 'apify-run', status: 'RUNNING' }),
    get: vi.fn().mockResolvedValue({
      id: 'apify-run',
      status: 'SUCCEEDED',
      defaultDatasetId: 'dataset',
      usageTotalUsd: 0.006,
    }),
    items: vi.fn().mockResolvedValue({ items: [{ recordType: 'post' }], total: 1 }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.target.mockResolvedValue({ keyword: 'food newark' });
  m.renew.mockResolvedValue(true);
  m.prepare.mockResolvedValue({
    run: { id: 'local', apifyRunId: null, status: 'running' } as ProviderRun,
    fresh: true,
  });
  m.commit.mockResolvedValue(undefined);
  m.fail.mockResolvedValue({ status: 'PENDING' });
  m.claim.mockResolvedValue(null);
  m.reclaim.mockResolvedValue(null);
});
describe('Discover Search worker', () => {
  it('requests fifty posts for one combined keyword, all types and last thirty days', async () => {
    const g = gateway();
    expect((await processDiscoverSearch(job, client, g)).status).toBe('succeeded');
    expect(g.start).toHaveBeenCalledWith('seemuapps/instagram-keyword-posts-scraper', {
      keywords: ['food newark'],
      maxPostsPerKeyword: 50,
      postType: 'all',
      minLikes: 0,
      dateFrom: '30 days',
    });
    expect(m.commit).toHaveBeenCalledWith(
      { id: 'job', lockToken: 'token' },
      [{ recordType: 'post' }],
      client,
    );
    expect(client.providerRun.update).toHaveBeenCalledWith({
      where: { id: 'local' },
      data: expect.objectContaining({ costUsd: expect.anything(), status: 'succeeded' }),
    });
  });
  it('allows a genuine empty dataset', async () => {
    const g = gateway();
    g.items.mockResolvedValue({ items: [], total: 0 });
    expect((await processDiscoverSearch(job, client, g)).status).toBe('succeeded');
    expect(m.commit).toHaveBeenCalledWith(expect.anything(), [], client);
  });
  it.each(['notice', 'mixed-limit', 'failed'])(
    'does not cache an operational failure: %s',
    async (mode) => {
      const g = gateway();
      if (mode === 'failed')
        g.get.mockResolvedValue({
          id: 'apify-run',
          status: 'FAILED',
          statusMessage: 'Provider failed',
        } as never);
      else
        g.items.mockResolvedValue({
          items:
            mode === 'notice'
              ? [{ recordType: 'notice', message: 'No access' }]
              : [
                  { recordType: 'post' },
                  { recordType: 'notice', message: 'Free tier: please wait 29 more minutes' },
                ],
          total: mode === 'notice' ? 1 : 2,
        } as never);
      expect((await processDiscoverSearch(job, client, g)).status).toBe('retrying');
      expect(m.commit).not.toHaveBeenCalled();
    },
  );
  it('resumes the known Actor run after lease recovery', async () => {
    const g = gateway();
    m.prepare.mockResolvedValue({
      run: { id: 'local', apifyRunId: 'existing', status: 'running' },
      fresh: false,
    });
    expect((await processDiscoverSearch(job, client, g)).status).toBe('succeeded');
    expect(g.start).not.toHaveBeenCalled();
    expect(g.get).toHaveBeenCalledWith('existing');
  });
  it('does not repeat a start with an uncertain outcome', async () => {
    const g = gateway();
    m.prepare.mockResolvedValue({
      run: { id: 'local', apifyRunId: null, status: 'running' },
      fresh: false,
    });
    expect((await processDiscoverSearch(job, client, g)).status).toBe('retrying');
    expect(g.start).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });
  it('terminates after three failed attempts', async () => {
    const g = gateway();
    g.items.mockRejectedValue(new Error('Failed download'));
    m.fail.mockResolvedValue({ status: 'FAILED' });
    expect((await processDiscoverSearch(job, client, g)).status).toBe('failed');
  });
  it('cannot publish cache after losing its lease', async () => {
    m.renew.mockResolvedValue(false);
    const g = gateway();
    expect((await processDiscoverSearch(job, client, g)).status).toBe('lost');
    expect(g.start).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.fail).not.toHaveBeenCalled();
  });
  it('does not alter state after commit fencing rejects its token', async () => {
    m.commit.mockRejectedValue(new SyncJobOwnershipLost());
    expect((await processDiscoverSearch(job, client, gateway())).status).toBe('lost');
    expect(m.fail).not.toHaveBeenCalled();
  });
  it('reclaims Discover tasks only', async () => {
    m.reclaim.mockResolvedValue(job);
    expect((await runDiscoverWorkerOnce(client, gateway()))?.status).toBe('succeeded');
    expect(m.reclaim).toHaveBeenCalledWith(600000, client, 'DISCOVER_SEARCH');
    expect(m.claim).not.toHaveBeenCalled();
  });
  it('claims only the Discover queue', async () => {
    expect(await runDiscoverWorkerOnce(client, gateway())).toBeNull();
    expect(m.claim).toHaveBeenCalledWith(600000, client, 'DISCOVER_SEARCH');
  });
});
