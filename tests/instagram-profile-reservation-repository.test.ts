import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('../src/modules/instagram/jobs/instagram.sync-job.repository.js', () => ({
  enqueueInstagramSyncJob: enqueue,
}));
import { reserveVerifiedInstagramProfile } from '../src/modules/instagram/profile/instagram.profile.reservation.repository.js';
const now = new Date('2026-11-23T12:00:00Z');
const identity = {
  instagramId: '90071992547409931234',
  username: 'example',
  name: null,
  url: null,
  bio: null,
  profilePhoto: null,
  category: null,
  isVerified: null,
};
const input = {
  identity,
  inviteId: 'external-invite',
  reservedUntil: new Date('2026-11-25T00:00:00Z'),
  providerRunId: 'verified-run',
};
function fixture() {
  const profile = {
    id: 'internal-profile',
    ...identity,
    ownerUserId: null as string | null,
    reservedForInviteId: null as string | null,
    reservedUntil: null as Date | null,
    syncStatus: 'pending',
    lastSyncedAt: null as Date | null,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ now }]),
    instagramProfile: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(profile),
      update: vi.fn(),
    },
    providerRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    instagramSyncJob: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const transaction = vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx));
  return {
    tx,
    profile,
    transaction,
    client: { $transaction: transaction } as unknown as PrismaClient,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue({ id: 'job', status: 'PENDING' });
});
describe('verified profile reservation persistence', () => {
  it('reserves identity and queues the verified run in one serializable transaction without claiming ownership', async () => {
    const f = fixture();
    expect(await reserveVerifiedInstagramProfile(input, f.client)).toEqual({
      profileId: 'internal-profile',
      username: 'example',
      status: 'syncing',
    });
    expect(f.tx.instagramProfile.upsert).toHaveBeenCalledWith({
      where: { instagramId: identity.instagramId },
      create: {
        ...identity,
        reservedForInviteId: input.inviteId,
        reservedUntil: input.reservedUntil,
      },
      update: {
        ...identity,
        reservedForInviteId: input.inviteId,
        reservedUntil: input.reservedUntil,
      },
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'INITIAL_PROFILE_SYNC',
        instagramProfileId: 'internal-profile',
        activeKey: 'profile:internal-profile',
        payload: {
          providerSteps: { profile: ['verified-run'] },
          providerAttempts: { 'verified-run': 1 },
        },
      }),
      f.tx,
    );
    expect(f.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });
  it('rejects an existing owner before any write', async () => {
    const f = fixture();
    f.profile.ownerUserId = 'owner';
    f.tx.instagramProfile.findUnique.mockResolvedValue(f.profile);
    await expect(reserveVerifiedInstagramProfile(input, f.client)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROFILE_ALREADY_OWNED',
    });
    expect(f.tx.instagramProfile.upsert).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('rejects an active reservation of another invite without changing its deadline', async () => {
    const f = fixture();
    Object.assign(f.profile, {
      reservedForInviteId: 'another-invite',
      reservedUntil: input.reservedUntil,
    });
    f.tx.instagramProfile.findUnique.mockResolvedValue(f.profile);
    await expect(reserveVerifiedInstagramProfile(input, f.client)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROFILE_RESERVED',
    });
    expect(f.tx.instagramProfile.upsert).not.toHaveBeenCalled();
  });
  it.each([new Date(now.getTime() - 1), now])(
    'allows a previous reservation that has expired at %s',
    async (date) => {
      const f = fixture();
      Object.assign(f.profile, { reservedForInviteId: 'another-invite', reservedUntil: date });
      f.tx.instagramProfile.findUnique.mockResolvedValue(f.profile);
      expect(await reserveVerifiedInstagramProfile(input, f.client)).toMatchObject({
        status: 'syncing',
      });
    },
  );
  it('allows the same active invite and reuses its running job without overwriting worker metadata', async () => {
    const f = fixture();
    Object.assign(f.profile, {
      reservedForInviteId: input.inviteId,
      reservedUntil: input.reservedUntil,
    });
    f.tx.instagramProfile.findUnique.mockResolvedValue(f.profile);
    f.tx.instagramSyncJob.findUnique.mockResolvedValue({ id: 'previous-job', status: 'RUNNING' });
    await reserveVerifiedInstagramProfile(input, f.client);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it.each([0, 86400000 - 1])(
    'reserves a ready profile collected %s ms ago without queuing another sync',
    async (age) => {
      const f = fixture();
      Object.assign(f.profile, {
        syncStatus: 'ready',
        lastSyncedAt: new Date(now.getTime() - age),
      });
      f.tx.instagramProfile.findUnique.mockResolvedValue(f.profile);
      expect(await reserveVerifiedInstagramProfile(input, f.client)).toMatchObject({
        status: 'ready',
      });
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it.each([86400000, 86400000 + 1, -1])(
    'queues stale or invalid future lastSyncedAt, age %s ms',
    async (age) => {
      const f = fixture();
      Object.assign(f.profile, {
        syncStatus: 'ready',
        lastSyncedAt: new Date(now.getTime() - age),
      });
      f.tx.instagramProfile.findUnique.mockResolvedValue(f.profile);
      expect(await reserveVerifiedInstagramProfile(input, f.client)).toMatchObject({
        status: 'syncing',
      });
      expect(enqueue).toHaveBeenCalledOnce();
    },
  );
  it.each([now, new Date(now.getTime() - 1)])(
    'rechecks reservation expiry after lookup using the database clock',
    async (reservedUntil) => {
      const f = fixture();
      await expect(
        reserveVerifiedInstagramProfile({ ...input, reservedUntil }, f.client),
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' });
      expect(f.tx.instagramProfile.upsert).not.toHaveBeenCalled();
    },
  );
  it('fails the transaction if the verified execution is missing or no longer valid', async () => {
    const f = fixture();
    f.tx.providerRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(reserveVerifiedInstagramProfile(input, f.client)).rejects.toThrow(
      'VERIFIED_PROFILE_RUN_NOT_FOUND',
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('does not report a successful reservation if queue persistence fails', async () => {
    const f = fixture();
    enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(reserveVerifiedInstagramProfile(input, f.client)).rejects.toThrow(
      'queue unavailable',
    );
  });
  it.each(['P2034', 'P2002'])(
    'rechecks ownership/reservation on a transaction conflict %s',
    async (code) => {
      const f = fixture();
      f.transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('conflict', { code, clientVersion: 'test' }),
      );
      await reserveVerifiedInstagramProfile(input, f.client);
      expect(f.transaction).toHaveBeenCalledTimes(2);
    },
  );
});
