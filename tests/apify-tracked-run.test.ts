import { describe, expect, it, vi } from 'vitest';
import { Prisma, type ProviderRun } from '@prisma/client';
import {
  executeTrackedActor,
  providerRunCost,
  ProviderStartUncertain,
} from '../src/provider/apify/apify.tracked-run.js';
function fixture() {
  const record = {
    id: 'local-run',
    actor: 'fixture',
    status: 'running',
    apifyRunId: null,
  } as ProviderRun;
  const prepare = vi.fn().mockResolvedValue({ run: record, fresh: true });
  const update = vi.fn().mockResolvedValue({});
  const heartbeat = vi.fn().mockResolvedValue(undefined);
  const finished = {
    id: 'apify-run',
    status: 'SUCCEEDED',
    defaultDatasetId: 'dataset',
    usageTotalUsd: 0.0023,
  };
  const gateway = {
    start: vi.fn().mockResolvedValue({ id: 'apify-run', status: 'RUNNING' }),
    get: vi.fn().mockResolvedValue(finished),
    items: vi.fn().mockResolvedValue({ items: [{ id: 'profile' }], total: 1 }),
  };
  const run = () =>
    executeTrackedActor(
      'fixture',
      { usernames: ['example'] },
      { prepare, update },
      heartbeat,
      gateway,
    );
  return { record, prepare, update, heartbeat, gateway, finished, run };
}
describe('tracked Apify executions', () => {
  it('persists the execution id and actual cost, including zero, before returning items', async () => {
    const f = fixture();
    expect(await f.run()).toEqual([{ id: 'profile' }]);
    expect(f.update).toHaveBeenNthCalledWith(1, 'local-run', { apifyRunId: 'apify-run' });
    expect(f.update).toHaveBeenCalledWith(
      'local-run',
      expect.objectContaining({ status: 'succeeded', costUsd: new Prisma.Decimal('0.0023') }),
    );
    expect(f.update).toHaveBeenLastCalledWith('local-run', { items: 1 });
  });
  it('resumes a persisted run without starting or charging another Actor', async () => {
    const f = fixture();
    f.record.apifyRunId = 'apify-run';
    f.prepare.mockResolvedValue({ run: f.record, fresh: false });
    await f.run();
    expect(f.gateway.start).not.toHaveBeenCalled();
    expect(f.gateway.get).toHaveBeenCalledWith('apify-run');
  });
  it('does not start a replacement for a failure already recorded in the current attempt', async () => {
    const f = fixture();
    f.record.status = 'failed';
    f.prepare.mockResolvedValue({ run: f.record, fresh: false });
    await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(f.gateway.start).not.toHaveBeenCalled();
    expect(f.gateway.get).not.toHaveBeenCalled();
  });
  it('does not repeat an ambiguous POST after a connection failure or process restart', async () => {
    const f = fixture();
    f.gateway.start.mockRejectedValue(new Error('socket closed'));
    await expect(f.run()).rejects.toBeInstanceOf(ProviderStartUncertain);
    expect(f.update).toHaveBeenCalledWith('local-run', { error: 'PROVIDER_START_UNCERTAIN' });
    f.prepare.mockResolvedValue({ run: f.record, fresh: false });
    await expect(f.run()).rejects.toBeInstanceOf(ProviderStartUncertain);
    expect(f.gateway.start).toHaveBeenCalledTimes(1);
  });
  it('records a definitive start refusal as failed so a later attempt can retry', async () => {
    const f = fixture();
    f.gateway.start.mockRejectedValue({ statusCode: 429 });
    await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(f.update).toHaveBeenCalledWith(
      'local-run',
      expect.objectContaining({ status: 'failed', error: 'PROVIDER_RATE_LIMITED' }),
    );
  });
  it('does not erase a previously observed cost when a resumed response omits usage', async () => {
    const f = fixture();
    f.record.apifyRunId = 'apify-run';
    f.record.costUsd = new Prisma.Decimal('0.0023');
    f.prepare.mockResolvedValue({ run: f.record, fresh: false });
    f.gateway.get.mockResolvedValue({ ...f.finished, usageTotalUsd: undefined });
    await f.run();
    expect(f.update).not.toHaveBeenCalledWith(
      'local-run',
      expect.objectContaining({ costUsd: null }),
    );
  });
  it('keeps a refusal message but redacts provider credentials', async () => {
    const f = fixture();
    f.gateway.start.mockRejectedValue(
      Object.assign(
        new Error(
          'Free tier: please wait 29 minutes https://api.example/?token=apify_api_fake-secret',
        ),
        { statusCode: 403 },
      ),
    );
    const error = await f.run().catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      message: expect.stringContaining('29'),
    });
    expect((error as Error).message).not.toContain('fake-secret');
  });
  it('records failed executions and their real costs without returning an empty success', async () => {
    const f = fixture();
    f.gateway.get.mockResolvedValue({ ...f.finished, status: 'FAILED' });
    await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(f.update).toHaveBeenCalledWith(
      'local-run',
      expect.objectContaining({ status: 'failed', costUsd: new Prisma.Decimal('0.0023') }),
    );
    expect(f.gateway.items).not.toHaveBeenCalled();
  });
  it('fails on rate-limited notices even when the Actor reports success', async () => {
    const f = fixture();
    f.gateway.items.mockResolvedValue({
      items: [{ recordType: 'notice', message: 'Free tier: please wait 29 more minutes' }],
      total: 1,
    });
    await expect(f.run()).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      message: expect.stringContaining('29'),
    });
    expect(f.update).toHaveBeenLastCalledWith('local-run', {
      status: 'failed',
      error: 'PROVIDER_RATE_LIMITED',
      items: 1,
    });
  });
  it('rejects notice-only results without inventing a missing profile', async () => {
    const f = fixture();
    f.gateway.items.mockResolvedValue({
      items: [{ recordType: 'notice', message: 'Unavailable' }],
      total: 1,
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
  it('keeps SUCCEEDED on a dataset download failure so the retry can read the same run', async () => {
    const f = fixture();
    f.gateway.items.mockRejectedValue(new Error('download failed'));
    await expect(f.run()).rejects.toThrow('download failed');
    expect(f.update).not.toHaveBeenCalledWith(
      'local-run',
      expect.objectContaining({ status: 'failed' }),
    );
  });
  it('bounds polling if the provider never reports a terminal status', async () => {
    const f = fixture();
    f.gateway.get.mockResolvedValue({ ...f.finished, status: 'RUNNING' });
    await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(f.gateway.start).toHaveBeenCalledTimes(1);
    expect(f.update).not.toHaveBeenCalledWith(
      'local-run',
      expect.objectContaining({ status: 'failed' }),
    );
  });
  it('does not return partial results when the dataset exceeds the safety limit', async () => {
    const f = fixture();
    f.gateway.items.mockResolvedValue({ items: [{ id: 'profile' }], total: 2 });
    await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });
  it('does not create a run when ownership is lost', async () => {
    const f = fixture();
    f.heartbeat.mockRejectedValue(new Error('lost lease'));
    await expect(f.run()).rejects.toThrow('lost lease');
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.gateway.start).not.toHaveBeenCalled();
  });
  it('does not start a replacement for a missing persisted Apify run', async () => {
    const f = fixture();
    f.record.apifyRunId = 'missing';
    f.gateway.get.mockResolvedValue(undefined);
    await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(f.gateway.start).not.toHaveBeenCalled();
  });
  it.each([undefined, -1, NaN, Infinity, 10000])(
    'keeps unsupported or unknown cost %s null',
    (value) => {
      expect(providerRunCost(value)).toBeNull();
    },
  );
  it('preserves zero cost and respects the database decimal precision', () => {
    expect(providerRunCost(0)?.toString()).toBe('0');
    expect(providerRunCost(0.1234567)?.toFixed(6)).toBe('0.123457');
  });
});
