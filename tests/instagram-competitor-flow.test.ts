import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { transaction, lookup, fetchProfile } = vi.hoisted(() => ({
  transaction: vi.fn(),
  lookup: vi.fn(),
  fetchProfile: vi.fn(),
}));
vi.mock('../src/modules/instagram/competitors/instagram.competitors.repository.js', () => ({
  withCompetitorTransaction: transaction,
}));
vi.mock('../src/modules/instagram/profile/instagram.profile.lookup.service.js', () => ({
  lookupTrackedInstagramProfile: lookup,
}));
vi.mock('../src/provider/apify/apify.provider.js', () => ({ fetchInstagramProfile: fetchProfile }));
import { buildApp } from '../src/app.js';
import { authHeaders } from './helpers/auth.js';
import type { CompetitorStore } from '../src/modules/instagram/competitors/instagram.competitors.repository.js';
import { ApiError } from '../src/errors/api.error.js';
import { ProfileLookupError } from '../src/modules/instagram/profile/instagram.profile.errors.js';
import { ProviderError } from '../src/errors/provider.error.js';
import { ProviderStartUncertain } from '../src/provider/apify/apify.tracked-run.js';

const path = '/api/v1/instagram/profiles/source/competitors';
const profile = {
  id: 'external',
  username: 'other',
  fullName: 'Other',
  biography: 'Bio',
  profilePicUrlHD: 'https://example.com/photo.jpg',
  verified: false,
  latestPosts: [],
};
const identity = {
  instagramId: 'external',
  username: 'other',
  name: 'Other',
  bio: 'Bio',
  profilePhoto: profile.profilePicUrlHD,
  url: null,
  category: null,
  isVerified: false,
};
function makeStore() {
  return {
    requireOwner: vi.fn().mockResolvedValue(undefined),
    scheduleInitial: vi.fn().mockResolvedValue(undefined),
    profileExists: vi.fn().mockResolvedValue(true),
    profileInstagramId: vi.fn().mockResolvedValue('source-external'),
    saveIdentity: vi.fn().mockResolvedValue('destination'),
    activeExists: vi.fn().mockResolvedValue(false),
    countActive: vi.fn().mockResolvedValue(0),
    create: vi
      .fn()
      .mockResolvedValue({ id: 'relation', competitorProfileId: 'destination', endedAt: null }),
    list: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue({ id: 'relation', endedAt: null }),
    end: vi.fn().mockResolvedValue({ id: 'relation', endedAt: new Date() }),
  };
}
let app: ReturnType<typeof buildApp>;
let store: ReturnType<typeof makeStore>;
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  store = makeStore();
  transaction.mockImplementation((work: (store: CompetitorStore) => Promise<unknown>) =>
    work(store),
  );
  lookup.mockResolvedValue({ profile, providerRunId: 'verified-run' });
  fetchProfile.mockResolvedValue(profile);
});
afterEach(async () => {
  await app.close();
});
const add = (payload: unknown = { username: '@OTHER' }) =>
  app.inject({ method: 'POST', url: path, headers: authHeaders(), payload: payload as object });

describe('MVP watched accounts endpoints 13–15', () => {
  it('accepts username and atomically requests Initial Sync with the verified lookup', async () => {
    const response = await add();
    expect(response.statusCode).toBe(201);
    expect(response.json().response).toMatchObject({
      id: 'relation',
      competitorProfileId: 'destination',
    });
    expect(lookup).toHaveBeenCalledWith('other', { trigger: 'initial', userId: 'test-client' });
    expect(store.saveIdentity).toHaveBeenCalledWith(identity);
    expect(store.create).toHaveBeenCalledWith('source', 'destination');
    expect(store.scheduleInitial).toHaveBeenCalledWith(
      'destination',
      'verified-run',
      'test-client',
    );
    expect(store.requireOwner).toHaveBeenCalledTimes(2);
  });
  it.each([
    { confirmed: true, confirmationToken: 'old' },
    { username: 'other', profile: { instagramId: 'forged' } },
    {},
    { username: '' },
    { username: 'wrong/name' },
  ])('rejects invalid/old body %j', async (payload) => {
    expect((await add(payload)).statusCode).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each([
    ['POST', ''],
    ['GET', ''],
    ['DELETE', '/relation'],
    ['POST', '/search'],
  ] as const)('authenticates %s %s', async (method, suffix) => {
    expect((await app.inject({ method, url: path + suffix })).statusCode).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    ['POST', ''],
    ['GET', ''],
    ['DELETE', '/relation'],
    ['POST', '/search'],
  ] as const)('restricts %s %s to the source owner', async (method, suffix) => {
    store.requireOwner.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Sem acesso'));
    const response = await app.inject({
      method,
      url: path + suffix,
      headers: authHeaders(),
      ...(method === 'POST' ? { payload: { username: 'other' } } : {}),
    });
    expect(response.statusCode).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchProfile).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
    expect(store.end).not.toHaveBeenCalled();
  });
  it('rejects service tokens', async () => {
    expect(
      (
        await app.inject({
          url: path,
          headers: authHeaders({ sub: 'hustleq-main', scope: 'service' }),
        })
      ).statusCode,
    ).toBe(403);
  });
  it('rejects a missing source before a paid lookup', async () => {
    store.requireOwner.mockRejectedValue(new ApiError(404, 'PROFILE_NOT_FOUND', 'Não encontrado'));
    expect((await add()).statusCode).toBe(404);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rechecks ownership after the external lookup', async () => {
    store.requireOwner
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Sem acesso'));
    expect((await add()).statusCode).toBe(403);
    expect(store.saveIdentity).not.toHaveBeenCalled();
  });
  it('rejects self-reference by immutable Instagram identity', async () => {
    store.profileInstagramId.mockResolvedValue('external');
    expect((await add()).json().error.code).toBe('INVALID_REQUEST');
    expect(store.saveIdentity).not.toHaveBeenCalled();
  });
  it('rejects duplicate active relations', async () => {
    store.activeExists.mockResolvedValue(true);
    const response = await add();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('COMPETITOR_ALREADY_REGISTERED');
    expect(store.scheduleInitial).not.toHaveBeenCalled();
  });
  it('rejects the active cap before spending on lookup', async () => {
    store.countActive.mockResolvedValue(3);
    expect((await add()).json().error.code).toBe('COMPETITOR_LIMIT_REACHED');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rechecks the cap after lookup when another request took the last slot', async () => {
    store.countActive.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    expect((await add()).statusCode).toBe(409);
    expect(store.create).not.toHaveBeenCalled();
  });
  it('allows the third relation and re-adding an ended relation', async () => {
    store.countActive.mockResolvedValue(2);
    expect((await add()).statusCode).toBe(201);
    expect(store.end).not.toHaveBeenCalled();
  });
  it.each([
    new ProviderError(429, 'PROVIDER_RATE_LIMITED', 'Please wait'),
    new ProviderError(503, 'PROVIDER_INVALID_RESPONSE', 'Invalid data'),
  ])('propagates provider errors', async (error) => {
    lookup.mockRejectedValue(error);
    const response = await add();
    expect(response.statusCode).toBe(error.statusCode);
    expect(response.json().error.message).toBe(error.message);
    expect(store.create).not.toHaveBeenCalled();
  });
  it('does not turn uncertain starts into empty success', async () => {
    lookup.mockRejectedValue(new ProviderStartUncertain());
    expect((await add()).statusCode).toBe(503);
    expect(store.create).not.toHaveBeenCalled();
  });
  it.each(['PROFILE_NOT_FOUND', 'PROFILE_PRIVATE'] as const)('preserves %s', async (code) => {
    lookup.mockRejectedValue(new ProfileLookupError(code));
    expect((await add()).statusCode).toBe(404);
    expect(store.create).not.toHaveBeenCalled();
  });
  it('hides database details if queueing fails', async () => {
    store.scheduleInitial.mockRejectedValue(new Error('sensitive SQL'));
    const response = await add();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('sensitive');
  });
  it('preserves the list envelope and pagination', async () => {
    const response = await app.inject({
      url: path + '?status=ended&page=2&limit=25',
      headers: authHeaders(),
    });
    expect(response.json()).toEqual({ response: { relations: [], page: 2, limit: 25 } });
    expect(store.list).toHaveBeenCalledWith('source', 'ended', 25, 25);
  });
  it.each(['?limit=101', '?page=0', '?status=unknown'])(
    'rejects list parameters %s',
    async (query) => {
      expect((await app.inject({ url: path + query, headers: authHeaders() })).statusCode).toBe(
        400,
      );
    },
  );
  it('returns empty 204 and removes by relation ID', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: path + '/relation',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(store.find).toHaveBeenCalledWith('source', 'relation');
    expect(store.end).toHaveBeenCalledTimes(1);
  });
  it('does not change endedAt on repeated deletion', async () => {
    store.find.mockResolvedValue({ id: 'relation', endedAt: new Date('2026-01-01') });
    expect(
      (await app.inject({ method: 'DELETE', url: path + '/relation', headers: authHeaders() }))
        .statusCode,
    ).toBe(204);
    expect(store.end).not.toHaveBeenCalled();
  });
  it('returns 404 for a relation outside the source profile', async () => {
    store.find.mockResolvedValue(null);
    const response = await app.inject({
      method: 'DELETE',
      url: path + '/foreign',
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('COMPETITOR_NOT_FOUND');
  });
  it('retains the deprecated preview without persisting identity', async () => {
    const response = await app.inject({
      method: 'POST',
      url: path + '/search',
      headers: authHeaders(),
      payload: { username: 'other' },
    });
    expect(response.statusCode).toBe(200);
    expect(store.saveIdentity).not.toHaveBeenCalled();
    expect(store.scheduleInitial).not.toHaveBeenCalled();
  });
});
