import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { authHeaders } from './helpers/auth.js';
const mock = vi.hoisted(() => ({
  transaction: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  apify: vi.fn(),
}));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({ $transaction: mock.transaction }),
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({ createApifyClient: mock.apify }));
import { buildApp } from '../src/app.js';
const path = '/api/v1/internal/instagram/profiles/profile-internal/monitoring';
const serviceHeaders = () => authHeaders({ sub: 'hustleq-main', scope: 'service' });
let app: ReturnType<typeof buildApp>;
let profile: Record<string, unknown>;
const tx = { instagramProfile: { findUnique: mock.find, update: mock.update } };
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  profile = {
    id: 'profile-internal',
    instagramId: '1234567890123456789',
    username: 'Example',
    ownerUserId: 'owner',
    name: '',
    url: null,
    bio: null,
    profilePhoto: null,
    category: null,
    isVerified: null,
    monitoringUntil: null,
    syncStatus: 'ready',
    lastSyncedAt: new Date('2026-11-21T11:00:00Z'),
    reservedForInviteId: 'invite',
    reservedUntil: new Date('2026-12-01T00:00:00Z'),
  };
  mock.transaction.mockImplementation((work: (value: typeof tx) => Promise<unknown>) => work(tx));
  mock.find.mockImplementation(async () => ({ id: profile.id, ownerUserId: profile.ownerUserId }));
  mock.update.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    Object.assign(profile, args.data);
    return { ...profile };
  });
});
afterEach(async () => {
  await app.close();
});
const patch = (payload: unknown = { monitoringUntil: '2026-12-21T00:00:00Z' }) =>
  app.inject({ method: 'PATCH', url: path, headers: serviceHeaders(), payload: payload as object });
const conflict = () =>
  new Prisma.PrismaClientKnownRequestError('conflict', {
    code: 'P2034',
    clientVersion: 'test',
  });

describe('MVP monitoring endpoint 11', () => {
  it('sets the date, returns a normalized profile and preserves owner and reservation', async () => {
    const result = await patch();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      id: 'profile-internal',
      instagramId: '1234567890123456789',
      username: 'example',
      name: null,
      url: null,
      bio: null,
      profilePhoto: null,
      category: null,
      isVerified: null,
      syncStatus: 'ready',
      lastSyncedAt: '2026-11-21T11:00:00.000Z',
      monitoringUntil: '2026-12-21T00:00:00.000Z',
    });
    expect(mock.update.mock.calls[0]![0].data).toEqual({
      monitoringUntil: new Date('2026-12-21T00:00:00Z'),
    });
    expect(profile).toMatchObject({ ownerUserId: 'owner', reservedForInviteId: 'invite' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(mock.apify).not.toHaveBeenCalled();
    expect(mock.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });
  it('accepts null to resume subsequent daily collections without collecting immediately', async () => {
    profile.monitoringUntil = new Date('2020-01-01T00:00:00Z');
    expect((await patch({ monitoringUntil: null })).json().monitoringUntil).toBeNull();
    expect(profile.monitoringUntil).toBeNull();
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('accepts past dates for immediate exclusion from the next daily selection', async () => {
    expect((await patch({ monitoringUntil: '2020-01-01T00:00:00Z' })).statusCode).toBe(200);
  });
  it('converts an explicit offset to UTC without adding thirty days', async () => {
    expect(
      (await patch({ monitoringUntil: '2026-12-20T19:00:00-05:00' })).json().monitoringUntil,
    ).toBe('2026-12-21T00:00:00.000Z');
  });
  it('is idempotent for the same date and handles unknown last sync', async () => {
    profile.lastSyncedAt = null;
    const first = await patch();
    expect(first.json().lastSyncedAt).toBeNull();
    expect((await patch()).json()).toEqual(first.json());
  });
  it('does not require an owner for this trusted internal operation', async () => {
    profile.ownerUserId = null;
    expect((await patch()).statusCode).toBe(200);
    expect(profile.ownerUserId).toBeNull();
  });
  it('returns PROFILE_NOT_FOUND without writing when the internal id is unknown', async () => {
    mock.find.mockResolvedValue(null);
    const result = await patch();
    expect(result.statusCode).toBe(404);
    expect(result.json().error.code).toBe('PROFILE_NOT_FOUND');
    expect(mock.update).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { monitoringUntil: undefined },
    { monitoringUntil: '' },
    { monitoringUntil: '2026-12-21' },
    { monitoringUntil: '2026-02-30T00:00:00Z' },
    { monitoringUntil: '2026-12-21T00:00:00' },
    { monitoringUntil: true },
    { monitoringUntil: 1797800000 },
    { monitoringUntil: [] },
    { monitoringUntil: null, ownerUserId: 'attacker' },
    { monitoringUntil: null, syncStatus: 'ready' },
    { monitoringUntil: null, reservedUntil: null },
  ])('rejects invalid or extra body fields before DB access: %j', async (payload) => {
    const result = await patch(payload);
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('INVALID_REQUEST');
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('requires a body', async () => {
    const result = await app.inject({ method: 'PATCH', url: path, headers: serviceHeaders() });
    expect(result.statusCode).toBe(400);
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('rejects ordinary user JWTs before DB access', async () => {
    const result = await app.inject({
      method: 'PATCH',
      url: path,
      headers: authHeaders({ sub: 'owner' }),
      payload: { monitoringUntil: null },
    });
    expect(result.statusCode).toBe(403);
    expect(result.json().error.code).toBe('FORBIDDEN');
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('rejects absent authentication before DB access', async () => {
    const result = await app.inject({
      method: 'PATCH',
      url: path,
      payload: { monitoringUntil: null },
    });
    expect(result.statusCode).toBe(401);
    expect(result.json().error.code).toBe('UNAUTHENTICATED');
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('sanitizes storage errors and never calls Apify as fallback', async () => {
    mock.update.mockRejectedValue(new Error('secret database details'));
    const result = await patch();
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe('INTERNAL_ERROR');
    expect(result.body).not.toContain('secret');
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('retries transaction conflicts, rechecking whether the profile still exists', async () => {
    mock.transaction.mockRejectedValueOnce(conflict());
    expect((await patch()).statusCode).toBe(200);
    expect(mock.transaction).toHaveBeenCalledTimes(2);
    expect(mock.update).toHaveBeenCalledTimes(1);
  });
  it('stops after three transaction conflicts', async () => {
    mock.transaction.mockRejectedValue(conflict());
    expect((await patch()).statusCode).toBe(500);
    expect(mock.transaction).toHaveBeenCalledTimes(3);
    expect(mock.update).not.toHaveBeenCalled();
  });
  it('documents the service-only route and nullable date in Swagger', async () => {
    await app.ready();
    const spec = app.swagger() as {
      paths: Record<string, { patch?: { security?: unknown; responses?: unknown } }>;
    };
    expect(
      spec.paths['/api/v1/internal/instagram/profiles/{profileId}/monitoring']?.patch,
    ).toMatchObject({
      security: [{ bearerAuth: [] }],
      responses: { '200': expect.any(Object), '404': expect.any(Object) },
    });
  });
});
