import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { authHeaders } from './helpers/auth.js';
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  raw: vi.fn(),
  end: vi.fn(),
  jobs: vi.fn(),
  costs: vi.fn(),
  apify: vi.fn(),
}));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({ $transaction: m.transaction }),
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({ createApifyClient: m.apify }));
import { buildApp } from '../src/app.js';
const path = '/api/v1/internal/instagram/profiles/internal-profile/owner';
const service = () => authHeaders({ sub: 'hustleq-main', scope: 'service' });
const now = new Date('2026-11-25T12:00:00Z');
let profile: { id: string; ownerUserId: string | null } | null;
let app: ReturnType<typeof buildApp>;
const tx = {
  instagramProfile: { findUnique: m.find, update: m.update },
  providerRun: { updateMany: m.costs },
  instagramCompetitor: { updateMany: m.end },
  instagramSyncJob: { updateMany: m.jobs },
  $queryRaw: m.raw,
};
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  profile = { id: 'internal-profile', ownerUserId: 'owner-A' };
  m.transaction.mockImplementation((work: (db: typeof tx) => unknown) => work(tx));
  m.find.mockImplementation(async () => (profile ? { ...profile, monitoredBy: [] } : null));
  m.update.mockImplementation(async ({ data }) => {
    Object.assign(profile!, data);
    return profile;
  });
  m.raw.mockImplementation(async (query: TemplateStringsArray) =>
    query.join('').includes('clock_timestamp') ? [{ now }] : [],
  );
});
afterEach(async () => {
  await app.close();
});
const remove = (userId = 'owner-A') =>
  app.inject({ method: 'DELETE', url: `${path}?userId=${userId}`, headers: service() });
describe('DELETE internal profile owner', () => {
  it('removes and repeats idempotently without cancelling work from a new ownerless invitation', async () => {
    expect((await remove()).statusCode).toBe(204);
    expect(profile!.ownerUserId).toBeNull();
    expect((await remove()).statusCode).toBe(204);
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(m.end).toHaveBeenCalledWith({
      where: { instagramProfileId: 'internal-profile', endedAt: null },
      data: { endedAt: now },
    });
    expect(m.apify).not.toHaveBeenCalled();
  });
  it('rejects mismatch atomically, before changing profile, relations, jobs or costs', async () => {
    const result = await remove('wrong');
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe('OWNER_MISMATCH');
    expect(profile!.ownerUserId).toBe('owner-A');
    for (const method of [m.update, m.end, m.jobs, m.costs, m.raw])
      expect(method).not.toHaveBeenCalled();
  });
  it('rejects the stale old user after a new owner has been assigned', async () => {
    await remove();
    const assigned = await app.inject({
      method: 'POST',
      url: path,
      headers: service(),
      payload: { userId: 'owner-B' },
    });
    expect(assigned.statusCode).toBe(200);
    expect((await remove()).statusCode).toBe(409);
    expect(profile!.ownerUserId).toBe('owner-B');
  });
  it('revokes read access from the former owner', async () => {
    await remove();
    const result = await app.inject({
      url: '/api/v1/instagram/profiles/internal-profile',
      headers: authHeaders({ sub: 'owner-A' }),
    });
    expect(result.statusCode).toBe(403);
    expect(result.json().error.code).toBe('FORBIDDEN');
  });
  it('returns 404 when the profile is absent', async () => {
    profile = null;
    const result = await remove();
    expect(result.statusCode).toBe(404);
    expect(result.json().error.code).toBe('PROFILE_NOT_FOUND');
    expect(m.update).not.toHaveBeenCalled();
  });
  it.each(['', '?userId=', '?userId=%20', '?userId=a&userId=b', '?userId=a&extra=b'])(
    'rejects invalid query %s before a transaction',
    async (query) => {
      expect(
        (await app.inject({ method: 'DELETE', url: path + query, headers: service() })).statusCode,
      ).toBe(400);
      expect(m.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([{}, { userId: 'owner-A' }])('rejects a body %j', async (payload) => {
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: path + '?userId=owner-A',
          headers: service(),
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it('requires a service token', async () => {
    const missing = await app.inject({ method: 'DELETE', url: path + '?userId=owner-A' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('UNAUTHENTICATED');
    const user = await app.inject({
      method: 'DELETE',
      url: path + '?userId=owner-A',
      headers: authHeaders({ sub: 'owner-A' }),
    });
    expect(user.statusCode).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it('rechecks the owner after a serialization conflict', async () => {
    m.transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    expect((await remove()).statusCode).toBe(204);
    expect(m.transaction).toHaveBeenCalledTimes(2);
  });
  it('does not leak database details on failure', async () => {
    m.end.mockRejectedValue(new Error('private connection string'));
    const result = await remove();
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('private connection');
  });
  it('documents service auth, query, 204 and mismatch response in Swagger', async () => {
    await app.ready();
    const route =
      app.swagger().paths?.['/api/v1/internal/instagram/profiles/{profileId}/owner']?.delete;
    expect(route?.responses?.['204']).toBeDefined();
    expect(route?.responses?.['409']).toBeDefined();
    expect(route?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'userId', in: 'query', required: true }),
      ]),
    );
  });
});
