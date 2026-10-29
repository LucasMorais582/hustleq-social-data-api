import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { actor, call, listItems } = vi.hoisted(() => ({
  actor: vi.fn(),
  call: vi.fn(),
  listItems: vi.fn(),
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({
  createApifyClient: () => ({ actor, dataset: () => ({ listItems }) }),
}));
import { buildApp } from '../src/app.js';

const url = '/api/v1/instagram/trends/search';

describe('POST /api/v1/instagram/trends/search with Seemu', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  async function prepare(items: unknown[]) {
    actor.mockReturnValue({ call });
    call.mockResolvedValue({ defaultDatasetId: 'dataset' });
    listItems.mockResolvedValue({ items });
    app = buildApp();
    return app;
  }

  it('calls Seemu with the keyword, date filter and requested post count', async () => {
    const instance = await prepare([
      {
        recordType: 'post',
        postId: '1',
        type: 'reel',
        takenAt: new Date(Date.now() - 86400000).toISOString(),
        caption: 'Guaratiba',
        likeCount: 0,
        commentCount: 2,
        playCount: 123,
        ownerId: 'author-id',
        ownerUsername: 'author',
        videoUrl: 'https://example.com/video.mp4',
        displayUrl: 'https://example.com/cover.jpg',
        videoDuration: 12,
        locationName: 'Guaratiba',
        ignoredField: 'omit',
      },
    ]);
    const response = await instance.inject({
      method: 'POST',
      url,
      payload: { target: ' guaratiba ', searchLimit: 1, daysBack: 7 },
    });
    expect(response.statusCode).toBe(200);
    expect(actor).toHaveBeenCalledWith('seemuapps/instagram-keyword-posts-scraper');
    expect(call).toHaveBeenCalledWith({
      keywords: ['guaratiba'],
      maxPostsPerKeyword: 1,
      postType: 'all',
      dateFrom: '7 days',
    });
    const result = response.json().response;
    expect(result.target).toBe('guaratiba');
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]).toMatchObject({
      id: '1',
      caption: 'Guaratiba',
      author: { id: 'author-id', username: 'author' },
      metrics: { likesCount: 0, commentsCount: 2, playsCount: 123 },
      media: { type: 'reel', videoUrl: 'https://example.com/video.mp4', durationSeconds: 12 },
      location: 'Guaratiba',
    });
    expect(result.posts[0]).not.toHaveProperty('ignoredField');
  });

  it.each([{ items: [] }, { items: [{ recordType: 'notice', message: 'No matching posts' }] }])(
    'returns no posts for %j',
    async ({ items }) => {
      const instance = await prepare(items);
      const response = await instance.inject({
        method: 'POST',
        url,
        payload: { target: 'trilha' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().response).toMatchObject({ daysBack: 30, posts: [] });
      expect(call).toHaveBeenCalledWith({
        keywords: ['trilha'],
        maxPostsPerKeyword: 10,
        postType: 'all',
        dateFrom: '30 days',
      });
    },
  );

  it('supports photos and carousel media, preserving unknown metrics as null', async () => {
    const takenAt = new Date(Date.now() - 86400000).toISOString();
    const instance = await prepare([
      { recordType: 'post', postId: 'photo', type: 'photo', takenAt, likeCount: null },
      {
        recordType: 'post',
        postId: 'carousel',
        type: 'carousel',
        takenAt,
        carouselImageUrls: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
      },
    ]);
    const response = await instance.inject({
      method: 'POST',
      url,
      payload: { target: 'guaratiba' },
    });
    expect(response.statusCode).toBe(200);
    const posts = response.json().response.posts;
    expect(posts[0].metrics).toEqual({ likesCount: null, commentsCount: null, playsCount: null });
    expect(posts[1].media.images).toEqual([
      'https://example.com/1.jpg',
      'https://example.com/2.jpg',
    ]);
  });

  it('checks publication dates and applies the response limit after ignoring notices', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    vi.setSystemTime(now);
    const makePost = (postId: string, milliseconds: number) => ({
      recordType: 'post',
      type: 'reel',
      postId,
      takenAt: new Date(milliseconds).toISOString(),
    });
    const instance = await prepare([
      { recordType: 'notice' },
      makePost('old', now - 30 * 86400000 - 1),
      makePost('boundary', now - 30 * 86400000),
      makePost('future', now + 1),
      { recordType: 'post', type: 'reel', postId: 'missing-date' },
      makePost('extra', now),
    ]);
    const response = await instance.inject({
      method: 'POST',
      url,
      payload: { target: 'guaratiba', searchLimit: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().response.posts.map((post: { id: string }) => post.id)).toEqual([
      'boundary',
    ]);
  });

  it.each([
    { target: ' ' },
    { target: 'trilha', daysBack: 0 },
    { target: 'trilha', daysBack: 31 },
    { target: 'trilha', daysBack: 1.5 },
    { target: 'trilha', searchLimit: 0 },
    { target: 'trilha', searchLimit: 251 },
    { target: 'trilha', searchLimit: 1.5 },
  ])('rejects invalid input %j', async (payload) => {
    const instance = await prepare([]);
    const response = await instance.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects the old hashtag output instead of silently creating null posts', async () => {
    const instance = await prepare([
      { id: 'tag', url: 'https://www.instagram.com/explore/tags/tag' },
    ]);
    const response = await instance.inject({
      method: 'POST',
      url,
      payload: { target: 'guaratiba' },
    });
    expect(response.statusCode).toBe(500);
  });
});
