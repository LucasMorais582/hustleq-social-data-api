import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { transaction, fetchProfile, saveProfile } = vi.hoisted(() => ({
  transaction: vi.fn(),
  fetchProfile: vi.fn(),
  saveProfile: vi.fn(),
}));
vi.mock('../src/modules/instagram/competitors/instagram.competitors.repository.js', () => ({
  withCompetitorTransaction: transaction,
}));
vi.mock('../src/provider/apify/apify.provider.js', () => ({ fetchInstagramProfile: fetchProfile }));
vi.mock('../src/modules/instagram/profile/instagram.profile.repository.js', () => ({
  saveProfileCollection: saveProfile,
}));
import { buildApp } from '../src/app.js';
import { authHeaders } from './helpers/auth.js';
import { createCompetitorConfirmation } from '../src/modules/instagram/competitors/instagram.competitors.confirmation.js';
import type { CompetitorStore } from '../src/modules/instagram/competitors/instagram.competitors.repository.js';
import { ProviderError } from '../src/errors/provider.error.js';

const path = '/api/v1/instagram/profiles/source/competitors';
const identity = {
  instagramId: 'external',
  username: 'other',
  name: 'Other',
  bio: 'Bio',
  profilePhoto: 'https://example.com/photo.jpg',
  url: null,
  category: null,
  isVerified: false,
};
let app: ReturnType<typeof buildApp>;
let store: {
  [
    K in
      | 'profileExists'
      | 'profileInstagramId'
      | 'saveIdentity'
      | 'activeExists'
      | 'countActive'
      | 'create'
      | 'list'
      | 'find'
  ]: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  store = {
    profileExists: vi.fn().mockResolvedValue(true),
    profileInstagramId: vi.fn().mockResolvedValue('source-external'),
    saveIdentity: vi.fn().mockResolvedValue('destination'),
    activeExists: vi.fn().mockResolvedValue(false),
    countActive: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ id: 'relation', endedAt: null }),
    list: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue(null),
  };
  transaction.mockImplementation((work: (store: CompetitorStore) => Promise<unknown>) =>
    work(store as unknown as CompetitorStore),
  );
  fetchProfile.mockResolvedValue({
    id: 'external',
    username: 'other',
    fullName: 'Other',
    biography: 'Bio',
    profilePicUrlHD: identity.profilePhoto,
    verified: false,
    latestPosts: [],
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await app.close();
});
const preview = () =>
  app.inject({
    method: 'POST',
    url: `${path}/search`,
    headers: authHeaders(),
    payload: { username: '@other' },
  });
const confirm = (confirmationToken: string, confirmed: boolean = true) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: authHeaders(),
    payload: { confirmed, confirmationToken },
  });

describe('competitor preview and explicit confirmation', () => {
  it('previews without saving, then confirms without a second paid lookup', async () => {
    const first = await preview();
    expect(first.statusCode).toBe(200);
    expect(first.json().response.profile).toEqual(identity);
    expect(fetchProfile).toHaveBeenCalledWith('other');
    expect(store.saveIdentity).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(saveProfile).not.toHaveBeenCalled();
    const second = await confirm(first.json().response.confirmationToken);
    expect(second.statusCode).toBe(201);
    expect(store.saveIdentity).toHaveBeenCalledWith(identity);
    expect(store.create).toHaveBeenCalledWith('source', 'destination');
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });
  it.each([false, undefined])('does not accept confirmed=%s', async (confirmed) => {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: authHeaders(),
      payload: { confirmed, confirmationToken: 'anything' },
    });
    expect(response.statusCode).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rejects tampered confirmation', async () => {
    const token = (await preview()).json().response.confirmationToken;
    const result = await confirm(`x${token}`);
    expect(result.statusCode).toBe(400);
    expect(result.json().code).toBe('COMPETITOR_CONFIRMATION_INVALID');
    expect(store.saveIdentity).not.toHaveBeenCalled();
  });
  it.each(['different-profile', 'different-subject'])('binds confirmation to %s', async (mode) => {
    const token = createCompetitorConfirmation(
      mode === 'different-profile' ? 'another' : 'source',
      mode === 'different-subject' ? 'another' : 'test-client',
      identity,
    ).confirmationToken;
    expect((await confirm(token)).statusCode).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('rejects expired confirmation', async () => {
    const token = createCompetitorConfirmation('source', 'test-client', identity).confirmationToken;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    expect((await confirm(token)).statusCode).toBe(400);
    vi.restoreAllMocks();
  });
  it('does not accept the preview token as Bearer authentication', async () => {
    const token = (await preview()).json().response.confirmationToken;
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });
  it.each([
    ['POST', '/search'],
    ['POST', ''],
    ['GET', ''],
    ['DELETE', '/relation'],
  ] as const)('authenticates %s %s', async (method, suffix) => {
    const response = await app.inject({ method, url: `${path}${suffix}` });
    expect(response.statusCode).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([null, { error: 'not_found' }, { private: true }])(
    'handles unavailable Instagram profile %j',
    async (item) => {
      fetchProfile.mockResolvedValue(item);
      const response = await preview();
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe(item?.private ? 'PROFILE_PRIVATE' : 'PROFILE_NOT_FOUND');
      expect(store.saveIdentity).not.toHaveBeenCalled();
    },
  );
  it('rejects self-reference on preview and confirmation', async () => {
    store.profileInstagramId.mockResolvedValue('external');
    expect((await preview()).json().code).toBe('COMPETITOR_SELF_REFERENCE');
    const token = createCompetitorConfirmation('source', 'test-client', identity).confirmationToken;
    expect((await confirm(token)).json().code).toBe('COMPETITOR_SELF_REFERENCE');
    expect(store.saveIdentity).not.toHaveBeenCalled();
  });
  it('requires a saved monitoring profile before spending on lookup', async () => {
    store.profileExists.mockResolvedValue(false);
    expect((await preview()).statusCode).toBe(404);
    expect(fetchProfile).not.toHaveBeenCalled();
  });
  it('propagates provider rate limits', async () => {
    fetchProfile.mockRejectedValue(new ProviderError(429, 'PROVIDER_RATE_LIMITED', 'Please wait'));
    const response = await preview();
    expect(response.statusCode).toBe(429);
    expect(response.json().message).toBe('Please wait');
  });
  it.each(['?limit=101', '?page=0', '?status=unknown'])(
    'rejects list parameters %s',
    async (query) => {
      expect(
        (await app.inject({ method: 'GET', url: path + query, headers: authHeaders() })).statusCode,
      ).toBe(400);
    },
  );
  it('lists and scopes removal to the monitoring profile', async () => {
    expect(
      (await app.inject({ method: 'GET', url: path, headers: authHeaders() })).statusCode,
    ).toBe(200);
    expect(store.list).toHaveBeenCalledWith('source', 'active', 0, 50);
    const response = await app.inject({
      method: 'DELETE',
      url: `${path}/foreign`,
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(store.find).toHaveBeenCalledWith('source', 'foreign');
  });
  it.each(['duplicate', 'limit'])('rechecks %s on confirmation after preview', async (mode) => {
    const token = (await preview()).json().response.confirmationToken;
    if (mode === 'duplicate') store.activeExists.mockResolvedValue(true);
    else store.countActive.mockResolvedValue(3);
    const response = await confirm(token);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe(
      mode === 'duplicate' ? 'COMPETITOR_ALREADY_ACTIVE' : 'COMPETITOR_LIMIT_REACHED',
    );
    expect(store.create).not.toHaveBeenCalled();
  });
  it('returns 503 and hides database details when confirmation fails', async () => {
    const token = (await preview()).json().response.confirmationToken;
    store.saveIdentity.mockRejectedValue(new Error('password-sensitive SQL details'));
    const response = await confirm(token);
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('PERSISTENCE_FAILED');
    expect(response.body).not.toContain('password-sensitive');
    expect(store.create).not.toHaveBeenCalled();
  });
  it.each(['', 'wrong/name', 'https://instagram.com/other'])(
    'rejects invalid username %s',
    async (username) => {
      const response = await app.inject({
        method: 'POST',
        url: path + '/search',
        headers: authHeaders(),
        payload: { username },
      });
      expect(response.statusCode).toBe(400);
      expect(fetchProfile).not.toHaveBeenCalled();
    },
  );
  it('does not allow client-supplied profile data on confirmation', async () => {
    const token = createCompetitorConfirmation('source', 'test-client', identity).confirmationToken;
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: authHeaders(),
      payload: { confirmed: true, confirmationToken: token, profile: { instagramId: 'forged' } },
    });
    expect(response.statusCode).toBe(400);
    expect(store.saveIdentity).not.toHaveBeenCalled();
  });
});
