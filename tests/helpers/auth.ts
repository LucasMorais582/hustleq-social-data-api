import { createHmac } from 'node:crypto';

export function authHeaders(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'test-client',
      iss: 'hustleq',
      aud: 'hustleq-social-data-api',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', 'test-only-secret-at-least-32-characters')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return { authorization: `Bearer ${header}.${payload}.${signature}` };
}
