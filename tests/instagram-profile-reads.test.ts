import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { authHeaders } from './helpers/auth.js';
const mock = vi.hoisted(() => ({
  transaction: vi.fn(),
  profile: vi.fn(),
  posts: vi.fn(),
  total: vi.fn(),
  snapshots: vi.fn(),
  apify: vi.fn(),
}));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({ $transaction: mock.transaction }),
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({ createApifyClient: mock.apify }));
import { buildApp } from '../src/app.js';
import type {
  StoredPostRead,
  StoredProfileRead,
} from '../src/modules/instagram/profile/instagram.profile.read.repository.js';

const path = '/api/v1/instagram/profiles/profile-internal';
const collectedAt = new Date('2026-11-19T12:00:00Z');
function profile(): StoredProfileRead {
  return {
    id: 'profile-internal',
    instagramId: '90071992547409931234',
    username: 'example',
    name: 'Example',
    url: null,
    bio: 'Bio',
    profilePhoto: 'https://example.com/photo.jpg',
    category: null,
    isVerified: null,
    syncStatus: 'pending',
    lastSyncedAt: null,
    snapshots: [{ source: null, followers: null, following: 10, postsCount: 2, collectedAt }],
  };
}
function post(): StoredPostRead {
  return {
    id: 'post-internal',
    instagramPostId: '90071992547409939999',
    type: 'reel',
    url: 'https://www.instagram.com/p/fixture/',
    caption: 'caption',
    hashtags: ['rj'],
    displayUrl: null,
    images: [],
    timestamp: collectedAt,
    ownerUsername: 'example',
    metricSnapshots: [
      {
        likesCount: 0,
        likesHidden: false,
        commentsCount: null,
        viewsCount: 3000000000n,
        collectedAt,
      },
    ],
  };
}
let app: ReturnType<typeof buildApp>;
let access: { ownerUserId: string | null; monitoredBy: { id: string }[] } | null;
let savedProfile: StoredProfileRead | null;
let savedPosts: StoredPostRead[];
let tx: Pick<PrismaClient, 'instagramProfile' | 'instagramPost' | 'instagramProfileSnapshot'>;
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  access = { ownerUserId: 'test-client', monitoredBy: [] };
  savedProfile = profile();
  savedPosts = [post()];
  mock.profile.mockImplementation((args: { select: Record<string, unknown> }) =>
    Promise.resolve(args.select.monitoredBy ? access : savedProfile),
  );
  mock.posts.mockImplementation(async () => savedPosts);
  mock.total.mockResolvedValue(1);
  mock.snapshots.mockResolvedValue([
    { source: null, followers: null, following: 10, postsCount: 2, collectedAt },
  ]);
  tx = {
    instagramProfile: { findUnique: mock.profile },
    instagramPost: { findMany: mock.posts, count: mock.total },
    instagramProfileSnapshot: { findMany: mock.snapshots },
  } as unknown as typeof tx;
  mock.transaction.mockImplementation((work: (value: typeof tx) => Promise<unknown>) => work(tx));
});
afterEach(async () => {
  await app.close();
});
const request = (suffix = '') =>
  app.inject({ method: 'GET', url: path + suffix, headers: authHeaders() });

describe('MVP stored profile reads 5, 6 and 7', () => {
  it('returns the saved profile and latest metrics without response wrapper or ownership fields', async () => {
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      id: 'profile-internal',
      instagramId: '90071992547409931234',
      username: 'example',
      name: 'Example',
      url: null,
      bio: 'Bio',
      profilePhoto: 'https://example.com/photo.jpg',
      category: null,
      isVerified: null,
      syncStatus: 'pending',
      lastSyncedAt: null,
      metrics: {
        source: null,
        followers: null,
        following: 10,
        postsCount: 2,
        collectedAt: collectedAt.toISOString(),
      },
    });
    expect(mock.profile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          snapshots: expect.objectContaining({ take: 1, orderBy: { collectedAt: 'desc' } }),
        }),
      }),
    );
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(mock.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    );
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it.each(['initial', 'daily'] as const)(
    'exposes the %s follower snapshot source in profile and history reads',
    async (source) => {
      savedProfile = {
        ...profile(),
        snapshots: [{ source, followers: 42, following: null, postsCount: null, collectedAt }],
      };
      mock.snapshots.mockResolvedValue(savedProfile.snapshots);
      expect((await request()).json().metrics.source).toBe(source);
      expect((await request('/snapshots')).json().snapshots[0].source).toBe(source);
    },
  );
  it('normalizes stored legacy identity and hashtags without updating the database', async () => {
    savedProfile = { ...profile(), username: '@EXAMPLE', name: ' ' };
    savedPosts = [{ ...post(), ownerUsername: '@EXAMPLE', hashtags: ['#RJ', 'rj', '4'] }];
    expect((await request()).json()).toMatchObject({ username: 'example', name: null });
    expect((await request('/posts')).json().posts[0]).toMatchObject({
      ownerUsername: 'example',
      hashtags: ['rj'],
    });
    expect(savedPosts[0]!.hashtags).toEqual(['#RJ', 'rj', '4']);
  });
  it('keeps metrics null before the initial collection without inventing counts', async () => {
    savedProfile = { ...profile(), snapshots: [] };
    const result = await request();
    expect(result.statusCode).toBe(200);
    expect(result.json().metrics).toBeNull();
    expect(result.json().isVerified).toBeNull();
  });
  it.each(['pending', 'syncing', 'ready', 'failed'])(
    'preserves sync status %s and UTC collection time',
    async (syncStatus) => {
      savedProfile = { ...profile(), syncStatus, lastSyncedAt: collectedAt, isVerified: false };
      const result = await request();
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        syncStatus,
        lastSyncedAt: collectedAt.toISOString(),
        isVerified: false,
      });
    },
  );
  it('returns paginated posts with the latest metric and JSON-safe views above INTEGER', async () => {
    mock.total.mockResolvedValue(96);
    const result = await request('/posts');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      profileId: 'profile-internal',
      pagination: { page: 1, limit: 30, total: 96, totalPages: 4 },
      posts: [
        {
          id: 'post-internal',
          instagramPostId: '90071992547409939999',
          type: 'REEL',
          timestamp: collectedAt.toISOString(),
          metrics: {
            likesCount: 0,
            likesHidden: false,
            commentsCount: null,
            viewsCount: 3000000000,
            collectedAt: collectedAt.toISOString(),
          },
        },
      ],
    });
    expect(mock.posts).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 30,
        skip: 0,
        orderBy: [{ timestamp: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        select: expect.objectContaining({
          metricSnapshots: expect.objectContaining({
            take: 1,
            orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
          }),
        }),
      }),
    );
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('uses identical filters for the page and total with an inclusive UTC calendar range', async () => {
    const result = await request('/posts?type=REEL&from=2026-11-01&to=2026-11-19&page=2&limit=50');
    expect(result.statusCode).toBe(200);
    const where = {
      instagramProfileId: 'profile-internal',
      type: 'reel',
      timestamp: { gte: new Date('2026-11-01T00:00:00Z'), lt: new Date('2026-11-20T00:00:00Z') },
    };
    expect(mock.total).toHaveBeenCalledWith({ where });
    expect(mock.posts).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 50, take: 50 }));
  });
  it.each([
    ['IMAGE', 'photo'],
    ['CAROUSEL', 'carousel'],
    ['REEL', 'reel'],
  ])('maps filter %s to stored %s', async (type, stored) => {
    expect((await request(`/posts?type=${type}`)).statusCode).toBe(200);
    expect(mock.posts).toHaveBeenCalledWith(
      expect.objectContaining({ where: { instagramProfileId: 'profile-internal', type: stored } }),
    );
  });
  it('keeps unknown timestamps and metrics null', async () => {
    savedPosts = [
      { ...post(), timestamp: null, metricSnapshots: [], ownerUsername: null, url: null },
    ];
    const result = await request('/posts');
    expect(result.statusCode).toBe(200);
    expect(result.json().posts[0]).toMatchObject({
      timestamp: null,
      metrics: null,
      ownerUsername: null,
      url: null,
    });
  });
  it.each(['photo', 'carousel'] as const)(
    'does not expose views for stored %s posts',
    async (type) => {
      savedPosts = [{ ...post(), type }];
      const result = await request('/posts');
      expect(result.statusCode).toBe(200);
      expect(result.json().posts[0].metrics.viewsCount).toBeNull();
    },
  );
  it('does not expose a hidden like count even if a legacy row contains a value', async () => {
    savedPosts[0]!.metricSnapshots[0]!.likesHidden = true;
    const result = await request('/posts');
    expect(result.json().posts[0].metrics).toMatchObject({ likesCount: null, likesHidden: true });
  });
  it('normalizes the legacy -1 sentinel without updating the saved snapshot', async () => {
    savedPosts[0]!.metricSnapshots[0]!.likesCount = -1;
    const result = await request('/posts');
    expect(result.json().posts[0].metrics).toMatchObject({ likesCount: null, likesHidden: true });
    expect(savedPosts[0]!.metricSnapshots[0]!.likesCount).toBe(-1);
  });
  it('refuses to round views beyond the JSON safe integer range', async () => {
    savedPosts[0]!.metricSnapshots[0]!.viewsCount = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const result = await request('/posts');
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe('INTERNAL_ERROR');
  });
  it('returns an empty page with the filtered total when page exceeds available results', async () => {
    savedPosts = [];
    const result = await request('/posts?page=3&limit=1');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      posts: [],
      pagination: { page: 3, limit: 1, total: 1, totalPages: 1 },
    });
  });
  it('returns zero pages when there are no matching saved posts', async () => {
    savedPosts = [];
    mock.total.mockResolvedValue(0);
    expect((await request('/posts')).json().pagination.totalPages).toBe(0);
  });
  it('returns snapshots in increasing time without pagination or invented gaps', async () => {
    const result = await request('/snapshots?from=2026-11-01&to=2026-11-19');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      profileId: 'profile-internal',
      snapshots: [
        {
          source: null,
          followers: null,
          following: 10,
          postsCount: 2,
          collectedAt: collectedAt.toISOString(),
        },
      ],
    });
    expect(mock.snapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { collectedAt: 'asc' },
        where: {
          instagramProfileId: 'profile-internal',
          collectedAt: {
            gte: new Date('2026-11-01T00:00:00Z'),
            lt: new Date('2026-11-20T00:00:00Z'),
          },
        },
      }),
    );
    expect(mock.snapshots.mock.calls[0]![0]).not.toHaveProperty('take');
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('returns an empty snapshot history with 200', async () => {
    mock.snapshots.mockResolvedValue([]);
    const result = await request('/snapshots');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ profileId: 'profile-internal', snapshots: [] });
  });
  it('accepts ISO timestamp bounds and uses an inclusive precise end', async () => {
    const result = await request('/snapshots?from=2026-11-19T12:00:00Z&to=2026-11-19T12:00:00Z');
    expect(result.statusCode).toBe(200);
    expect(mock.snapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          instagramProfileId: 'profile-internal',
          collectedAt: { gte: collectedAt, lte: collectedAt },
        },
      }),
    );
  });
  it.each(['', '/posts', '/snapshots'])(
    'allows an active watched relation on %s without changing the payload',
    async (suffix) => {
      access = { ownerUserId: 'other', monitoredBy: [{ id: 'active' }] };
      const result = await request(suffix);
      expect(result.statusCode).toBe(200);
      expect(result.body).not.toContain('ownerUserId');
      expect(mock.profile).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            monitoredBy: {
              where: { endedAt: null, instagramProfile: { ownerUserId: 'test-client' } },
              take: 1,
              select: { id: true },
            },
          }),
        }),
      );
    },
  );
  it.each(['', '/posts', '/snapshots'])(
    'rejects missing JWT on %s before database access',
    async (suffix) => {
      const result = await app.inject({ url: path + suffix });
      expect(result.statusCode).toBe(401);
      expect(result.json().error.code).toBe('UNAUTHENTICATED');
      expect(mock.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['', '/posts', '/snapshots'])(
    'rejects service tokens on user route %s',
    async (suffix) => {
      const result = await app.inject({
        url: path + suffix,
        headers: authHeaders({ sub: 'hustleq-main', scope: 'service' }),
      });
      expect(result.statusCode).toBe(403);
      expect(mock.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['', '/posts', '/snapshots'])('returns 404 for unknown profile on %s', async (suffix) => {
    access = null;
    const result = await request(suffix);
    expect(result.statusCode).toBe(404);
    expect(result.json().error.code).toBe('PROFILE_NOT_FOUND');
    expect(mock.posts).not.toHaveBeenCalled();
    expect(mock.snapshots).not.toHaveBeenCalled();
  });
  it.each([null, 'different-user'])(
    'denies an unrelated profile owned by %s before reading its data',
    async (ownerUserId) => {
      access = { ownerUserId, monitoredBy: [] };
      const result = await request('/posts');
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('FORBIDDEN');
      expect(mock.posts).not.toHaveBeenCalled();
      expect(mock.total).not.toHaveBeenCalled();
    },
  );
  it.each(['/posts', '/snapshots'])(
    'does not hide database failures as empty results on %s',
    async (suffix) => {
      mock.transaction.mockRejectedValue(new Error('sensitive database SQL'));
      const result = await request(suffix);
      expect(result.statusCode).toBe(500);
      expect(result.json().error.code).toBe('INTERNAL_ERROR');
      expect(result.body).not.toContain('sensitive');
      expect(mock.apify).not.toHaveBeenCalled();
    },
  );
  it.each([
    '/posts?limit=51',
    '/posts?limit=0',
    '/posts?limit=1.5',
    '/posts?page=0',
    '/posts?page=1.5',
    '/posts?page=9007199254740992',
    '/posts?page=2147483647&limit=50',
    '/posts?type=photo',
    '/posts?from=yesterday',
    '/posts?from=2026-02-30',
    '/posts?from=2026-11-20&to=2026-11-19',
    '/snapshots?from=2026-11-20&to=2026-11-19',
    '/snapshots?to=bad-date',
    '/posts?ownerUserId=someone',
  ])('rejects invalid filters %s before database access', async (suffix) => {
    const result = await request(suffix);
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('INVALID_REQUEST');
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('exposes the three endpoints and response contracts in OpenAPI', async () => {
    await app.ready();
    const document = app.swagger();
    for (const suffix of ['', '/posts', '/snapshots']) {
      const operation = document.paths?.[`/api/v1/instagram/profiles/{profileId}${suffix}`]?.get;
      expect(operation).toBeDefined();
      expect(operation?.responses?.['200']).toBeDefined();
      expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    }
  });
});
