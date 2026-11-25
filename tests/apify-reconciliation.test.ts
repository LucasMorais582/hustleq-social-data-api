import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { reconcileProviderRuns } from '../src/provider/apify/apify.reconciliation.service.js';
import {
  reconciliationLimit,
  reconciliationOptions,
} from '../src/maintenance/reconcile-provider-runs.js';
const findMany = vi.fn(),
  count = vi.fn(),
  updateMany = vi.fn(),
  get = vi.fn();
const findUnique = vi.fn();
const client = {
  providerRun: { findMany, count, updateMany, findUnique },
} as unknown as PrismaClient;
const row = {
  id: 'local',
  apifyRunId: 'external',
  status: 'running',
  costUsd: null,
  error: null,
  finishedAt: null,
  items: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  findMany.mockResolvedValue([row]);
  findUnique.mockResolvedValue({ id: 'previous-id', startedAt: new Date('2026-11-23T00:00:00Z') });
  count.mockResolvedValue(2);
  updateMany.mockResolvedValue({ count: 1 });
  get.mockResolvedValue({
    id: 'external',
    status: 'SUCCEEDED',
    usageTotalUsd: 0.02,
    finishedAt: new Date('2026-11-24T10:00:00Z'),
  });
});
describe('read-only Apify reconciliation', () => {
  it('updates real terminal cost, retaining caller/actor/trigger and reporting unresolved starts', async () => {
    expect(await reconcileProviderRuns(100, client, { get })).toMatchObject({
      updated: 1,
      unresolvedStarts: 2,
    });
    expect(updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'succeeded', error: null });
    expect(updateMany.mock.calls[0]![0].data.costUsd.toString()).toBe('0.02');
    expect(updateMany.mock.calls[0]![0].data).not.toHaveProperty('userId');
    expect(updateMany.mock.calls[0]![0].where).toMatchObject({
      id: 'local',
      apifyRunId: 'external',
      status: 'running',
      costUsd: null,
    });
  });
  it.each(['FAILED', 'TIMED-OUT', 'ABORTED'])('records %s and its actual cost', async (status) => {
    get.mockResolvedValue({ id: 'external', status, usageTotalUsd: 0.003 });
    await reconcileProviderRuns(1, client, { get });
    expect(updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'failed',
      error: 'PROVIDER_UNAVAILABLE',
    });
  });
  it('detects a rate-limited status message even with SUCCEEDED status', async () => {
    get.mockResolvedValue({
      id: 'external',
      status: 'SUCCEEDED',
      statusMessage: 'Free tier: please wait 10 minutes',
    });
    await reconcileProviderRuns(1, client, { get });
    expect(updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'failed',
      error: 'PROVIDER_RATE_LIMITED',
    });
  });
  it('preserves dataset-level refusal even when the Actor itself succeeded', async () => {
    findMany.mockResolvedValue([{ ...row, status: 'failed', error: 'PROVIDER_RATE_LIMITED' }]);
    await reconcileProviderRuns(1, client, { get });
    expect(updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'failed',
      error: 'PROVIDER_RATE_LIMITED',
    });
  });
  it('does not invent zero or delete a known cost if the API omits it', async () => {
    findMany.mockResolvedValue([{ ...row, costUsd: new Prisma.Decimal('0.03') }]);
    get.mockResolvedValue({ id: 'external', status: 'SUCCEEDED' });
    expect(await reconcileProviderRuns(1, client, { get })).toMatchObject({ unknownCost: 0 });
    expect(updateMany.mock.calls[0]![0].data).not.toHaveProperty('costUsd');
  });
  it('rechecks stored zero costs and replaces them only with an observed value', async () => {
    findMany.mockResolvedValue([{ ...row, status: 'succeeded', costUsd: new Prisma.Decimal(0) }]);
    await reconcileProviderRuns(1, client, { get });
    expect(findMany.mock.calls[0]![0].where.OR).toContainEqual({ costUsd: 0 });
    expect(updateMany.mock.calls[0]![0].data.costUsd.toString()).toBe('0.02');
  });
  it('reports unknown costs explicitly', async () => {
    get.mockResolvedValue({ id: 'external', status: 'SUCCEEDED' });
    expect(await reconcileProviderRuns(1, client, { get })).toMatchObject({ unknownCost: 1 });
  });
  it('leaves running executions untouched', async () => {
    get.mockResolvedValue({ id: 'external', status: 'RUNNING' });
    expect(await reconcileProviderRuns(1, client, { get })).toMatchObject({ pending: 1 });
    expect(updateMany).not.toHaveBeenCalled();
  });
  it.each([undefined, { id: 'wrong', status: 'SUCCEEDED' }])(
    'does not mutate missing/mismatched execution %j',
    async (value) => {
      get.mockResolvedValue(value);
      expect(await reconcileProviderRuns(1, client, { get })).toMatchObject({ failed: 1 });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );
  it('does not overwrite a concurrent worker update', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect(await reconcileProviderRuns(1, client, { get })).toMatchObject({
      conflicts: 1,
      updated: 0,
    });
  });
  it('contains transport errors without exposing credentials', async () => {
    get.mockRejectedValue(new Error('apify_api_secret'));
    const result = await reconcileProviderRuns(1, client, { get });
    expect(result.failed).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('paginates without allowing permanently unknown costs to block the next batch', async () => {
    const result = await reconcileProviderRuns(1, client, { get }, 'previous-id');
    expect(result.nextCursor).toBe('local');
    expect(findMany.mock.calls[0]![0].where.AND).toEqual([
      {
        OR: [
          { startedAt: { gt: new Date('2026-11-23T00:00:00Z') } },
          { startedAt: new Date('2026-11-23T00:00:00Z'), id: { gt: 'previous-id' } },
        ],
      },
    ]);
    expect(reconciliationOptions(['--after', 'previous-id', '--limit', '1'])).toEqual({
      after: 'previous-id',
      limit: 1,
    });
  });
  it('rejects a cursor missing from history without consulting Apify', async () => {
    findUnique.mockResolvedValue(null);
    await expect(reconcileProviderRuns(1, client, { get }, 'removed')).rejects.toThrow(
      'INVALID_CURSOR',
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it('does not consult Apify for an empty ledger', async () => {
    findMany.mockResolvedValue([]);
    expect(await reconcileProviderRuns(1, client, { get })).toMatchObject({ inspected: 0 });
    expect(get).not.toHaveBeenCalled();
  });
  it.each([0, -1, 501, 1.5])(
    'rejects invalid scan limit %j before database access',
    async (limit) => {
      await expect(reconcileProviderRuns(limit, client, { get })).rejects.toThrow('INVALID_LIMIT');
      expect(findMany).not.toHaveBeenCalled();
    },
  );
  it.each([[], ['--limit', '1'], ['--limit', '500']].map((args) => ({ args })))(
    'accepts CLI args $args',
    ({ args }) => {
      expect(reconciliationLimit(args)).toBe(args.length ? Number(args[1]) : 100);
    },
  );
  it.each(
    [
      ['--limit', '0'],
      ['--limit', '501'],
      ['--limit', '1.5'],
      ['--limit', '1', 'ignored'],
      ['--unknown', '2'],
    ].map((args) => ({ args })),
  )('rejects CLI args $args', ({ args }) => {
    expect(() => reconciliationLimit(args)).toThrow();
  });
});
