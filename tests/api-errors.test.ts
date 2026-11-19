import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ApiError } from '../src/errors/api.error.js';
import { PersistenceError } from '../src/errors/persistence.error.js';
import { authHeaders } from './helpers/auth.js';

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
});
describe('MVP error envelope', () => {
  it('returns code, message and a UTC timestamp for authorization failures', async () => {
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/instagram/post/search',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: expect.any(String),
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      },
    });
  });
  it('returns INVALID_REQUEST for schema violations', async () => {
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/instagram/post/search',
      headers: authHeaders(),
      payload: { username: 'test', resultLimits: 51 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(response.body).not.toContain('ZodError');
  });
  it('handles malformed JSON with the same contract', async () => {
    app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/instagram/post/search',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });
  it.each([new Error('sensitive password and SQL'), new PersistenceError()])(
    'does not expose unhandled internal details',
    async (error) => {
      app = buildApp();
      app.get('/test/error', async () => {
        throw error;
      });
      const response = await app.inject({ url: '/test/error' });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('INTERNAL_ERROR');
      expect(response.body).not.toContain('password');
      expect(response.body).not.toContain('stack');
    },
  );
  it('preserves deliberate domain errors', async () => {
    app = buildApp();
    app.get('/test/missing-post', async () => {
      throw new ApiError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');
    });
    const response = await app.inject({ url: '/test/missing-post' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('POST_NOT_FOUND');
  });
  it('does not expose the Fastify default 404 payload', async () => {
    app = buildApp();
    const response = await app.inject({ url: '/unknown-route' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
