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
      return { defaultDatasetId: 'dataset' };
    });
    listItems.mockResolvedValue({ items: [{ id: 'post-1', caption: 'Example' }] });
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
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
      call.mockResolvedValue({ defaultDatasetId: 'dataset' });
      listItems.mockResolvedValue({
        items: Array.from({ length: available }, (_, index) => ({ id: `post-${index}` })),
      });
      app = buildApp();

      const response = await app.inject({
        method: 'POST',
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
});
