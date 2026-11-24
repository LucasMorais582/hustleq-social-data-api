import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders } from './helpers/auth.js';
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  query: vi.fn(),
  post: vi.fn(),
  profile: vi.fn(),
  active: vi.fn(),
  run: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  apify: vi.fn(),
}));
const tx = {
  $queryRaw: m.query,
  instagramPost: { findUniqueOrThrow: m.post },
  instagramProfile: { findUnique: m.profile },
  instagramSyncJob: { findUnique: m.active, count: m.count, create: m.create },
  providerRun: { findFirst: m.run },
};
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({ $transaction: m.transaction }),
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({ createApifyClient: m.apify }));
import { buildApp } from '../src/app.js';
import { canonicalPostUrl } from '../src/modules/instagram/post/instagram.post.refresh.repository.js';
const now = new Date('2026-11-23T23:59:59.999Z');
const path = '/api/v1/instagram/posts/post';
let app: ReturnType<typeof buildApp>;
let post: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  post = {
    id: 'post',
    instagramPostId: 'external-post',
    instagramProfileId: 'profile',
    type: 'photo',
    url: 'https://www.instagram.com/p/ABC/',
    caption: null,
    hashtags: [],
    displayUrl: null,
    images: [],
    timestamp: null,
    ownerUsername: null,
    lastCollectedAt: new Date(now.getTime() - 1000),
    metricSnapshots: [
      {
        likesCount: 0,
        likesHidden: false,
        commentsCount: null,
        viewsCount: null,
        collectedAt: new Date('2026-11-23T12:00:00Z'),
      },
    ],
  };
  m.transaction.mockImplementation((work: (value: typeof tx) => unknown) => work(tx));
  m.query.mockImplementation(async (query: TemplateStringsArray) =>
    query.join('').includes('clock_timestamp') ? [{ now }] : [{ id: 'post' }],
  );
  m.post.mockImplementation(async () => post);
  m.profile.mockResolvedValue({ ownerUserId: 'test-client', monitoredBy: [] });
  m.active.mockResolvedValue(null);
  m.run.mockResolvedValue(null);
  m.count.mockResolvedValue(0);
  m.create.mockResolvedValue({ id: 'job' });
});
afterEach(async () => {
  await app.close();
});
const get = () => app.inject({ url: path, headers: authHeaders() });
const refresh = () =>
  app.inject({ method: 'POST', url: path + '/refresh', headers: authHeaders() });

describe('MVP post read/refresh endpoints 8 and 10', () => {
  it('returns the stored post directly if less than 24h old', async () => {
    const result = await get();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      id: 'post',
      type: 'IMAGE',
      metrics: { likesCount: 0, commentsCount: null },
    });
    expect(result.json()).not.toHaveProperty('instagramProfileId');
    expect(result.json()).not.toHaveProperty('lastCollectedAt');
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(m.create).not.toHaveBeenCalled();
    expect(m.apify).not.toHaveBeenCalled();
  });
  it.each([86400000, 86400001, null, -1000])('queues on_open for age %s', async (age) => {
    post.lastCollectedAt = age === null ? null : new Date(now.getTime() - age);
    const result = await get();
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({ status: 'refreshing', post: { id: 'post' } });
    expect(m.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'POST_REFRESH',
        trigger: 'on_open',
        instagramPostId: 'post',
        userId: 'test-client',
        activeKey: 'post:post',
        createdAt: now,
      }),
    });
    expect(m.count).not.toHaveBeenCalled();
    expect(m.apify).not.toHaveBeenCalled();
  });
  it('does not refresh at 24h minus one millisecond', async () => {
    post.lastCollectedAt = new Date(now.getTime() - 86400000 + 1);
    expect((await get()).statusCode).toBe(200);
  });
  it('queues a manual refresh even for fresh metrics and uses UTC quota boundaries', async () => {
    expect((await refresh()).json()).toEqual({ status: 'refreshing' });
    expect(m.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ trigger: 'refresh' }),
    });
    expect(m.count).toHaveBeenCalledWith({
      where: {
        type: 'POST_REFRESH',
        trigger: 'refresh',
        userId: 'test-client',
        createdAt: { gte: new Date('2026-11-23T00:00:00Z'), lt: new Date('2026-11-24T00:00:00Z') },
      },
    });
    expect(m.count.mock.calls[0]![0].where).not.toHaveProperty('status');
    expect(m.query.mock.calls[0]![0].join('')).toContain('pg_advisory_xact_lock');
  });
  it.each(['job', 'run'])(
    'deduplicates an active %s before checking quota, including fresh GET',
    async (kind) => {
      if (kind === 'job') m.active.mockResolvedValue({ id: 'running-or-pending' });
      else m.run.mockResolvedValue({ id: 'running' });
      m.count.mockResolvedValue(100);
      expect((await get()).statusCode).toBe(202);
      expect((await refresh()).statusCode).toBe(202);
      expect(m.count).not.toHaveBeenCalled();
      expect(m.create).not.toHaveBeenCalled();
      expect(m.run).toHaveBeenCalledWith({
        where: {
          instagramPostId: 'post',
          status: 'running',
          startedAt: { gt: new Date(now.getTime() - 600000) },
        },
        select: { id: true },
      });
    },
  );
  it('returns 429 after ten accepted tasks, even failed ones', async () => {
    m.count.mockResolvedValue(10);
    const result = await refresh();
    expect(result.statusCode).toBe(429);
    expect(result.json().error.code).toBe('MANUAL_REFRESH_LIMIT_REACHED');
    expect(m.create).not.toHaveBeenCalled();
  });
  it('allows the tenth task', async () => {
    m.count.mockResolvedValue(9);
    expect((await refresh()).statusCode).toBe(202);
  });
  it.each(['GET', 'POST'] as const)('requires authentication for %s', async (method) => {
    expect(
      (await app.inject({ method, url: method === 'GET' ? path : path + '/refresh' })).statusCode,
    ).toBe(401);
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it('does not accept service tokens', async () => {
    expect(
      (
        await app.inject({
          url: path,
          headers: authHeaders({ sub: 'hustleq-main', scope: 'service' }),
        })
      ).statusCode,
    ).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it('returns 404 for a missing internal post id', async () => {
    m.query.mockResolvedValue([]);
    expect((await get()).json().error.code).toBe('POST_NOT_FOUND');
    expect(m.create).not.toHaveBeenCalled();
  });
  it('denies access to an unrelated profile', async () => {
    m.profile.mockResolvedValue({ ownerUserId: 'other', monitoredBy: [] });
    expect((await refresh()).statusCode).toBe(403);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.count).not.toHaveBeenCalled();
  });
  it('allows an active COMPETITOR scope', async () => {
    m.profile.mockResolvedValue({ ownerUserId: 'other', monitoredBy: [{ id: 'active-relation' }] });
    expect((await refresh()).statusCode).toBe(202);
  });
  it('keeps historical views hidden for non-reels', async () => {
    (post.metricSnapshots as { viewsCount: bigint }[])[0]!.viewsCount = 99n;
    expect((await get()).json().metrics.viewsCount).toBeNull();
  });
  it('rejects unsupported saved URLs without creating a job', async () => {
    post.url = 'https://example.com/p/ABC/';
    expect((await refresh()).statusCode).toBe(503);
    expect(m.create).not.toHaveBeenCalled();
  });
  it('hides queue/database failures', async () => {
    m.create.mockRejectedValue(new Error('secret SQL'));
    const response = await refresh();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret');
  });
  it.each([{ username: 'forged' }, { source: 'initial' }])(
    'rejects refresh body %j',
    async (payload) => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path + '/refresh',
            headers: authHeaders(),
            payload,
          })
        ).statusCode,
      ).toBe(400);
      expect(m.transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects extra GET query parameters', async () => {
    expect(
      (await app.inject({ url: path + '?userId=other', headers: authHeaders() })).statusCode,
    ).toBe(400);
  });
  it('canonicalizes Instagram URLs and never forwards query tokens', () => {
    expect(canonicalPostUrl('https://instagram.com/p/ABC/?token=secret', 'reel')).toBe(
      'https://www.instagram.com/reel/ABC/',
    );
  });
});
