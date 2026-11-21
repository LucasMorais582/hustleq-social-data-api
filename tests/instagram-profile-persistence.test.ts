import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders } from './helpers/auth.js';
const { fetchInstagramProfile, saveProfileCollection } = vi.hoisted(() => ({
  fetchInstagramProfile: vi.fn(),
  saveProfileCollection: vi.fn(),
}));
vi.mock('../src/provider/apify/apify.provider.js', () => ({ fetchInstagramProfile }));
vi.mock('../src/modules/instagram/profile/instagram.profile.repository.js', () => ({
  saveProfileCollection,
}));
import { getInstagramProfile } from '../src/modules/instagram/profile/instagram.profile.service.js';
import { buildApp } from '../src/app.js';

function profile() {
  return {
    id: 'external-profile',
    username: 'example',
    fullName: null,
    biography: null,
    url: 'https://www.instagram.com/example/',
    profilePicUrlHD: null,
    businessCategoryName: null,
    verified: false,
    followersCount: null,
    followsCount: 2,
    postsCount: 1,
    latestPosts: [
      {
        id: 'post-1',
        ownerId: 'external-profile',
        type: 'Video',
        caption: null,
        url: 'https://www.instagram.com/p/example/',
        displayUrl: null,
        likesCount: null,
        commentsCount: 3,
        timestamp: '2026-11-17T12:00:00.000Z',
        videoPlayCount: 3000000000,
        hashtags: ['4', 'rj2026'],
        images: [],
      },
      {
        id: 'other-author-post',
        ownerId: 'another-author',
        type: 'Image',
        caption: '',
        likesCount: 2,
        commentsCount: 1,
        timestamp: null,
      },
    ],
  };
}

describe('profile/search persistence integration', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.resetAllMocks();
  });
  async function request() {
    app = buildApp();
    return app.inject({
      method: 'POST',
      url: '/api/v1/instagram/profile/search',
      headers: authHeaders(),
      payload: { username: 'example' },
    });
  }
  it('persists only posts matching the profile ownerId without changing external HTTP ids', async () => {
    fetchInstagramProfile.mockResolvedValue(profile());
    saveProfileCollection.mockResolvedValue({ instagramProfileId: 'internal-profile' });
    const response = await request();
    expect(response.statusCode).toBe(200);
    const input = saveProfileCollection.mock.calls[0]![0];
    expect(input.profile).toMatchObject({
      instagramId: 'external-profile',
      name: null,
      followers: null,
      isVerified: false,
    });
    expect(input.profile).not.toHaveProperty('ownerUserId');
    expect(input.posts).toHaveLength(1);
    expect(input.posts[0]).toMatchObject({
      instagramPostId: 'post-1',
      type: 'reel',
      hashtags: ['rj2026'],
      likesCount: null,
      viewsCount: null,
      ownerUsername: 'example',
    });
    expect(response.json().response.profile.id).toBe('external-profile');
    expect(response.json().response.posts).toHaveLength(2);
    expect(response.json().response.posts[0].likesCount).toBe(null);
  });
  it('normalizes hidden likes and profile identity with the photo fallback', async () => {
    const value = profile();
    fetchInstagramProfile.mockResolvedValue({
      ...value,
      username: '@EXAMPLE',
      fullName: ' ',
      profilePicUrl: 'https://example.com/fallback.jpg',
      latestPosts: [{ ...value.latestPosts[0], likesCount: -1 }],
    });
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().response.profile).toMatchObject({
      username: 'example',
      name: null,
      profilePicUrlHD: 'https://example.com/fallback.jpg',
    });
    expect(response.json().response.posts[0]).toMatchObject({
      likesCount: null,
      likesHidden: true,
    });
    expect(saveProfileCollection.mock.calls[0]![0]).toMatchObject({
      profile: {
        profilePhoto: 'https://example.com/fallback.jpg',
        name: null,
        username: 'example',
      },
      posts: [expect.objectContaining({ likesCount: null, likesHidden: true, viewsCount: null })],
    });
  });

  it('does not return success if the transaction fails and hides DB internals', async () => {
    fetchInstagramProfile.mockResolvedValue(profile());
    saveProfileCollection.mockRejectedValue(new Error('secret database internals'));
    const response = await request();
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('secret database internals');
  });
  it.each([null, { private: true }, { error: 'not_found' }, { id: 'invalid' }])(
    'never persists invalid or inaccessible profiles: %j',
    async (value) => {
      fetchInstagramProfile.mockResolvedValue(value);
      const response = await request();
      expect([404, 503]).toContain(response.statusCode);
      expect(saveProfileCollection).not.toHaveBeenCalled();
    },
  );
  it('rejects counters that cannot be stored in PostgreSQL INTEGER', async () => {
    fetchInstagramProfile.mockResolvedValue({ ...profile(), followersCount: 2147483648 });
    const response = await request();
    expect(response.statusCode).toBe(503);
    expect(saveProfileCollection).not.toHaveBeenCalled();
  });
  it('persists a valid profile even without posts', async () => {
    fetchInstagramProfile.mockResolvedValue({ ...profile(), latestPosts: [] });
    saveProfileCollection.mockResolvedValue({ instagramProfileId: 'internal' });
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(saveProfileCollection.mock.calls[0]![0].posts).toEqual([]);
  });
  it('does not persist a reused username that resolves to a different external ID', async () => {
    fetchInstagramProfile.mockResolvedValue(profile());
    await expect(
      getInstagramProfile(
        { username: 'example' },
        { expectedInstagramId: 'different-id', refreshMetricsSince: new Date() },
      ),
    ).rejects.toThrow('outro perfil');
    expect(saveProfileCollection).not.toHaveBeenCalled();
  });
  it('passes scheduled refresh options only for the internal collection', async () => {
    fetchInstagramProfile.mockResolvedValue(profile());
    saveProfileCollection.mockResolvedValue({ instagramProfileId: 'internal' });
    const since = new Date();
    await getInstagramProfile(
      { username: 'example' },
      { expectedInstagramId: 'external-profile', refreshMetricsSince: since },
    );
    expect(fetchInstagramProfile).toHaveBeenCalledWith('example', { timeout: 60, waitSecs: 70 });
    expect(saveProfileCollection.mock.calls[0]![0].refreshMetricsSince).toBe(since);
  });
});
