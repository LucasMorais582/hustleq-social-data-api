import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrackedRun from '../src/provider/apify/apify.tracked-run.js';
import { authHeaders } from './helpers/auth.js';
import profileFixture from './fixtures/instagram/profile-sample.json' with { type: 'json' };
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  clock: vi.fn(),
  find: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  link: vi.fn(),
  jobFind: vi.fn(),
  jobUpsert: vi.fn(),
  gatewayFactory: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  items: vi.fn(),
}));
const tx = {
  $queryRaw: m.clock,
  instagramProfile: { findUnique: m.find, upsert: m.upsert, update: m.update },
  providerRun: { updateMany: m.link },
  instagramSyncJob: { findUnique: m.jobFind, upsert: m.jobUpsert },
};
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({
    $transaction: m.transaction,
    providerRun: { create: m.runCreate, update: m.runUpdate },
  }),
}));
vi.mock('../src/provider/apify/apify.tracked-run.js', async (original) => ({
  ...(await original<typeof TrackedRun>()),
  createTrackedRunGateway: m.gatewayFactory,
}));
import { buildApp } from '../src/app.js';
const path = '/api/v1/internal/instagram/profiles';
const serviceHeaders = () => authHeaders({ sub: 'hustleq-main', scope: 'service' });
let app: ReturnType<typeof buildApp>;
let profile: Record<string, unknown>;
const body = () => ({
  username: '@EXAMPLE_PROFILE',
  inviteId: 'external-invite',
  reservedUntil: new Date(Date.now() + 172800000).toISOString(),
});
const post = (payload: unknown = body()) =>
  app.inject({ method: 'POST', url: path, headers: serviceHeaders(), payload: payload as object });
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  profile = {
    id: 'profile-internal',
    username: 'example_profile',
    instagramId: profileFixture.id,
    ownerUserId: null,
    syncStatus: 'pending',
    lastSyncedAt: null,
    reservedForInviteId: null,
    reservedUntil: null,
  };
  m.transaction.mockImplementation((work: (value: typeof tx) => Promise<unknown>) => work(tx));
  m.clock.mockImplementation(async () => [{ now: new Date() }]);
  m.find.mockResolvedValue(null);
  m.upsert.mockImplementation(async () => profile);
  m.link.mockResolvedValue({ count: 1 });
  m.jobFind.mockResolvedValue(null);
  m.jobUpsert.mockResolvedValue({ id: 'sync-job', status: 'PENDING' });
  m.runCreate.mockResolvedValue({ id: 'verified-run', status: 'running', apifyRunId: null });
  m.runUpdate.mockResolvedValue({});
  m.gatewayFactory.mockReturnValue({ start: m.start, get: m.get, items: m.items });
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
  await app.close();
});
describe('POST internal profiles, MVP endpoint 2', () => {
  it('confirms identity, reserves and queues the same execution without collecting snapshots in the request', async () => {
    const response = await post();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      profileId: 'profile-internal',
      username: 'example_profile',
      status: 'syncing',
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(m.gatewayFactory).toHaveBeenCalledWith({ timeout: 60 });
    expect(m.start).toHaveBeenCalledOnce();
    expect(m.start).toHaveBeenCalledWith('apify/instagram-profile-scraper', {
      usernames: ['example_profile'],
    });
    expect(m.runCreate).toHaveBeenCalledWith({
      data: {
        actor: 'apify/instagram-profile-scraper',
        trigger: 'initial',
        status: 'running',
        userId: null,
      },
    });
    expect(m.runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'succeeded' }) }),
    );
    const creation = m.upsert.mock.calls[0]![0].create;
    expect(creation.instagramId).toBe(profileFixture.id);
    expect(creation).not.toHaveProperty('ownerUserId');
    expect(creation).not.toHaveProperty('followers');
    expect(creation.isVerified).toBeNull();
    expect(m.jobUpsert.mock.calls[0]![0].create.payload).toEqual({
      providerSteps: { profile: ['verified-run'] },
      providerAttempts: { 'verified-run': 1 },
    });
    expect(m.jobUpsert.mock.calls[0]![0].create).not.toHaveProperty('userId', 'hustleq-main');
  });
  it('returns ready for a profile synced within 24h and does not queue another job', async () => {
    Object.assign(profile, { syncStatus: 'ready', lastSyncedAt: new Date() });
    m.find.mockResolvedValue(profile);
    expect((await post()).json()).toMatchObject({ status: 'ready' });
    expect(m.jobUpsert).not.toHaveBeenCalled();
  });
  it('returns the same profile and preserves the current job on a repeated invite', async () => {
    expect((await post()).statusCode).toBe(201);
    Object.assign(profile, {
      reservedForInviteId: 'external-invite',
      reservedUntil: new Date(Date.now() + 172800000),
    });
    m.find.mockResolvedValue(profile);
    m.jobFind.mockResolvedValue({ id: 'sync-job', status: 'PENDING' });
    expect((await post()).json()).toMatchObject({ profileId: 'profile-internal' });
    expect(m.jobUpsert).toHaveBeenCalledOnce();
    // A reserva/fila sao idempotentes; cada novo POST pode realizar outro lookup.
    expect(m.start).toHaveBeenCalledTimes(2);
  });
  it('rejects an owned profile and never transfers ownership', async () => {
    Object.assign(profile, { ownerUserId: 'owner' });
    m.find.mockResolvedValue(profile);
    const response = await post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PROFILE_ALREADY_OWNED');
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it('rejects another active invite reservation', async () => {
    Object.assign(profile, {
      reservedForInviteId: 'other-invite',
      reservedUntil: new Date(Date.now() + 172800000),
    });
    m.find.mockResolvedValue(profile);
    const response = await post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PROFILE_RESERVED');
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it.each([
    [{ items: [], total: 0 }, 'PROFILE_NOT_FOUND'],
    [{ items: [{ private: true }], total: 1 }, 'PROFILE_PRIVATE'],
  ])(
    'handles unavailable/private profiles without creating a reservation',
    async (dataset, code) => {
      m.items.mockResolvedValue(dataset);
      const response = await post();
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(code);
      expect(m.transaction).not.toHaveBeenCalled();
    },
  );
  it('does not reserve a different username returned by the provider', async () => {
    m.items.mockResolvedValue({ items: [{ ...profileFixture, username: 'different' }], total: 1 });
    const response = await post();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it('reports a refused execution with its message instead of returning an empty success', async () => {
    m.items.mockResolvedValue({
      items: [{ recordType: 'notice', message: 'Free tier: please wait 29 more minutes' }],
      total: 1,
    });
    const response = await post();
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('29'),
    });
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it('reports an uncertain start as provider unavailable without reserving', async () => {
    m.start.mockRejectedValue(new Error('connection closed'));
    const response = await post();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.start).toHaveBeenCalledOnce();
  });
  it('does not persist a reservation if the invitation expires while awaiting the lookup', async () => {
    const input = body();
    m.clock.mockResolvedValue([{ now: new Date(Date.parse(input.reservedUntil) + 1) }]);
    const response = await post(input);
    expect(response.statusCode).toBe(400);
    expect(m.start).toHaveBeenCalledOnce();
    expect(m.upsert).not.toHaveBeenCalled();
  });
  it('does not return 201 if persisting the queue fails', async () => {
    m.jobUpsert.mockRejectedValue(new Error('private SQL error'));
    const response = await post();
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('private SQL');
  });
  it('rejects an already-expired invite before spending provider credits', async () => {
    const response = await post({ ...body(), reservedUntil: '2000-01-01T00:00:00Z' });
    expect(response.statusCode).toBe(400);
    expect(m.runCreate).not.toHaveBeenCalled();
    expect(m.gatewayFactory).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ...body(), username: '' },
    { ...body(), username: '@@example' },
    { ...body(), inviteId: '' },
    { ...body(), inviteId: ' padded ' },
    { ...body(), reservedUntil: '2026-11-25' },
    { ...body(), reservedUntil: 'invalid' },
    { ...body(), reservedUntil: '2026-11-25T12:00:00' },
    { ...body(), reservedUntil: null },
    { ...body(), ownerUserId: 'attacker' },
    { ...body(), instagramId: 'invented' },
  ])('rejects invalid or extra fields before consulting the provider: %j', async (input) => {
    const response = await post(input);
    expect(response.statusCode).toBe(400);
    expect(m.start).not.toHaveBeenCalled();
    expect(m.runCreate).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    authHeaders({ sub: 'owner' }),
    authHeaders({ sub: 'hustleq-main' }),
    authHeaders({ sub: 'other-service', scope: 'service' }),
  ])('requires the exact service identity before any lookup', async (headers) => {
    const response = await app.inject({
      method: 'POST',
      url: path,
      ...(headers ? { headers } : {}),
      payload: body(),
    });
    expect(response.statusCode).toBe(headers ? 403 : 401);
    expect(m.runCreate).not.toHaveBeenCalled();
  });
  it('publishes the body and response contracts in Swagger', async () => {
    await app.ready();
    const spec = app.swagger() as {
      paths: Record<string, { post?: { responses?: unknown; security?: unknown } }>;
    };
    expect(spec.paths[path]?.post).toMatchObject({
      security: [{ bearerAuth: [] }],
      responses: {
        '201': expect.any(Object),
        '409': expect.any(Object),
        '503': expect.any(Object),
      },
    });
  });
});
