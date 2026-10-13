import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

describe('GET /api/v1/health', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns an OK health status', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'hustleq-social-data-api' });
  });

  it('exposes the OpenAPI documentation UI', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/docs' });

    expect(response.statusCode).toBe(302);
  });
});
