import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/modules/instagram/refresh/instagram.refresh.service.js', () => ({
  runInstagramRefresh: run,
}));
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
const url = '/api/cron/instagram-refresh';
const secret = 'test-cron-secret-with-at-least-32-characters';
const original = { secret: env.CRON_SECRET, enabled: env.INSTAGRAM_REFRESH_ENABLED };

describe('protected daily refresh route', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.resetAllMocks();
    env.CRON_SECRET = original.secret;
    env.INSTAGRAM_REFRESH_ENABLED = original.enabled;
  });
  function prepare() {
    env.CRON_SECRET = secret;
    env.INSTAGRAM_REFRESH_ENABLED = true;
    app = buildApp();
    return app;
  }
  it.each([undefined, 'Bearer wrong', 'Basic credentials', 'Bearer '])(
    'rejects credentials %s',
    async (authorization) => {
      const instance = prepare();
      const response = await instance.inject({
        method: 'GET',
        url,
        headers: authorization ? { authorization } : {},
      });
      expect(response.statusCode).toBe(401);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it('is disabled until explicitly enabled', async () => {
    const instance = prepare();
    env.INSTAGRAM_REFRESH_ENABLED = false;
    const response = await instance.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('CRON_DISABLED');
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses unconfigured cron authentication', async () => {
    const instance = prepare();
    env.CRON_SECRET = undefined;
    expect((await instance.inject({ method: 'GET', url })).statusCode).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
  it('returns success only for complete execution', async () => {
    const instance = prepare();
    run.mockResolvedValue({
      skipped: false,
      total: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      pending: 0,
    });
    const response = await instance.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each([
    { failed: 1, pending: 0 },
    { failed: 0, pending: 2 },
  ])('reports incomplete execution %j as 503', async (summary) => {
    const instance = prepare();
    run.mockResolvedValue({ skipped: false, ...summary });
    const response = await instance.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('REFRESH_INCOMPLETE');
  });
  it.each([
    { failed: 1, pending: 0 },
    { failed: 0, pending: 1 },
  ])('reports incomplete Watched enqueue %j as 503', async (watched) => {
    const instance = prepare();
    run.mockResolvedValue({ skipped: false, failed: 0, pending: 0, watched });
    const response = await instance.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'REFRESH_INCOMPLETE', watched });
  });
  it('releases its in-process lock after an error', async () => {
    const instance = prepare();
    run.mockRejectedValueOnce(new Error('DB error')).mockResolvedValueOnce({ skipped: true });
    const options = { method: 'GET' as const, url, headers: { authorization: `Bearer ${secret}` } };
    expect((await instance.inject(options)).statusCode).toBe(503);
    expect((await instance.inject(options)).statusCode).toBe(200);
  });
  it('blocks a simultaneous invocation in the same process', async () => {
    const instance = prepare();
    let finish: (value: unknown) => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    run.mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const options = { method: 'GET' as const, url, headers: { authorization: `Bearer ${secret}` } };
    const first = instance.inject(options).then((response) => response.statusCode);
    await ready;
    const second = await instance.inject(options);
    finish({ skipped: true });
    expect(await first).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
