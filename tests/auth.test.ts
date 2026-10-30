import { authHeaders } from './helpers/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({
  createApifyClient: () => ({
    actor: () => ({ call }),
    dataset: () => ({ listItems: async () => ({ items: [] }) }),
  }),
}));
import { buildApp } from '../src/app.js';

describe('JWT Bearer authentication', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it.each([
    '/api/v1/instagram/profile/search',
    '/api/v1/instagram/post/search',
    '/api/v1/instagram/trends/search',
  ])('rejects missing credentials on %s before provider execution', async (url) => {
    app = buildApp();
    const response = await app.inject({ method: 'POST', url, payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('UNAUTHORIZED');
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    'invalid',
    'expired',
    'wrong-secret',
    'wrong-audience',
    'wrong-issuer',
    'missing-exp',
    'missing-sub',
    'wrong-algorithm',
  ])('rejects %s JWT', async (kind) => {
    app = buildApp();
    await app.ready();
    const payload: Record<string, unknown> = { sub: 'client' };
    const options: Record<string, unknown> = {};
    if (kind === 'expired') payload.exp = Math.floor(Date.now() / 1000) - 60;
    if (kind === 'wrong-audience') payload.aud = 'other';
    if (kind === 'wrong-issuer') payload.iss = 'other';
    if (kind === 'wrong-algorithm') options.algorithm = 'HS384';
    let token = app.jwt.sign(payload, options);
    if (kind === 'missing-exp' || kind === 'missing-sub') {
      const overrides = kind === 'missing-exp' ? { exp: undefined } : { sub: undefined };
      token = authHeaders(overrides).authorization.slice('Bearer '.length);
    }
    if (kind === 'invalid') token = 'invalid';
    if (kind === 'wrong-secret')
      token = token.slice(0, token.lastIndexOf('.') + 1) + 'invalidsignature';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/instagram/trends/search',
      headers: { authorization: `Bearer ${token}` },
      payload: { target: 'Guaratiba' },
    });
    expect(response.statusCode).toBe(401);
    expect(call).not.toHaveBeenCalled();
  });

  it('accepts a valid token', async () => {
    app = buildApp();
    await app.ready();
    call.mockResolvedValue({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
    const token = app.jwt.sign({ sub: 'client' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/instagram/trends/search',
      headers: { authorization: `Bearer ${token}` },
      payload: { keywords: ['Guaratiba'] },
    });
    expect(response.statusCode).toBe(200);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps health and docs public', async () => {
    app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(200);
  });
});
