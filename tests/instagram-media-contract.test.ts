import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders } from './helpers/auth.js';
const { fetchInstagramProfile, fetchInstagramPost, fetchInstagramTrends } = vi.hoisted(() => ({
  fetchInstagramProfile: vi.fn(),
  fetchInstagramPost: vi.fn(),
  fetchInstagramTrends: vi.fn(),
}));
vi.mock('../src/provider/apify/apify.provider.js', () => ({
  fetchInstagramProfile,
  fetchInstagramPost,
  fetchInstagramTrends,
}));
import { buildApp } from '../src/app.js';

describe('media contract across routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.resetAllMocks();
  });
  it.each([
    { legacy: 'Image', seemu: 'photo', expected: 'photo' },
    { legacy: 'Sidecar', seemu: 'carousel', expected: 'carousel' },
    { legacy: 'Video', seemu: 'reel', expected: 'reel' },
    { legacy: 'Video', seemu: 'video', expected: 'reel' },
  ])(
    'returns $expected for legacy $legacy and Seemu $seemu',
    async ({ legacy, seemu, expected }) => {
      const timestamp = new Date(Date.now() - 86400000).toISOString();
      const post = {
        id: '1',
        ownerId: 'owner',
        type: legacy,
        caption: '70 Adams St #4 #rj2026',
        url: 'https://www.instagram.com/p/example/',
        likesCount: 1000,
        commentsCount: 0,
        timestamp,
        hashtags: ['4', 'rj2026'],
      };
      fetchInstagramPost.mockResolvedValue([post]);
      fetchInstagramProfile.mockResolvedValue({
        id: 'owner',
        username: 'example',
        fullName: 'Example',
        biography: '',
        followersCount: 1,
        followsCount: 1,
        postsCount: 1,
        profilePicUrlHD: 'https://example.com/profile.jpg',
        latestPosts: [{ ...post, displayUrl: 'https://example.com/image.jpg' }],
      });
      fetchInstagramTrends.mockResolvedValue([
        {
          recordType: 'post',
          postId: '1',
          type: seemu,
          takenAt: timestamp,
          likeCount: 1000,
          hashtags: ['4', 'rj2026'],
        },
      ]);
      app = buildApp();
      const posts = await app.inject({
        method: 'POST',
        url: '/api/v1/instagram/post/search',
        headers: authHeaders(),
        payload: { username: 'example', resultLimits: 1 },
      });
      const profile = await app.inject({
        method: 'POST',
        url: '/api/v1/instagram/profile/search',
        headers: authHeaders(),
        payload: { username: 'example' },
      });
      const trends = await app.inject({
        method: 'POST',
        url: '/api/v1/instagram/trends/search',
        headers: authHeaders(),
        payload: { target: 'example' },
      });
      expect([posts.statusCode, profile.statusCode, trends.statusCode]).toEqual([200, 200, 200]);
      expect(posts.json().response[0].type).toBe(expected);
      expect(profile.json().response.posts[0].type).toBe(expected);
      expect(trends.json().response.posts[0].media.type).toBe(expected);
      expect(posts.json().response[0].hashtags).toEqual(['rj2026']);
      expect(trends.json().response.posts[0].hashtags).toEqual(['rj2026']);
      expect(posts.json().response[0].caption).toBe('70 Adams St #4 #rj2026');
    },
  );
});
