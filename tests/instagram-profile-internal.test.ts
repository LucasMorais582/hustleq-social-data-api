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
const path = '/api/v1/internal/instagram/profiles/profile-internal';
const serviceHeaders = () => authHeaders({ sub: 'hustleq-main', scope: 'service' });
let app: ReturnType<typeof buildApp>;
let profile: {
  id: string;
  ownerUserId: string | null;
  reservedForInviteId: string | null;
  reservedUntil: Date | null;
} | null;
const tx = {
  instagramProfile: { findUnique: mock.find, update: mock.update },
  providerRun: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
};
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  profile = {
    id: 'profile-internal',
    ownerUserId: null,
    reservedForInviteId: 'invite',
    reservedUntil: new Date('2026-11-25T00:00:00Z'),
  };
  mock.transaction.mockImplementation((work: (store: typeof tx) => Promise<unknown>) => work(tx));
  mock.find.mockImplementation(async (args: { select: Record<string, unknown> }) => {
    if (!profile) return null;
    if (args.select.monitoredBy) return { ownerUserId: profile.ownerUserId, monitoredBy: [] };
    if (args.select.snapshots)
      return {
        id: profile.id,
        instagramId: 'external-id',
        username: 'example',
        name: null,
        bio: null,
        url: null,
        profilePhoto: null,
        category: null,
        isVerified: null,
        syncStatus: 'pending',
        lastSyncedAt: null,
        snapshots: [],
      };
    return { id: profile.id, ownerUserId: profile.ownerUserId };
  });
  mock.update.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    if (!profile) throw new Error('missing');
    if ('ownerUserId' in args.data) profile.ownerUserId = args.data.ownerUserId as string;
    profile.reservedForInviteId = null;
    profile.reservedUntil = null;
    return { id: profile.id };
  });
});
afterEach(async () => {
  await app.close();
});
const assign = (userId: unknown = 'hustleq-user') =>
  app.inject({
    method: 'POST',
    url: path + '/owner',
    headers: serviceHeaders(),
    payload: { userId },
  });
const clear = () =>
  app.inject({ method: 'DELETE', url: path + '/reservation', headers: serviceHeaders() });

describe('MVP internal profile owner and reservation endpoints 3 and 4', () => {
  it('assigns the supplied HustleQ user and clears the reservation atomically', async () => {
    const result = await assign();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ profileId: 'profile-internal', ownerUserId: 'hustleq-user' });
    expect(profile).toMatchObject({
      ownerUserId: 'hustleq-user',
      reservedForInviteId: null,
      reservedUntil: null,
    });
    expect(mock.update).toHaveBeenCalledWith({
      where: { id: 'profile-internal' },
      data: { ownerUserId: 'hustleq-user', reservedForInviteId: null, reservedUntil: null },
      select: { id: true },
    });
    expect(mock.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('allows retries for the same owner without creating a new profile', async () => {
    expect((await assign()).statusCode).toBe(200);
    expect((await assign()).json()).toEqual({
      profileId: 'profile-internal',
      ownerUserId: 'hustleq-user',
    });
  });
  it('does not transfer a profile already owned by someone else', async () => {
    profile!.ownerUserId = 'someone-else';
    const result = await assign();
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe('PROFILE_ALREADY_OWNED');
    expect(mock.update).not.toHaveBeenCalled();
    expect(profile!.reservedForInviteId).toBe('invite');
  });
  it('enables an ordinary user read only after the service assigns that user', async () => {
    const options = {
      url: '/api/v1/instagram/profiles/profile-internal',
      headers: authHeaders({ sub: 'hustleq-user' }),
    };
    expect((await app.inject(options)).statusCode).toBe(403);
    expect((await assign()).statusCode).toBe(200);
    expect((await app.inject(options)).statusCode).toBe(200);
  });
  it('releases only reservation fields and returns 204 with an empty body', async () => {
    profile!.ownerUserId = 'existing-owner';
    const result = await clear();
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe('');
    expect(result.headers['content-type']).toBeUndefined();
    expect(profile).toMatchObject({
      ownerUserId: 'existing-owner',
      reservedForInviteId: null,
      reservedUntil: null,
    });
    expect(mock.update).toHaveBeenCalledWith({
      where: { id: 'profile-internal' },
      data: { reservedForInviteId: null, reservedUntil: null },
      select: { id: true },
    });
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('allows repeated release of an already empty reservation', async () => {
    expect((await clear()).statusCode).toBe(204);
    expect((await clear()).statusCode).toBe(204);
  });
  it('accepts an empty object as a no-op instruction body for reservation release', async () => {
    const result = await app.inject({
      method: 'DELETE',
      url: path + '/reservation',
      headers: serviceHeaders(),
      payload: {},
    });
    expect(result.statusCode).toBe(204);
  });
  it.each(['owner', 'reservation'])(
    'returns 404 for a missing profile on %s',
    async (operation) => {
      profile = null;
      const result = await (operation === 'owner' ? assign() : clear());
      expect(result.statusCode).toBe(404);
      expect(result.json().error.code).toBe('PROFILE_NOT_FOUND');
      expect(mock.update).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, '', ' ', ' padded ', 123, null, false, 'x'.repeat(201)])(
    'rejects invalid userId %j',
    async (userId) => {
      const result = await app.inject({
        method: 'POST',
        url: path + '/owner',
        headers: serviceHeaders(),
        payload: userId === undefined ? {} : { userId },
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('INVALID_REQUEST');
      expect(mock.transaction).not.toHaveBeenCalled();
    },
  );
  it('attributes only unattributed initial runs when assigning the owner, including repeated acceptance', async () => {
    expect((await assign()).statusCode).toBe(200);
    expect((await assign()).statusCode).toBe(200);
    expect(tx.providerRun.updateMany).toHaveBeenCalledWith({
      where: { instagramProfileId: 'profile-internal', trigger: 'initial', userId: null },
      data: { userId: 'hustleq-user' },
    });
  });
  it('keeps alphanumeric user IDs as strings', async () => {
    expect((await assign('90071992547409931234-A')).json().ownerUserId).toBe(
      '90071992547409931234-A',
    );
  });
  it('does not accept additional assignment fields', async () => {
    const result = await app.inject({
      method: 'POST',
      url: path + '/owner',
      headers: serviceHeaders(),
      payload: { userId: 'user', instagramId: 'forged' },
    });
    expect(result.statusCode).toBe(400);
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('does not accept instructions to change owner in reservation release', async () => {
    const result = await app.inject({
      method: 'DELETE',
      url: path + '/reservation',
      headers: serviceHeaders(),
      payload: { ownerUserId: null },
    });
    expect(result.statusCode).toBe(400);
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it.each([
    ['POST', '/owner'],
    ['DELETE', '/reservation'],
  ] as const)('requires authentication on %s %s', async (method, suffix) => {
    const result = await app.inject({ method, url: path + suffix });
    expect(result.statusCode).toBe(401);
    expect(result.json().error.code).toBe('UNAUTHENTICATED');
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { sub: 'hustleq-main' },
    { scope: 'service' },
    { sub: 'hustleq-main', scope: 'OWNER' },
  ])('rejects non-service token %j before a write', async (claims) => {
    for (const [method, suffix] of [
      ['POST', '/owner'],
      ['DELETE', '/reservation'],
    ] as const) {
      const result = await app.inject({
        method,
        url: path + suffix,
        headers: authHeaders(claims),
        ...(method === 'POST' ? { payload: { userId: 'user' } } : {}),
      });
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('FORBIDDEN');
    }
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('rejects expired service tokens before any operation', async () => {
    const result = await app.inject({
      method: 'POST',
      url: path + '/owner',
      headers: authHeaders({
        sub: 'hustleq-main',
        scope: 'service',
        exp: Math.floor(Date.now() / 1000) - 1,
      }),
      payload: { userId: 'user' },
    });
    expect(result.statusCode).toBe(401);
    expect(mock.transaction).not.toHaveBeenCalled();
  });
  it('retries serialization conflicts and rechecks ownership before writing again', async () => {
    let attempt = 0;
    mock.transaction.mockImplementation(async (work: (store: typeof tx) => Promise<unknown>) => {
      if (++attempt === 1) {
        // Outro escritor vence enquanto a primeira tentativa desta chamada e revertida.
        profile!.ownerUserId = 'concurrent-owner';
        throw new Prisma.PrismaClientKnownRequestError('conflict', {
          code: 'P2034',
          clientVersion: '6',
        });
      }
      return work(tx);
    });
    const result = await assign();
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe('PROFILE_ALREADY_OWNED');
    expect(profile!.ownerUserId).toBe('concurrent-owner');
    expect(mock.update).not.toHaveBeenCalled();
  });
  it('retries a serialization conflict raised by the update itself', async () => {
    mock.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6' }),
    );
    const result = await assign();
    expect(result.statusCode).toBe(200);
    expect(mock.transaction).toHaveBeenCalledTimes(2);
    expect(mock.find).toHaveBeenCalledTimes(2);
    expect(profile!.ownerUserId).toBe('hustleq-user');
  });
  it('stops after three serialization conflicts', async () => {
    mock.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6' }),
    );
    const result = await assign();
    expect(result.statusCode).toBe(500);
    expect(result.json().error.code).toBe('INTERNAL_ERROR');
    expect(mock.transaction).toHaveBeenCalledTimes(3);
  });
  it.each(['owner', 'reservation'])(
    'does not report success after a database failure on %s',
    async (operation) => {
      mock.update.mockRejectedValue(new Error('sensitive SQL credentials'));
      const result = await (operation === 'owner' ? assign() : clear());
      expect(result.statusCode).toBe(500);
      expect(result.json().error.code).toBe('INTERNAL_ERROR');
      expect(result.body).not.toContain('sensitive');
      expect(mock.transaction).toHaveBeenCalledTimes(1);
    },
  );
  it('documents both internal operations and their response status', async () => {
    await app.ready();
    const paths = app.swagger().paths;
    expect(
      paths?.['/api/v1/internal/instagram/profiles/{profileId}/owner']?.post?.responses?.['200'],
    ).toBeDefined();
    expect(
      paths?.['/api/v1/internal/instagram/profiles/{profileId}/reservation']?.delete?.responses?.[
        '204'
      ],
    ).toBeDefined();
  });
});
