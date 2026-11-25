import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrackedRun from '../src/provider/apify/apify.tracked-run.js';
import profileFixture from './fixtures/instagram/profile-sample.json' with { type: 'json' };
import { authHeaders } from './helpers/auth.js';
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  profileFind: vi.fn(),
  clock: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  factory: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  items: vi.fn(),
}));
const tx = { instagramProfile: { findUnique: m.profileFind }, $queryRaw: m.clock };
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({
    $transaction: m.transaction,
    providerRun: { create: m.runCreate, update: m.runUpdate },
  }),
}));
vi.mock('../src/provider/apify/apify.tracked-run.js', async (original) => ({
  ...(await original<typeof TrackedRun>()),
  createTrackedRunGateway: m.factory,
}));
import { buildApp } from '../src/app.js';
let app: ReturnType<typeof buildApp>;
const path = '/api/v1/instagram/profiles/search';
const search = (query = 'username=%40EXAMPLE_PROFILE') =>
  app.inject({ url: `${path}?${query}`, headers: authHeaders({ sub: 'searcher-user' }) });
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  m.transaction.mockImplementation((work: (value: typeof tx) => Promise<unknown>) => work(tx));
  m.profileFind.mockResolvedValue(null);
  m.clock.mockImplementation(async () => [{ now: new Date() }]);
  m.runCreate.mockResolvedValue({ id: 'search-run', status: 'running', apifyRunId: null });
  m.runUpdate.mockResolvedValue({});
  m.factory.mockReturnValue({ start: m.start, get: m.get, items: m.items });
  m.start.mockResolvedValue({ id: 'apify-run', status: 'RUNNING' });
  m.get.mockResolvedValue({
    id: 'apify-run',
    status: 'SUCCEEDED',
    defaultDatasetId: 'dataset',
    usageTotalUsd: 0.0023,
  });
  m.items.mockResolvedValue({ items: [profileFixture], total: 1 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});
describe('GET profiles/search, MVP endpoint 1', () => {
  it('returns normalized identity/metrics and available without registering or reserving the profile', async () => {
    const result = await search();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      profileId: null,
      instagramId: profileFixture.id,
      username: 'example_profile',
      name: null,
      bio: profileFixture.biography,
      profilePhoto: profileFixture.profilePicUrl,
      isVerified: null,
      followers: 425,
      following: 899,
      postsCount: 15,
      ownershipStatus: 'available',
    });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(m.start).toHaveBeenCalledWith('apify/instagram-profile-scraper', {
      usernames: ['example_profile'],
    });
    expect(m.factory).toHaveBeenCalledWith({ timeout: 20, waitForFinish: 2, timeoutSecs: 5 });
    // O mock de banco nao oferece mutacoes de perfil/post/snapshot/reserva/fila.
    expect(m.profileFind).toHaveBeenCalledWith({
      where: { instagramId: profileFixture.id },
      select: { id: true, ownerUserId: true, reservedForInviteId: true, reservedUntil: true },
    });
    expect(m.runCreate).toHaveBeenCalledWith({
      data: {
        actor: 'apify/instagram-profile-scraper',
        trigger: 'search',
        status: 'running',
        userId: 'searcher-user',
      },
    });
    expect(m.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    );
    expect(result.json()).not.toHaveProperty('ownerUserId');
    expect(result.json().profileId).toBeNull();
  });
  it.each([0, 0.0023, 0.123456])(
    'persists the actual search usageTotalUsd=%s without estimating price',
    async (usageTotalUsd) => {
      m.get.mockResolvedValue({
        id: 'apify-run',
        status: 'SUCCEEDED',
        defaultDatasetId: 'dataset',
        usageTotalUsd,
      });
      expect((await search()).statusCode).toBe(200);
      const costWrite = m.runUpdate.mock.calls.find(([arg]) => arg.data.costUsd !== undefined);
      expect(costWrite).toBeDefined();
      expect(costWrite![0].data.costUsd.toString()).toBe(String(usageTotalUsd));
    },
  );
  it.each([
    ['searcher-user', 'owned_by_me'],
    ['someone-else', 'owned_by_other'],
  ])('compares owner %s to JWT identity: %s', async (ownerUserId, expected) => {
    m.profileFind.mockResolvedValue({
      id: 'stored-profile-id',
      ownerUserId,
      reservedForInviteId: 'invite',
      reservedUntil: new Date(Date.now() + 60000),
    });
    const response = (await search()).json();
    expect(response.ownershipStatus).toBe(expected);
    expect(response.profileId).toBe('stored-profile-id');
    expect(m.clock).not.toHaveBeenCalled();
  });
  it('reports an active reservation without exposing its invitation or owner', async () => {
    m.profileFind.mockResolvedValue({
      id: 'stored-profile-id',
      ownerUserId: null,
      reservedForInviteId: 'secret-invite',
      reservedUntil: new Date(Date.now() + 60000),
    });
    const result = await search();
    expect(result.json().ownershipStatus).toBe('reserved');
    expect(result.body).not.toContain('secret-invite');
    expect(result.body).not.toContain('reservedUntil');
  });
  it.each([-1, 0])(
    'considers a reservation expired %s ms from database time available',
    async (offset) => {
      const now = new Date();
      m.clock.mockResolvedValue([{ now }]);
      m.profileFind.mockResolvedValue({
        id: 'stored-profile-id',
        ownerUserId: null,
        reservedForInviteId: 'invite',
        reservedUntil: new Date(now.getTime() + offset),
      });
      expect((await search()).json().ownershipStatus).toBe('available');
    },
  );
  it.each([
    { ownerUserId: null, reservedForInviteId: null, reservedUntil: null },
    { ownerUserId: null, reservedForInviteId: 'invite', reservedUntil: null },
    { ownerUserId: null, reservedForInviteId: null, reservedUntil: new Date(Date.now() + 60000) },
  ])('does not invent an active reservation from incomplete metadata', async (profile) => {
    m.profileFind.mockResolvedValue({ ...profile, id: 'stored-profile-id' });
    expect((await search()).json().ownershipStatus).toBe('available');
  });
  it.each([
    { items: [], total: 0 },
    { items: [{ error: 'not_found' }], total: 1 },
  ])(
    'returns only username/not_found with 200 for an absent Instagram profile',
    async (dataset) => {
      m.items.mockResolvedValue(dataset);
      const result = await search();
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        profileId: null,
        username: 'example_profile',
        ownershipStatus: 'not_found',
      });
      expect(m.profileFind).not.toHaveBeenCalled();
    },
  );
  it('preserves the existing explicit 404 PROFILE_PRIVATE contract', async () => {
    m.items.mockResolvedValue({ items: [{ private: true }], total: 1 });
    const result = await search();
    expect(result.statusCode).toBe(404);
    expect(result.json().error.code).toBe('PROFILE_PRIVATE');
  });
  it('keeps missing counters and verification null, while zero remains zero', async () => {
    m.items.mockResolvedValue({
      items: [{ ...profileFixture, followersCount: null, followsCount: 0, postsCount: undefined }],
      total: 1,
    });
    expect((await search()).json()).toMatchObject({
      followers: null,
      following: 0,
      postsCount: null,
      isVerified: null,
    });
  });
  it('never returns availability when the provider supplies a different identity', async () => {
    m.items.mockResolvedValue({ items: [{ ...profileFixture, username: 'unexpected' }], total: 1 });
    const result = await search();
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(m.profileFind).not.toHaveBeenCalled();
  });
  it('returns RATE_LIMITED with the provider message for a notice-only refusal', async () => {
    m.items.mockResolvedValue({
      items: [{ recordType: 'notice', message: 'Free tier: please wait 29 more minutes' }],
      total: 1,
    });
    const result = await search();
    expect(result.statusCode).toBe(429);
    expect(result.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('29'),
    });
  });
  it('does not disguise a failed Actor as a missing profile', async () => {
    m.get.mockResolvedValue({ id: 'apify-run', status: 'FAILED', usageTotalUsd: 0.0001 });
    const result = await search();
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('PROVIDER_UNAVAILABLE');
  });
  it('maps dataset/network failures to provider unavailable instead of not_found', async () => {
    m.items.mockRejectedValue(new Error('socket closed'));
    const result = await search();
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(m.profileFind).not.toHaveBeenCalled();
  });
  it('stops waiting when the search budget expires, preserving the known execution id', async () => {
    const now = Date.now();
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now + offset);
    m.start.mockImplementation(async () => {
      offset = 26000;
      return { id: 'known-run', status: 'RUNNING' };
    });
    const result = await search();
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(m.runUpdate).toHaveBeenCalledWith({
      where: { id: 'search-run' },
      data: { apifyRunId: 'known-run' },
    });
    expect(m.get).not.toHaveBeenCalled();
    expect(m.profileFind).not.toHaveBeenCalled();
  });
  it('does not claim availability or invent not_found when the ownership database is unavailable', async () => {
    m.profileFind.mockRejectedValue(new Error('private SQL details'));
    const result = await search();
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe('INTERNAL_ERROR');
    expect(result.body).not.toContain('private SQL');
  });
  it('does not spend provider credits if audit persistence fails first', async () => {
    m.runCreate.mockRejectedValue(new Error('database unavailable'));
    expect((await search()).statusCode).toBe(500);
    expect(m.start).not.toHaveBeenCalled();
  });
  it.each([
    '',
    'username=',
    'username=@@example',
    'username=bad%2Fname',
    'username=example&userId=other',
    'username=example&limit=20',
    'username=example&ownershipStatus=available',
  ])('rejects an invalid/extra query before provider execution: %s', async (query) => {
    expect((await search(query)).statusCode).toBe(400);
    expect(m.runCreate).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    authHeaders({ sub: 'hustleq-main', scope: 'service' }),
    authHeaders({ sub: 'searcher-user', scope: 'OWNER' }),
    authHeaders({ exp: Math.floor(Date.now() / 1000) - 1 }),
  ])('requires an authenticated user and rejects service or expired tokens', async (headers) => {
    const result = await app.inject({
      url: `${path}?username=example`,
      ...(headers ? { headers } : {}),
    });
    expect([401, 403]).toContain(result.statusCode);
    expect(m.runCreate).not.toHaveBeenCalled();
  });
  it('publishes the new GET contract without replacing the legacy POST', async () => {
    await app.ready();
    const spec = app.swagger() as { paths: Record<string, unknown> };
    expect(spec.paths[path]).toHaveProperty('get');
    expect(spec.paths['/api/v1/instagram/profile/search']).toHaveProperty('post');
  });
});
