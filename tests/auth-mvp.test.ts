import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  authenticate,
  authenticateService,
  authenticatedUserId,
} from '../src/auth/authenticate.js';
import { authHeaders } from './helpers/auth.js';

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp();
  // Rotas de teste: nenhuma integração ou escrita no banco.
  app.get('/test/user', { onRequest: authenticate }, (request) => ({
    userId: authenticatedUserId(request),
  }));
  app.get('/test/internal', { onRequest: authenticateService }, () => ({ ok: true }));
});
afterEach(async () => {
  await app.close();
});
const now = () => Math.floor(Date.now() / 1000);

describe('MVP JWT user and service roles', () => {
  it('issues a five-minute token by default', async () => {
    await app.ready();
    const token = app.jwt.sign({ sub: 'hustleq-user-id' });
    const payload = app.jwt.decode<{ iat: number; exp: number }>(token)!;
    expect(payload.exp - payload.iat).toBe(300);
    const response = await app.inject({
      url: '/test/user',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: 'hustleq-user-id' });
  });
  it.each([
    { sub: '' },
    { sub: '   ' },
    { sub: 123 },
    { sub: ' user ' },
    { iat: undefined },
    { iat: now() + 60, exp: now() + 300 },
    { iat: now(), exp: now() + 301 },
    { iat: now(), exp: now() },
    { iat: now() - 600, exp: now() + 100 },
  ])('rejects invalid identity or lifetime %j', async (claims) => {
    const response = await app.inject({ url: '/test/user', headers: authHeaders(claims) });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });
  it.each([
    {},
    { sub: 'hustleq-main' },
    { scope: 'service' },
    { sub: 'hustleq-main', scope: 'OWNER' },
    { scope: 'admin' },
  ])('refuses non-service identity %j on internal routes', async (claims) => {
    const response = await app.inject({ url: '/test/internal', headers: authHeaders(claims) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });
  it('accepts only the exact service subject and scope', async () => {
    const response = await app.inject({
      url: '/test/internal',
      headers: authHeaders({ sub: 'hustleq-main', scope: 'service' }),
    });
    expect(response.statusCode).toBe(200);
  });
  it('returns 401 for missing authentication on internal routes', async () => {
    const response = await app.inject({ url: '/test/internal' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });
  it.each([
    { sub: 'hustleq-main', scope: 'service' },
    { sub: 'hustleq-main' },
    { scope: 'service' },
    { scope: 'OWNER' },
    { scope: 'COMPETITOR' },
  ])('does not accept service or claimed read scope %j on user routes', async (claims) => {
    const response = await app.inject({ url: '/test/user', headers: authHeaders(claims) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });
});
