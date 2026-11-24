import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), call: vi.fn(), items: vi.fn() }));
vi.mock('../src/provider/apify/apify.execution.repository.js', () => ({
  beginProviderExecution: m.create,
  updateProviderExecution: m.update,
}));
vi.mock('../src/provider/apify/config/apify.client.js', () => ({
  createApifyClient: () => ({
    actor: () => ({ call: m.call }),
    dataset: () => ({ listItems: m.items }),
  }),
}));
import { withApifyCaller } from '../src/provider/apify/apify.execution-context.js';
import {
  fetchInstagramPost,
  fetchInstagramProfile,
  fetchInstagramTrends,
} from '../src/provider/apify/apify.provider.js';
const trends = {
  keywords: ['guaratiba'],
  searchLimit: 10,
  daysBack: 30,
  minLikes: 0,
  postType: 'all' as const,
};
beforeEach(() => {
  vi.resetAllMocks();
  m.create.mockImplementation(async (_actor, userId) => ({ id: `run-${userId}` }));
  m.call.mockResolvedValue({
    id: 'apify-known',
    status: 'SUCCEEDED',
    defaultDatasetId: 'dataset',
    usageTotalUsd: 0.0023,
  });
  m.items.mockResolvedValue({ items: [] });
});
describe('legacy provider ledger', () => {
  it.each([
    ['apify/instagram-profile-scraper', () => fetchInstagramProfile('example')],
    ['apify/instagram-post-scraper', () => fetchInstagramPost('example', 10)],
    ['seemuapps/instagram-keyword-posts-scraper', () => fetchInstagramTrends(trends)],
  ] as const)('records %s against the authenticated caller', async (actor, work) => {
    await withApifyCaller<Promise<unknown>>('caller', work);
    expect(m.create).toHaveBeenCalledWith(actor, 'caller');
    expect(m.update).toHaveBeenCalledWith(
      'run-caller',
      expect.objectContaining({
        apifyRunId: 'apify-known',
        status: 'succeeded',
        costUsd: expect.anything(),
      }),
    );
    expect(m.update.mock.calls[0]![1].costUsd.toString()).toBe('0.0023');
  });
  it('isolates overlapping requests and clears the context afterwards', async () => {
    await Promise.all([
      withApifyCaller('one', () => fetchInstagramPost('one', 1)),
      withApifyCaller('two', () => fetchInstagramPost('two', 1)),
    ]);
    expect(m.create.mock.calls.map((call) => call[1]).sort()).toEqual(['one', 'two']);
    await fetchInstagramPost('outside-context', 1);
    expect(m.create).toHaveBeenCalledTimes(2);
  });
  it('does not call a paid Actor when the ledger is unavailable', async () => {
    m.create.mockRejectedValue(new Error('DB unavailable'));
    await expect(withApifyCaller('one', () => fetchInstagramPost('one', 1))).rejects.toThrow();
    expect(m.call).not.toHaveBeenCalled();
  });
  it('keeps failed execution costs and a sanitized error code', async () => {
    m.call.mockResolvedValue({
      id: 'failed',
      status: 'FAILED',
      usageTotalUsd: 0.001,
      statusMessage: 'Actor stopped',
    });
    await expect(withApifyCaller('one', () => fetchInstagramPost('one', 1))).rejects.toThrow();
    expect(m.update).toHaveBeenCalledWith(
      'run-one',
      expect.objectContaining({
        status: 'failed',
        apifyRunId: 'failed',
        costUsd: expect.anything(),
      }),
    );
    expect(m.update).toHaveBeenLastCalledWith(
      'run-one',
      expect.objectContaining({ error: 'PROVIDER_UNAVAILABLE' }),
    );
  });
  it('preserves an uncertain start without falsely declaring zero cost or a definite failure', async () => {
    m.call.mockRejectedValue(new Error('timeout with apify_api_sensitive'));
    await expect(withApifyCaller('one', () => fetchInstagramPost('one', 1))).rejects.toThrow();
    expect(m.update).toHaveBeenLastCalledWith('run-one', { error: 'PROVIDER_START_UNCERTAIN' });
  });
  it('does not expose provider tokens in errors', async () => {
    m.call.mockRejectedValue(
      new Error('request failed: apify_api_secret https://example.com?token=secret'),
    );
    await expect(withApifyCaller('one', () => fetchInstagramPost('one', 1))).rejects.toMatchObject({
      message: 'request failed: [redacted] https://example.com?token=[redacted]',
    });
  });
  it('records a definite refusal and never estimates missing cost', async () => {
    m.call.mockRejectedValue(Object.assign(new Error('quota'), { statusCode: 429 }));
    await expect(withApifyCaller('one', () => fetchInstagramPost('one', 1))).rejects.toThrow();
    expect(m.update).toHaveBeenLastCalledWith(
      'run-one',
      expect.objectContaining({ status: 'failed', error: 'PROVIDER_RATE_LIMITED' }),
    );
    expect(m.update.mock.calls.at(-1)![1]).not.toHaveProperty('costUsd');
  });
  it('keeps the known succeeded run if only dataset download fails', async () => {
    m.items.mockRejectedValue(new Error('download timeout'));
    await expect(withApifyCaller('one', () => fetchInstagramPost('one', 1))).rejects.toThrow();
    expect(m.update.mock.calls[0]![1]).toMatchObject({
      status: 'succeeded',
      apifyRunId: 'apify-known',
    });
    expect(m.update.mock.calls.at(-1)![1]).not.toHaveProperty('status');
  });
  it('marks notice-only and rate-limited datasets failed without erasing their cost', async () => {
    m.items.mockResolvedValue({
      items: [{ recordType: 'notice', message: 'Free tier: please wait 10 minutes' }],
    });
    await expect(withApifyCaller('one', () => fetchInstagramTrends(trends))).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(m.update).toHaveBeenCalledWith(
      'run-one',
      expect.objectContaining({ status: 'failed', error: 'PROVIDER_RATE_LIMITED' }),
    );
  });
});
