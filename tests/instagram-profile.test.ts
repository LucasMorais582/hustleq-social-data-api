vi.mock('../src/modules/instagram/profile/instagram.profile.repository.js', () => ({
  saveProfileCollection: vi.fn().mockResolvedValue({ instagramProfileId: 'internal' }),
}));
import { authHeaders } from './helpers/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
const { call, listItems } = vi.hoisted(() => ({ call: vi.fn(), listItems: vi.fn() }));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({
  createApifyClient: () => ({ actor: () => ({ call }), dataset: () => ({ listItems }) }),
}));
import { buildApp } from '../src/app.js';

describe('POST /api/v1/instagram/profile/search', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it.each([
    { items: [], code: 'PROFILE_NOT_FOUND' },
    { items: [{ error: 'not_found' }], code: 'PROFILE_NOT_FOUND' },
    { items: [{ private: true }], code: 'PROFILE_PRIVATE' },
    { items: [{ error: 'private_profile' }], code: 'PROFILE_PRIVATE' },
  ])('returns 404 with $code', async ({ items, code }) => {
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    listItems.mockResolvedValue({ items });
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      headers: authHeaders(),
      url: '/api/v1/instagram/profile/search',
      payload: { username: 'example' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code });
  });

  it('does not classify provider failures as missing profiles', async () => {
    call.mockRejectedValue(new Error('Provider unavailable'));
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      headers: authHeaders(),
      url: '/api/v1/instagram/profile/search',
      payload: { username: 'example' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('keeps the public profile response', async () => {
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    listItems.mockResolvedValue({
      items: [
        {
          id: '1',
          username: 'example',
          fullName: 'Example',
          biography: '',
          followersCount: 5,
          followsCount: 3,
          postsCount: 0,
          profilePicUrlHD: 'https://example.com/pic.jpg',
          private: false,
          latestPosts: [],
        },
      ],
    });
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      headers: authHeaders(),
      url: '/api/v1/instagram/profile/search',
      payload: { username: 'example' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().response.profile.username).toBe('example');
  });
  it('reports malformed provider responses as unavailable instead of not found', async () => {
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    listItems.mockResolvedValue({ items: [{ id: 'incomplete' }] });
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      headers: authHeaders(),
      url: '/api/v1/instagram/profile/search',
      payload: { username: 'example' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('PROVIDER_UNAVAILABLE');
  });
});
