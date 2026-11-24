import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders } from './helpers/auth.js';
import type * as DiscoverRepo from '../src/modules/instagram/discover/instagram.discover.repository.js';
const m = vi.hoisted(() => ({ begin: vi.fn(), progress: vi.fn(), apify: vi.fn() }));
vi.mock('../src/modules/instagram/discover/instagram.discover.repository.js', async (original) => ({
  ...(await original<typeof DiscoverRepo>()),
  beginDiscover: m.begin,
  readDiscoverProgress: m.progress,
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({ createApifyClient: m.apify }));
import { buildApp } from '../src/app.js';
import { getInstagramDiscover } from '../src/modules/instagram/discover/instagram.discover.service.js';
import {
  discoverKey,
  discoverKeyword,
  discoverQuerySchema,
} from '../src/modules/instagram/discover/instagram.discover.schemas.js';
import { freshDiscoverCache } from '../src/modules/instagram/discover/instagram.discover.repository.js';
const path = '/api/v1/instagram/discover';
const query = { niche: 'brazilian food', city: 'newark, nj', query: null };
const cache = {
  id: 'cache',
  key: discoverKey(query),
  ...query,
  fetchedAt: new Date('2026-11-23T12:00:00Z'),
  results: [],
};
let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  m.begin.mockResolvedValue({ cache, created: false, jobId: null });
  m.progress.mockResolvedValue({ job: { status: 'SUCCEEDED' }, cache });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await app.close();
});
const read = (
  q = 'niche=Brazilian%20Food&city=Newark,%20NJ',
  claims: Record<string, unknown> = {},
) => app.inject({ url: `${path}?${q}`, headers: authHeaders(claims) });

describe('Discover endpoint 16', () => {
  it('returns normalized shared cache in the flat MVP contract', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...query,
      fetchedAt: cache.fetchedAt.toISOString(),
      fromCache: true,
      posts: [],
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(m.begin).toHaveBeenCalledWith(query, 'test-client');
    expect(m.progress).not.toHaveBeenCalled();
    expect(m.apify).not.toHaveBeenCalled();
  });
  it('returns fromCache false only to the request that creates the search', async () => {
    m.begin.mockResolvedValue({ cache: null, jobId: 'job', created: true });
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json().fromCache).toBe(false);
    expect(m.progress).toHaveBeenCalledWith(cache.key, 'job');
  });
  it('returns fromCache true to callers sharing a running job', async () => {
    m.begin.mockResolvedValue({ cache: null, jobId: 'job', created: false });
    expect((await read()).json().fromCache).toBe(true);
  });
  it('accepts service warm-up without assigning costs to hustleq-main', async () => {
    expect((await read(undefined, { sub: 'hustleq-main', scope: 'service' })).statusCode).toBe(200);
    expect(m.begin).toHaveBeenCalledWith(query, null);
  });
  it('normalizes accents, casing and spaces and maps an empty query to null', async () => {
    const response = await read(
      'niche=%20COMIDA%20%20BRASILE%C3%8DRA%20&city=S%C3%A3o%20%20Paulo&query=%20%20',
    );
    expect(response.statusCode).toBe(200);
    expect(m.begin).toHaveBeenCalledWith(
      { niche: 'comida brasileira', city: 'sao paulo', query: null },
      'test-client',
    );
  });
  it('combines query with niche and city as one keyword', () => {
    const input = discoverQuerySchema.parse({ niche: 'Food', city: 'Newark', query: 'Feijoada' });
    expect(discoverKeyword(input)).toBe('food newark feijoada');
    expect(discoverKey(input)).toBe('["food","newark","feijoada"]');
  });
  it('avoids delimiter collisions in cache keys', () => {
    expect(discoverKey({ niche: 'a|b', city: 'c', query: null })).not.toBe(
      discoverKey({ niche: 'a', city: 'b|c', query: null }),
    );
  });
  it.each([
    '',
    'niche=food',
    'city=newark',
    'niche=%20&city=newark',
    'niche=food&city=',
    'niche=food&city=newark&minLikes=10',
    'niche=food&city=newark&postType=reel',
    'niche=food&city=newark&query=%00',
    'niche=food&city=newark&city=other',
    `niche=${'x'.repeat(201)}&city=newark`,
  ])('rejects invalid input %s', async (q) => {
    const response = await read(q);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(m.begin).not.toHaveBeenCalled();
  });
  it('requires authentication before using cache or creating jobs', async () => {
    expect((await app.inject({ url: path + '?niche=food&city=newark' })).statusCode).toBe(401);
    expect(m.begin).not.toHaveBeenCalled();
  });
  it('rejects expired tokens', async () => {
    expect((await read(undefined, { exp: Math.floor(Date.now() / 1000) - 1 })).statusCode).toBe(
      401,
    );
    expect(m.begin).not.toHaveBeenCalled();
  });
  it.each([{ sub: 'hustleq-main' }, { scope: 'service' }, { sub: 'hustleq-main', scope: 'other' }])(
    'rejects invalid caller role %j',
    async (claims) => {
      expect((await read(undefined, claims)).statusCode).toBe(403);
      expect(m.begin).not.toHaveBeenCalled();
    },
  );
  it.each([429, 503])('returns clear provider failure %i without stale data', async (status) => {
    m.begin.mockResolvedValue({ cache: null, jobId: 'job', created: true });
    m.progress.mockResolvedValue({
      job: { status: 'FAILED', payload: { failure: { status, message: 'Apify unavailable' } } },
      cache,
    });
    const response = await read();
    expect(response.statusCode).toBe(status);
    expect(response.json().error.message).toBe('Apify unavailable');
    expect(response.json()).not.toHaveProperty('posts');
  });
  it('does not treat a completed job without valid cache as success', async () => {
    m.begin.mockResolvedValue({ cache: null, jobId: 'job', created: true });
    m.progress.mockResolvedValue({ job: { status: 'SUCCEEDED' }, cache: null });
    expect((await read()).statusCode).toBe(503);
  });
  it('hides database details', async () => {
    m.begin.mockRejectedValue(new Error('sensitive SQL'));
    const response = await read();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('sensitive');
  });
  it('rejects a corrupted cached JSON instead of inventing posts', async () => {
    m.begin.mockResolvedValue({ cache: { ...cache, results: [{ forged: true }] } });
    expect((await read()).statusCode).toBe(500);
  });
  it('waits for retry completion without returning 202', async () => {
    m.begin.mockResolvedValue({ cache: null, jobId: 'job', created: true });
    m.progress.mockResolvedValueOnce({ job: { status: 'PENDING' }, cache: null });
    const result = await getInstagramDiscover(query, 'user', { pollMs: 1, waitMs: 1000 });
    expect(result.fromCache).toBe(false);
    expect(m.progress).toHaveBeenCalledTimes(2);
  });
  it('returns a timeout error without starting another job', async () => {
    m.begin.mockResolvedValue({ cache: null, jobId: 'job', created: true });
    m.progress.mockResolvedValue({ job: { status: 'RUNNING' }, cache: null });
    await expect(getInstagramDiscover(query, 'user', { waitMs: 0 })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(m.begin).toHaveBeenCalledTimes(1);
  });
  it('stops waiting on disconnect but keeps the durable job', async () => {
    m.begin.mockResolvedValue({ cache: null, jobId: 'job', created: true });
    const controller = new AbortController();
    controller.abort();
    await expect(
      getInstagramDiscover(query, 'user', { signal: controller.signal }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(m.progress).not.toHaveBeenCalled();
  });
  it('expires precisely at 24h and rejects future timestamps', () => {
    const fetchedAt = cache.fetchedAt;
    expect(freshDiscoverCache({ fetchedAt }, new Date(fetchedAt.getTime() + 86400000 - 1))).toBe(
      true,
    );
    expect(freshDiscoverCache({ fetchedAt }, new Date(fetchedAt.getTime() + 86400000))).toBe(false);
    expect(freshDiscoverCache({ fetchedAt }, new Date(fetchedAt.getTime() - 1))).toBe(false);
  });
});
