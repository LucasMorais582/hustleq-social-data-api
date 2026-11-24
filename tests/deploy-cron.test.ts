import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

async function run(env: Record<string, string>, status = 200) {
  const source = await readFile(new URL('../deploy/instagram-cron.mjs', import.meta.url), 'utf8');
  const http = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status });
  const process = { env, exitCode: 0 };
  const log = { info: vi.fn(), error: vi.fn() };
  const execute = new Function(
    'process',
    'fetch',
    'console',
    `return (async () => { ${source}\n })();`,
  ) as (process: unknown, http: unknown, log: unknown) => Promise<void>;
  await execute(process, http, log);
  return { http, process, log };
}
const secret = 'test-cron-secret-with-at-least-32-characters';
describe('VPS scheduling client', () => {
  it('sends the secret only as a header to loopback, with timeout and no redirects', async () => {
    const result = await run({ CRON_SECRET: secret, PORT: '3001' });
    expect(result.http).toHaveBeenCalledWith('http://127.0.0.1:3001/api/cron/instagram-refresh', {
      headers: { authorization: `Bearer ${secret}` },
      signal: expect.any(AbortSignal),
      redirect: 'error',
    });
    expect(result.process.exitCode).toBe(0);
    expect(JSON.stringify(result.log.info.mock.calls)).not.toContain(secret);
  });
  it.each([401, 409, 503])(
    'exits with failure on HTTP %i without exposing credentials or response body',
    async (status) => {
      const result = await run({ CRON_SECRET: secret }, status);
      expect(result.process.exitCode).toBe(1);
      expect(JSON.stringify(result.log.error.mock.calls)).not.toContain(secret);
    },
  );
  it.each(['0', '65536', 'abc', '1.5'])('rejects invalid PORT %s', async (port) => {
    await expect(run({ CRON_SECRET: secret, PORT: port })).rejects.toThrow('PORT inválida');
  });
  it('rejects missing credentials before attempting HTTP', async () => {
    await expect(run({})).rejects.toThrow('CRON_SECRET');
  });
});
