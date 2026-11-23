import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../src/modules/instagram/profile/instagram.profile.repository.js', () => ({
  saveProfileCollectionInTransaction: save,
}));
import {
  withOwnedInitialSync,
  prepareInitialSyncRun,
  commitInitialProfileSync,
  SyncJobOwnershipLost,
} from '../src/modules/instagram/jobs/instagram.initial-sync.repository.js';
const owner = { id: 'job', lockToken: 'token' };
function fixture() {
  const job = {
    id: 'job',
    instagramProfileId: 'profile',
    trigger: 'initial',
    attempts: 1,
    userId: 'caller',
    payload: null,
    leaseExpiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const query = vi
    .fn()
    .mockResolvedValue([{ valid: true }])
    .mockResolvedValueOnce([job]);
  const tx = {
    $queryRaw: query,
    instagramProfile: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ ownerUserId: 'actual-owner', instagramId: 'external' }),
      update: vi.fn(),
    },
    instagramSyncJob: { update: vi.fn() },
    providerRun: {
      findUniqueOrThrow: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'local-run' }),
    },
  };
  const transaction = vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx));
  const client = { $transaction: transaction } as unknown as PrismaClient;
  return { client, job, query, tx, transaction };
}
beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue({ instagramProfileId: 'profile' });
});
describe('fenced initial sync persistence', () => {
  it('creates the ProviderRun and stores its id in job metadata atomically with attribution to the owner', async () => {
    const f = fixture();
    expect(await prepareInitialSyncRun(owner, 'profile', 'actor', f.client)).toEqual({
      run: { id: 'local-run' },
      fresh: true,
    });
    expect(f.tx.providerRun.create).toHaveBeenCalledWith({
      data: {
        actor: 'actor',
        trigger: 'initial',
        status: 'running',
        instagramProfileId: 'profile',
        userId: 'actual-owner',
      },
    });
    expect(f.tx.instagramSyncJob.update).toHaveBeenCalledWith({
      where: { id: 'job' },
      data: {
        payload: {
          providerSteps: { profile: ['local-run'] },
          providerAttempts: { 'local-run': 1 },
        },
      },
    });
    expect(f.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });
  it.each(['running', 'succeeded'])(
    'reuses a known %s execution instead of creating another billable run',
    async (status) => {
      const f = fixture();
      Object.assign(f.job, { payload: { providerSteps: { profile: ['previous'] } } });
      const previous = { id: 'previous', status, actor: 'actor', instagramProfileId: 'profile' };
      f.tx.providerRun.findUniqueOrThrow.mockResolvedValue(previous);
      expect(await prepareInitialSyncRun(owner, 'profile', 'actor', f.client)).toEqual({
        run: previous,
        fresh: false,
      });
      expect(f.tx.providerRun.create).not.toHaveBeenCalled();
    },
  );
  it('creates a new execution only after a definite failure, preserving the history', async () => {
    const f = fixture();
    Object.assign(f.job, {
      attempts: 2,
      payload: { providerSteps: { profile: ['failed'] }, providerAttempts: { failed: 1 } },
    });
    f.tx.providerRun.findUniqueOrThrow.mockResolvedValue({
      id: 'failed',
      status: 'failed',
      actor: 'actor',
      instagramProfileId: 'profile',
    });
    await prepareInitialSyncRun(owner, 'profile', 'actor', f.client);
    expect(
      f.tx.instagramSyncJob.update.mock.calls[0]![0].data.payload.providerSteps.profile,
    ).toEqual(['failed', 'local-run']);
  });
  it('does not create an extra Actor after a crash following failure in the same attempt', async () => {
    const f = fixture();
    Object.assign(f.job, {
      attempts: 3,
      payload: { providerSteps: { profile: ['failed'] }, providerAttempts: { failed: 3 } },
    });
    const previous = {
      id: 'failed',
      actor: 'actor',
      status: 'failed',
      instagramProfileId: 'profile',
    };
    f.tx.providerRun.findUniqueOrThrow.mockResolvedValue(previous);
    expect(await prepareInitialSyncRun(owner, 'profile', 'actor', f.client)).toEqual({
      run: previous,
      fresh: false,
    });
    expect(f.tx.providerRun.create).not.toHaveBeenCalled();
  });
  it('does not reuse metadata pointing to a run of another actor/profile', async () => {
    const f = fixture();
    Object.assign(f.job, { payload: { providerSteps: { profile: ['foreign'] } } });
    f.tx.providerRun.findUniqueOrThrow.mockResolvedValue({
      status: 'succeeded',
      actor: 'other',
      instagramProfileId: 'other-profile',
    });
    await expect(prepareInitialSyncRun(owner, 'profile', 'actor', f.client)).rejects.toThrow(
      'MISMATCH',
    );
    expect(f.tx.providerRun.create).not.toHaveBeenCalled();
  });
  it('does not write anything without ownership', async () => {
    const f = fixture();
    f.query.mockReset().mockResolvedValue([]);
    await expect(prepareInitialSyncRun(owner, 'profile', 'actor', f.client)).rejects.toBeInstanceOf(
      SyncJobOwnershipLost,
    );
    expect(f.tx.providerRun.create).not.toHaveBeenCalled();
  });
  it('rejects a transaction that crosses the lease deadline', async () => {
    const f = fixture();
    f.query
      .mockReset()
      .mockResolvedValueOnce([f.job])
      .mockResolvedValueOnce([{ valid: false }]);
    const work = vi.fn();
    await expect(withOwnedInitialSync(owner, work, f.client)).rejects.toBeInstanceOf(
      SyncJobOwnershipLost,
    );
    expect(work).toHaveBeenCalledOnce();
  });
  it('never commits data for a different Instagram identity', async () => {
    const f = fixture();
    await expect(
      commitInitialProfileSync(
        owner,
        { profile: { instagramId: 'wrong' } } as Parameters<typeof commitInitialProfileSync>[1],
        f.client,
      ),
    ).rejects.toThrow('IDENTITY');
    expect(save).not.toHaveBeenCalled();
  });
  it('retries SQL serialization conflicts without rerunning external work', async () => {
    const f = fixture();
    f.transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    await prepareInitialSyncRun(owner, 'profile', 'actor', f.client);
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.tx.providerRun.create).toHaveBeenCalledTimes(1);
  });
});
