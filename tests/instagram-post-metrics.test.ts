import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstagramMediaType } from '@prisma/client';
import { authHeaders } from './helpers/auth.js';
const mock = vi.hoisted(() => ({
  transaction: vi.fn(),
  post: vi.fn(),
  profile: vi.fn(),
  metrics: vi.fn(),
  apify: vi.fn(),
}));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({ $transaction: mock.transaction }),
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({ createApifyClient: mock.apify }));
import { buildApp } from '../src/app.js';
const path = '/api/v1/instagram/posts/post-internal/metrics';
const firstDate = new Date('2026-11-17T12:00:00Z');
const lastDate = new Date('2026-11-18T12:00:00Z');
function samples() {
  return [
    {
      likesCount: null,
      likesHidden: true,
      commentsCount: null,
      viewsCount: 3000000000n as bigint | null,
      collectedAt: firstDate,
      source: 'initial' as string | null,
    },
    {
      likesCount: 12 as number | null,
      likesHidden: false,
      commentsCount: 0 as number | null,
      viewsCount: 3000000001n as bigint | null,
      collectedAt: lastDate,
      source: 'daily' as string | null,
    },
  ];
}
let app: ReturnType<typeof buildApp>;
let savedPost: { instagramProfileId: string; type: InstagramMediaType } | null;
let access: { ownerUserId: string | null; monitoredBy: { id: string }[] } | null;
let rows: ReturnType<typeof samples>;
const tx = {
  instagramPost: { findUnique: mock.post },
  instagramProfile: { findUnique: mock.profile },
  instagramPostMetricSnapshot: { findMany: mock.metrics },
};
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  savedPost = { instagramProfileId: 'profile-internal', type: 'reel' };
  access = { ownerUserId: 'test-client', monitoredBy: [] };
  rows = samples();
  mock.transaction.mockImplementation((work: (value: typeof tx) => Promise<unknown>) => work(tx));
  mock.post.mockImplementation(async () => savedPost);
  mock.profile.mockImplementation(async () => access);
  mock.metrics.mockImplementation(async () => rows);
});
afterEach(async () => {
  await app.close();
});
const request = (query = '') => app.inject({ url: path + query, headers: authHeaders() });

describe('GET post metrics history, MVP endpoint 9', () => {
  it('returns all saved snapshots with normalized counts, UTC dates and source', async () => {
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      postId: 'post-internal',
      metrics: [
        {
          likesCount: null,
          likesHidden: true,
          commentsCount: null,
          viewsCount: 3000000000,
          collectedAt: firstDate.toISOString(),
          source: 'initial',
        },
        {
          likesCount: 12,
          likesHidden: false,
          commentsCount: 0,
          viewsCount: 3000000001,
          collectedAt: lastDate.toISOString(),
          source: 'daily',
        },
      ],
    });
    expect(mock.metrics).toHaveBeenCalledWith({
      where: { instagramPostId: 'post-internal' },
      select: {
        likesCount: true,
        likesHidden: true,
        commentsCount: true,
        viewsCount: true,
        collectedAt: true,
        source: true,
      },
      orderBy: [{ collectedAt: 'asc' }, { id: 'asc' }],
    });
    expect(mock.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    );
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('returns 200 and an empty list when the saved post has no snapshots', async () => {
    rows = [];
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ postId: 'post-internal', metrics: [] });
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it.each(['initial', 'daily', 'on_open', 'refresh', null])(
    'preserves snapshot source %s',
    async (source) => {
      rows = [{ ...samples()[1]!, source }];
      const result = await request();
      expect(result.statusCode).toBe(200);
      expect(result.json().metrics[0].source).toBe(source);
    },
  );
  it('does not invent sources for old snapshots or refresh stale data', async () => {
    rows = [{ ...samples()[1]!, source: null, collectedAt: new Date('2020-01-01T00:00:00Z') }];
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(result.json().metrics[0]).toMatchObject({
      source: null,
      collectedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('filters by collection date, with a UTC whole-day upper bound, without pagination', async () => {
    const result = await request('?from=2026-11-01&to=2026-11-18');
    expect(result.statusCode).toBe(200);
    expect(mock.metrics).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          instagramPostId: 'post-internal',
          collectedAt: {
            gte: new Date('2026-11-01T00:00:00Z'),
            lt: new Date('2026-11-19T00:00:00Z'),
          },
        },
      }),
    );
    expect(mock.metrics.mock.calls[0]![0]).not.toHaveProperty('take');
    expect(mock.metrics.mock.calls[0]![0]).not.toHaveProperty('skip');
  });
  it('supports inclusive ISO instant bounds with an offset', async () => {
    const instant = encodeURIComponent('2026-11-18T09:00:00-03:00');
    const result = await request(`?from=${instant}&to=${instant}`);
    expect(result.statusCode).toBe(200);
    expect(mock.metrics).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instagramPostId: 'post-internal', collectedAt: { gte: lastDate, lte: lastDate } },
      }),
    );
  });
  it('keeps zero counts different from missing metrics', async () => {
    rows = [{ ...samples()[1]!, likesCount: 0, viewsCount: 0n, commentsCount: null }];
    expect((await request()).json().metrics[0]).toMatchObject({
      likesCount: 0,
      likesHidden: false,
      viewsCount: 0,
      commentsCount: null,
    });
  });
  it('normalizes the legacy hidden-likes sentinel without rewriting history', async () => {
    rows = [{ ...samples()[1]!, likesCount: -1 }];
    const result = await request();
    expect(result.json().metrics[0]).toMatchObject({ likesCount: null, likesHidden: true });
    expect(rows[0]!.likesCount).toBe(-1);
  });
  it.each(['photo', 'carousel'] as const)('does not expose stored views for %s', async (type) => {
    savedPost!.type = type;
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(
      result.json().metrics.map((metric: { viewsCount: unknown }) => metric.viewsCount),
    ).toEqual([null, null]);
  });
  it('does not round views beyond safe JSON integer precision', async () => {
    rows = [{ ...samples()[1]!, viewsCount: BigInt(Number.MAX_SAFE_INTEGER) + 1n }];
    const result = await request();
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe('INTERNAL_ERROR');
  });
  it('refuses malformed stored sources rather than relabeling snapshots', async () => {
    rows = [{ ...samples()[1]!, source: 'unknown-source' }];
    const result = await request();
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe('INTERNAL_ERROR');
  });
  it('does not leak internal snapshot fields from repository records', async () => {
    mock.metrics.mockResolvedValue([
      { ...samples()[1], ownerUserId: 'secret', id: 'snapshot-private', internal: 'private' },
    ]);
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('ownerUserId');
    expect(result.body).not.toContain('snapshot-private');
  });
  it('authorizes watched posts through an active relation from a profile owned by the JWT user', async () => {
    access = { ownerUserId: 'other-user', monitoredBy: [{ id: 'active' }] };
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(mock.profile).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'profile-internal' },
        select: expect.objectContaining({
          monitoredBy: {
            where: { endedAt: null, instagramProfile: { ownerUserId: 'test-client' } },
            take: 1,
            select: { id: true },
          },
        }),
      }),
    );
  });
  it('returns POST_NOT_FOUND before reading metrics or profile for a missing internal post ID', async () => {
    savedPost = null;
    const result = await request();
    expect(result.statusCode).toBe(404);
    expect(result.json().error.code).toBe('POST_NOT_FOUND');
    expect(mock.profile).not.toHaveBeenCalled();
    expect(mock.metrics).not.toHaveBeenCalled();
  });
  it.each([null, 'unrelated-user'])(
    'denies access to post from a profile owned by %s before fetching metrics',
    async (ownerUserId) => {
      access = { ownerUserId, monitoredBy: [] };
      const result = await request();
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('FORBIDDEN');
      expect(mock.metrics).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, authHeaders({ exp: Math.floor(Date.now() / 1000) - 1 })])(
    'rejects absent or expired authentication before database access',
    async (headers) => {
      const result = await app.inject({ url: path, ...(headers ? { headers } : {}) });
      expect(result.statusCode).toBe(401);
      expect(mock.transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects service tokens on this user-scoped route', async () => {
    const result = await app.inject({
      url: path,
      headers: authHeaders({ sub: 'hustleq-main', scope: 'service' }),
    });
    expect(result.statusCode).toBe(403);
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it.each([
    '?from=yesterday',
    '?to=2026-02-30',
    '?from=2026-11-19&to=2026-11-18',
    '?page=1',
    '?limit=50',
    '?userId=someone-else',
  ])('rejects invalid history query %s', async (query) => {
    const result = await request(query);
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('INVALID_REQUEST');
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('returns an error rather than empty history after database failures', async () => {
    mock.metrics.mockRejectedValue(new Error('sensitive SQL credentials'));
    const result = await request();
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe('INTERNAL_ERROR');
    expect(result.body).not.toContain('sensitive');
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('exposes the response and access requirements in OpenAPI', async () => {
    await app.ready();
    const operation = app.swagger().paths?.['/api/v1/instagram/posts/{postId}/metrics']?.get;
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
  });
});
