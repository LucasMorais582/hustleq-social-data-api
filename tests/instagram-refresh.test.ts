import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../src/errors/provider.error.js';
const { findMany, collect } = vi.hoisted(() => ({ findMany: vi.fn(), collect: vi.fn() }));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({ instagramProfile: { findMany } }),
}));
vi.mock('../src/modules/instagram/profile/instagram.profile.service.js', () => ({
  getInstagramProfile: collect,
}));
import { runInstagramRefresh } from '../src/modules/instagram/refresh/instagram.refresh.service.js';
const now = new Date('2026-11-19T11:30:00.000Z');

describe('daily refresh of stored Instagram profiles', () => {
  afterEach(() => vi.resetAllMocks());
  it('skips outside the schedule without DB or Apify calls', async () => {
    expect(await runInstagramRefresh(new Date('2026-11-19T10:00:00Z'))).toMatchObject({
      skipped: true,
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });
  it('collects eligible profiles with their expected identity and window start', async () => {
    findMany.mockResolvedValue([
      { instagramId: 'id1', username: 'one' },
      { instagramId: 'id2', username: 'two' },
    ]);
    collect.mockResolvedValue({});
    const result = await runInstagramRefresh(now, () => 0);
    expect(findMany).toHaveBeenCalledWith({
      where: { OR: [{ monitoringUntil: null }, { monitoringUntil: { gt: now } }] },
      orderBy: { id: 'asc' },
      select: { instagramId: true, username: true },
    });
    expect(result).toMatchObject({ total: 2, processed: 2, succeeded: 2, failed: 0, pending: 0 });
    expect(collect).toHaveBeenNthCalledWith(
      1,
      { username: 'one' },
      { expectedInstagramId: 'id1', refreshMetricsSince: new Date('2026-11-19T11:00:00Z') },
    );
    expect(collect).toHaveBeenNthCalledWith(
      2,
      { username: 'two' },
      expect.objectContaining({ expectedInstagramId: 'id2' }),
    );
  });
  it('handles an empty database without a provider call', async () => {
    findMany.mockResolvedValue([]);
    expect(await runInstagramRefresh(now)).toMatchObject({ total: 0, pending: 0 });
    expect(collect).not.toHaveBeenCalled();
  });
  it('continues after a profile failure and reports it', async () => {
    findMany.mockResolvedValue([
      { instagramId: '1', username: 'one' },
      { instagramId: '2', username: 'two' },
    ]);
    collect.mockRejectedValueOnce(new Error('failure')).mockResolvedValueOnce({});
    expect(await runInstagramRefresh(now, () => 0)).toMatchObject({
      processed: 2,
      failed: 1,
      succeeded: 1,
      pending: 0,
      failures: [{ instagramId: '1', code: 'REFRESH_FAILED' }],
    });
  });
  it('stops on provider rate limits and reports remaining profiles', async () => {
    findMany.mockResolvedValue([
      { instagramId: '1', username: 'one' },
      { instagramId: '2', username: 'two' },
    ]);
    collect.mockRejectedValue(new ProviderError(429, 'PROVIDER_RATE_LIMITED', 'Please wait'));
    expect(await runInstagramRefresh(now, () => 0)).toMatchObject({
      processed: 1,
      failed: 1,
      pending: 1,
    });
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it('does not start another profile when the time budget is exhausted', async () => {
    findMany.mockResolvedValue([{ instagramId: '1', username: 'one' }]);
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValue(180000);
    expect(await runInstagramRefresh(now, clock)).toMatchObject({ pending: 1, processed: 0 });
    expect(collect).not.toHaveBeenCalled();
  });
});
