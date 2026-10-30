import { authHeaders } from './helpers/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { call, listItems } = vi.hoisted(() => ({
  call: vi.fn(),
  listItems: vi.fn(),
}));

vi.mock('../src/provider/apify/config/apify.client.js', () => ({
  createApifyClient: () => ({
    actor: () => ({ call }),
    dataset: () => ({ listItems }),
  }),
}));

import { buildApp } from '../src/app.js';

describe('POST /api/v1/instagram/post/search', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it('sends the requested limit to Apify as an integer', async () => {
    call.mockImplementation(async (input: { resultsLimit: unknown }) => {
      if (!Number.isInteger(input.resultsLimit)) {
        throw new Error('Field input.resultsLimit must be integer');
      }
      return { status: 'SUCCEEDED', defaultDatasetId: 'dataset' };
    });
    listItems.mockResolvedValue({ items: [{ id: 'post-1', type: 'Image', caption: 'Example' }] });
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      headers: authHeaders(),
      url: '/api/v1/instagram/post/search',
      payload: { username: 'helio_fagundes.04', resultLimits: 15 },
    });

    expect(call).toHaveBeenCalledWith({
      username: ['helio_fagundes.04'],
      resultsLimit: 15,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().response[0].id).toBe('post-1');
  });

  it.each([
    { available: 5, limit: 3, expected: 3 },
    { available: 2, limit: 3, expected: 2 },
    { available: 0, limit: 3, expected: 0 },
  ])(
    'returns $expected posts when $available are available and $limit requested',
    async ({ available, limit, expected }) => {
      call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
      listItems.mockResolvedValue({
        items: Array.from({ length: available }, (_, index) => ({
          id: `post-${index}`,
          type: 'Image',
        })),
      });
      app = buildApp();

      const response = await app.inject({
        method: 'POST',
        headers: authHeaders(),
        url: '/api/v1/instagram/post/search',
        payload: { username: 'helio_fagundes.04', resultLimits: limit },
      });

      expect(response.statusCode).toBe(200);
      expect(listItems).toHaveBeenCalledWith({ limit });
      expect(response.json().response).toHaveLength(expected);
      expect(response.json().response.map((post: { id: string }) => post.id)).toEqual(
        Array.from({ length: expected }, (_, index) => `post-${index}`),
      );
    },
  );
  it('rejects resultLimits above 50 before calling Apify', async () => {
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      headers: authHeaders(),
      url: '/api/v1/instagram/post/search',
      payload: { username: 'helio_fagundes.04', resultLimits: 51 },
    });
    expect(response.statusCode).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 51, 100, '50', null])(
    'rejects invalid resultLimits %j without a provider call',
    async (resultLimits) => {
      app = buildApp();
      const response = await app.inject({
        method: 'POST',
        headers: authHeaders(),
        url: '/api/v1/instagram/post/search',
        payload: { username: 'example', resultLimits },
      });
      expect(response.statusCode).toBe(400);
      expect(call).not.toHaveBeenCalled();
    },
  );
  it('accepts exactly fifty', async () => {
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    listItems.mockResolvedValue({ items: [] });
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      headers: authHeaders(),
      url: '/api/v1/instagram/post/search',
      payload: { username: 'example', resultLimits: 50 },
    });
    expect(response.statusCode).toBe(200);
    expect(call).toHaveBeenCalledWith({ username: ['example'], resultsLimit: 50 });
  });
});
