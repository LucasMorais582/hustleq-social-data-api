import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders } from './helpers/auth.js';
const { fetchInstagramPost, savePostCollection } = vi.hoisted(() => ({
  fetchInstagramPost: vi.fn(),
  savePostCollection: vi.fn(),
}));
vi.mock('../src/provider/apify/apify.provider.js', () => ({ fetchInstagramPost }));
vi.mock('../src/modules/instagram/post/instagram.post.repository.js', () => ({
  savePostCollection,
}));
import { buildApp } from '../src/app.js';
const post = () => ({
  id: 'external-post',
  ownerId: 'external-author',
  ownerUsername: 'example',
  type: 'Video',
  caption: 'caption',
  likesCount: null,
  commentsCount: 2,
  videoViewCount: 3000000000,
  timestamp: '2026-11-19T10:00:00.000Z',
  hashtags: ['4', 'rj2026'],
});

describe('post/search persistence integration', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.resetAllMocks();
  });
  async function request() {
    app = buildApp();
    return app.inject({
      method: 'POST',
      url: '/api/v1/instagram/post/search',
      headers: authHeaders(),
      payload: { username: 'example', resultLimits: 10 },
    });
  }
  it('keeps the HTTP response and sends normalized DB data to the repository', async () => {
    fetchInstagramPost.mockResolvedValue([post()]);
    savePostCollection.mockResolvedValue(undefined);
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().response[0]).toMatchObject({
      id: 'external-post',
      type: 'reel',
      author: { id: 'external-author' },
    });
    const input = savePostCollection.mock.calls[0]![0];
    expect(input.posts[0]).toMatchObject({
      ownerInstagramId: 'external-author',
      instagramPostId: 'external-post',
      type: 'reel',
      likesCount: null,
      commentsCount: 2,
      viewsCount: 3000000000n,
      hashtags: ['rj2026'],
    });
    expect(input.posts[0].timestamp).toEqual(new Date('2026-11-19T10:00:00.000Z'));
    expect(input).not.toHaveProperty('profile');
  });
  it('still displays results when the repository skips all unregistered authors', async () => {
    fetchInstagramPost.mockResolvedValue([post()]);
    savePostCollection.mockResolvedValue(undefined);
    expect((await request()).json().response).toHaveLength(1);
  });
  it('does not report success when persistence is unavailable', async () => {
    fetchInstagramPost.mockResolvedValue([post()]);
    savePostCollection.mockRejectedValue(new Error('database credentials or SQL details'));
    const response = await request();
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('SQL details');
  });
  it.each([{ id: null }, { ownerId: null }])(
    'displays without inventing missing persistence identifiers: %j',
    async (patch) => {
      fetchInstagramPost.mockResolvedValue([{ ...post(), ...patch }]);
      const response = await request();
      expect(response.statusCode).toBe(200);
      expect(response.json().response).toHaveLength(1);
      expect(savePostCollection).not.toHaveBeenCalled();
    },
  );
  it('validates the entire collection before any writes', async () => {
    fetchInstagramPost.mockResolvedValue([post(), { ...post(), id: 'bad', likesCount: -1 }]);
    const response = await request();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(savePostCollection).not.toHaveBeenCalled();
  });
  it('preserves zero play counts instead of falling back to views', async () => {
    fetchInstagramPost.mockResolvedValue([{ ...post(), videoPlayCount: 0 }]);
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(savePostCollection.mock.calls[0]![0].posts[0].viewsCount).toBe(0n);
  });
  it('keeps an empty result without opening the repository', async () => {
    fetchInstagramPost.mockResolvedValue([]);
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().response).toEqual([]);
    expect(savePostCollection).not.toHaveBeenCalled();
  });
});
