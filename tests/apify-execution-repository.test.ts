import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('../src/provider/database/prisma.client.js', () => ({
  getPrismaClient: () => ({ providerRun: m }),
}));
import {
  beginProviderExecution,
  updateProviderExecution,
} from '../src/provider/apify/apify.execution.repository.js';
import { PersistenceError } from '../src/errors/persistence.error.js';
beforeEach(() => vi.resetAllMocks());
describe('legacy execution repository', () => {
  it('records a caller without assigning it to a profile or creating a User', async () => {
    await beginProviderExecution('actor', 'caller');
    expect(m.create).toHaveBeenCalledWith({
      data: { actor: 'actor', userId: 'caller', trigger: 'search', status: 'running' },
    });
  });
  it('does not expose database details when creating a ledger row fails', async () => {
    m.create.mockRejectedValue(new Error('postgresql://private-credentials'));
    await expect(beginProviderExecution('actor', 'caller')).rejects.toBeInstanceOf(
      PersistenceError,
    );
    await expect(beginProviderExecution('actor', 'caller')).rejects.not.toThrow(
      'private-credentials',
    );
  });
  it('does not expose database details when updating a paid execution fails', async () => {
    m.update.mockRejectedValue(new Error('sensitive SQL'));
    await expect(updateProviderExecution('id', { costUsd: '0.01' })).rejects.toBeInstanceOf(
      PersistenceError,
    );
  });
});
