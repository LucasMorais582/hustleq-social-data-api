import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders } from './helpers/auth.js';

const { call, listItems } = vi.hoisted(() => ({ call: vi.fn(), listItems: vi.fn() }));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({
  createApifyClient: () => ({ actor: () => ({ call }), dataset: () => ({ listItems }) }),
}));
import { buildApp } from '../src/app.js';
const url = '/api/v1/instagram/trends/search';
const validPost = () => ({
  recordType: 'post',
  postId: '1',
  type: 'reel',
  likeCount: 1000,
  takenAt: new Date(Date.now() - 60000).toISOString(),
});

describe('Apify failure contracts', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.resetAllMocks();
  });
  async function request() {
    app = buildApp();
    return app.inject({
      method: 'POST',
      url,
      headers: authHeaders(),
      payload: { keywords: ['Guaratiba', 'Recreio'] },
    });
  }

  it.each([
    {
      message: 'Free tier: please wait 29 more minute(s)',
      statusCode: 429,
      code: 'RATE_LIMITED',
    },
    { message: 'Daily limit exceeded', statusCode: 429, code: 'RATE_LIMITED' },
    { message: 'No matching posts', statusCode: 503, code: 'PROVIDER_UNAVAILABLE' },
  ])('surfaces notice-only execution: $message', async ({ message, statusCode, code }) => {
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    listItems.mockResolvedValue({ items: [{ recordType: 'notice', message }] });
    const response = await request();
    expect(response.statusCode).toBe(statusCode);
    expect(response.json().error).toMatchObject({ code, message });
    expect(response.json()).not.toHaveProperty('response');
  });

  it.each(['FAILED', 'ABORTED', 'TIMED-OUT', 'RUNNING'])(
    'rejects %s runs without reading the dataset',
    async (status) => {
      call.mockResolvedValue({
        status,
        defaultDatasetId: 'dataset',
        statusMessage: 'Actor stopped',
      });
      const response = await request();
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Actor stopped',
      });
      expect(listItems).not.toHaveBeenCalled();
    },
  );

  it('recognizes a rate-limited failed execution', async () => {
    call.mockResolvedValue({
      status: 'FAILED',
      statusMessage: 'Free tier: please wait 29 more minute(s)',
    });
    const response = await request();
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('RATE_LIMITED');
  });

  it.each([429, 403, 500])('maps upstream HTTP %i to a provider error', async (upstreamStatus) => {
    call.mockRejectedValue(
      Object.assign(new Error('Apify rejected this request'), { statusCode: upstreamStatus }),
    );
    const response = await request();
    expect(response.statusCode).toBe(upstreamStatus === 429 ? 429 : 503);
    expect(response.json().error.message).toBe('Apify rejected this request');
  });

  it('maps dataset read failures to 503', async () => {
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    listItems.mockRejectedValue(new Error('Dataset unavailable'));
    const response = await request();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toBe('Dataset unavailable');
  });

  it('does not return partial success when a rate-limit notice accompanies posts', async () => {
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    listItems.mockResolvedValue({
      items: [validPost(), { recordType: 'notice', message: 'Too many requests' }],
    });
    const response = await request();
    expect(response.statusCode).toBe(429);
  });

  it('rejects success without a dataset id', async () => {
    call.mockResolvedValue({ status: 'SUCCEEDED' });
    const response = await request();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it.each([null, { recordType: 'post', postId: '1', type: 'unexpected' }])(
    'rejects malformed records %j',
    async (record) => {
      call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
      listItems.mockResolvedValue({ items: [record] });
      const response = await request();
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('PROVIDER_UNAVAILABLE');
    },
  );

  it('returns an empty result only when a successful execution has an empty dataset', async () => {
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    listItems.mockResolvedValue({ items: [] });
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().response.posts).toEqual([]);
  });
});
