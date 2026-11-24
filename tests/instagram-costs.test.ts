import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { authHeaders } from './helpers/auth.js';
const mock = vi.hoisted(() => ({ groups: vi.fn(), apify: vi.fn() }));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({ providerRun: { groupBy: mock.groups } }),
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({ createApifyClient: mock.apify }));
import { buildApp } from '../src/app.js';
const path = '/api/v1/internal/costs';
const headers = () => authHeaders({ sub: 'hustleq-main', scope: 'service' });
function group(
  userId: string | null,
  trigger: string,
  cost: string | null,
  runs = 1,
  known = cost === null ? 0 : runs,
) {
  return {
    userId,
    trigger,
    _sum: { costUsd: cost === null ? null : new Prisma.Decimal(cost) },
    _count: { _all: runs, costUsd: known },
  };
}
let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  vi.resetAllMocks();
  app = buildApp();
  mock.groups.mockResolvedValue([]);
});
afterEach(async () => {
  await app.close();
});
const read = (query = 'month=2026-11') =>
  app.inject({ url: `${path}?${query}`, headers: headers() });

describe('MVP costs endpoint 12', () => {
  it('returns zero and empty groups for a month without runs', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      month: '2026-11',
      totalUsd: 0,
      byUser: [],
      byTrigger: [],
      unattributedUsd: 0,
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mock.apify).not.toHaveBeenCalled();
  });
  it('sums decimal amounts exactly and groups without counting unattributed as a user', async () => {
    mock.groups.mockResolvedValue([
      group('b', 'initial', '0.100001', 2),
      group('a', 'search', '0.2'),
      group('a', 'initial', '0.000002'),
      group(null, 'search', '0.000003'),
    ]);
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      month: '2026-11',
      totalUsd: 0.300006,
      byUser: [
        { userId: 'a', costUsd: 0.200002, runs: 2 },
        { userId: 'b', costUsd: 0.100001, runs: 2 },
      ],
      byTrigger: [
        { trigger: 'initial', costUsd: 0.100003, runs: 3 },
        { trigger: 'search', costUsd: 0.200003, runs: 2 },
      ],
      unattributedUsd: 0.000003,
    });
    expect(mock.groups).toHaveBeenCalledTimes(1);
    expect(mock.groups).toHaveBeenCalledWith({
      by: ['userId', 'trigger'],
      where: {
        startedAt: { gte: new Date('2026-11-01T00:00:00Z'), lt: new Date('2026-12-01T00:00:00Z') },
      },
      _sum: { costUsd: true },
      _count: { _all: true, costUsd: true },
      orderBy: [{ userId: 'asc' }, { trigger: 'asc' }],
    });
  });
  it('marks only affected totals null while keeping all run counts', async () => {
    mock.groups.mockResolvedValue([
      group('a', 'initial', '0.1', 3, 2),
      group('a', 'search', '0.2'),
      group('b', 'search', '0'),
      group(null, 'search', '0.3'),
    ]);
    expect((await read()).json()).toEqual({
      month: '2026-11',
      totalUsd: null,
      byUser: [
        { userId: 'a', costUsd: null, runs: 4 },
        { userId: 'b', costUsd: 0, runs: 1 },
      ],
      byTrigger: [
        { trigger: 'initial', costUsd: null, runs: 3 },
        { trigger: 'search', costUsd: 0.5, runs: 3 },
      ],
      unattributedUsd: 0.3,
    });
  });
  it('preserves unknown unattributed costs and known user costs', async () => {
    mock.groups.mockResolvedValue([
      group('owner', 'daily', '0.000001'),
      group(null, 'initial', null, 2),
    ]);
    expect((await read()).json()).toMatchObject({
      totalUsd: null,
      unattributedUsd: null,
      byUser: [{ userId: 'owner', costUsd: 0.000001, runs: 1 }],
      byTrigger: [
        { trigger: 'daily', costUsd: 0.000001, runs: 1 },
        { trigger: 'initial', costUsd: null, runs: 2 },
      ],
    });
  });
  it('does not treat zero as unknown', async () => {
    mock.groups.mockResolvedValue([group(null, 'initial', '0', 2)]);
    expect((await read()).json()).toMatchObject({ totalUsd: 0, unattributedUsd: 0, byUser: [] });
  });
  it.each([
    ['2026-12', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['2024-02', '2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
    ['0001-01', '0001-01-01T00:00:00.000Z', '0001-02-01T00:00:00.000Z'],
  ])('uses UTC calendar boundaries for %s', async (month, from, to) => {
    expect((await read(`month=${month}`)).statusCode).toBe(200);
    const dates = mock.groups.mock.calls[0]![0].where.startedAt;
    expect(dates.gte.toISOString()).toBe(from);
    expect(dates.lt.toISOString()).toBe(to);
  });
  it.each([
    '',
    'month=',
    'month=2026-1',
    'month=2026-00',
    'month=2026-13',
    'month=0000-01',
    'month=26-11',
    'month=2026-11-01',
    'month=2026-11&extra=1',
    'month=2026-11&month=2026-12',
    'month=%202026-11',
    'month=2026-11%20',
  ])('rejects invalid query %s', async (query) => {
    const response = await read(query);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(mock.groups).not.toHaveBeenCalled();
  });
  it('authenticates before database access', async () => {
    const response = await app.inject({ url: path + '?month=2026-11' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(mock.groups).not.toHaveBeenCalled();
  });
  it('rejects expired service tokens', async () => {
    expect(
      (
        await app.inject({
          url: path + '?month=2026-11',
          headers: authHeaders({
            sub: 'hustleq-main',
            scope: 'service',
            exp: Math.floor(Date.now() / 1000) - 1,
          }),
        })
      ).statusCode,
    ).toBe(401);
    expect(mock.groups).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { sub: 'hustleq-main' },
    { sub: 'someone', scope: 'service' },
    { sub: 'hustleq-main', scope: 'other' },
  ])('requires exact service identity %j', async (claims) => {
    expect(
      (await app.inject({ url: path + '?month=2026-11', headers: authHeaders(claims) })).statusCode,
    ).toBe(403);
    expect(mock.groups).not.toHaveBeenCalled();
  });
  it('hides SQL/connection details on failure', async () => {
    mock.groups.mockRejectedValue(new Error('sensitive SQL credentials'));
    const response = await read();
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('sensitive');
  });
  it.each(['-0.1', 'NaN', 'Infinity', '0.0000001', '9007199254.740992'])(
    'rejects invalid or unsafe sums %s',
    async (sum) => {
      mock.groups.mockResolvedValue([group('a', 'daily', sum)]);
      expect((await read()).statusCode).toBe(500);
    },
  );
  it('rejects an impossible known-cost count', async () => {
    mock.groups.mockResolvedValue([group('a', 'daily', '1', 1, 2)]);
    expect((await read()).statusCode).toBe(500);
  });
  it('rejects unsafe combined run counts', async () => {
    mock.groups.mockResolvedValue([
      group('a', 'daily', '1', Number.MAX_SAFE_INTEGER),
      group('a', 'initial', '1'),
    ]);
    expect((await read()).statusCode).toBe(500);
  });
  it('documents nullable sums and service authentication in Swagger', async () => {
    await app.ready();
    const spec = app.swagger() as {
      paths: Record<string, { get: { security: unknown; responses: unknown } }>;
    };
    expect(spec.paths[path]!.get.security).toEqual([{ bearerAuth: [] }]);
    expect(JSON.stringify(spec.paths[path]!.get.responses)).toContain('null');
  });
});
