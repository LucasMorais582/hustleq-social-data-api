import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  enqueueDailyBatch,
  prepareDailyRun,
  readDailyTargets,
  commitDailyProfile,
  finishDailyAttempt,
} from '../src/modules/instagram/jobs/instagram.daily.repository.js';
import { findActiveProfileSyncJob } from '../src/modules/instagram/jobs/instagram.profile-job.repository.js';
import { initialProfileCollection } from '../src/modules/instagram/jobs/instagram.initial-sync.service.js';
import profileFixture from './fixtures/instagram/profile-sample.json' with { type: 'json' };
const now = new Date('2026-11-24T09:00:00Z');
function fixture() {
  const profile = {
    id: 'profile',
    instagramId: profileFixture.id,
    username: 'example',
    ownerUserId: 'owner',
    monitoringUntil: null,
    lastSyncedAt: null,
  };
  const metadata = {
    daily: {
      ownerUserId: 'owner',
      date: '2026-11-24',
      profileIds: ['profile'],
      remainingProfileIds: ['profile'],
      completedProfileIds: [],
      skippedProfileIds: [],
      failures: {},
    },
    providerSteps: {},
    providerAttempts: {},
    runTargets: {},
  };
  const job = {
    id: 'batch',
    type: 'DAILY_PROFILE_SYNC',
    userId: 'owner',
    attempts: 1,
    payload: metadata,
    leaseExpiresAt: new Date('2099-01-01'),
  };
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async (query: TemplateStringsArray) => {
      const sql = query.join('');
      if (sql.includes('SELECT *')) return [job];
      if (sql.includes(' AS valid')) return [{ valid: true }];
      if (sql.includes('clock_timestamp() AS now')) return [{ now }];
      if (sql.includes('RETURNING')) return [{ id: 'batch', status: 'PENDING' }];
      return [{ id: 'profile' }];
    }),
    instagramProfile: {
      findMany: vi.fn().mockResolvedValue([profile]),
      findUnique: vi.fn().mockResolvedValue(profile),
      findUniqueOrThrow: vi.fn().mockResolvedValue(profile),
      update: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'profile' }),
    },
    instagramProfileSnapshot: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    instagramPost: { findMany: vi.fn().mockResolvedValue([]) },
    instagramSyncJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'batch' }),
      update: vi.fn(),
    },
    providerRun: { findUniqueOrThrow: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'run' }) },
  };
  const transaction = vi.fn(async (work: (value: typeof tx) => unknown) => work(tx));
  return {
    tx,
    profile,
    job,
    metadata,
    client: { $transaction: transaction } as unknown as PrismaClient,
    transaction,
  };
}
const owner = { id: 'batch', lockToken: 'token' };
beforeEach(() => vi.clearAllMocks());
describe('Daily persistence', () => {
  it('queues eligible profiles and records the owner/date/membership atomically', async () => {
    const f = fixture();
    expect(await enqueueDailyBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      queued: 1,
    });
    expect(f.tx.instagramSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'DAILY_PROFILE_SYNC',
        userId: 'owner',
        payload: expect.objectContaining({
          daily: expect.objectContaining({
            profileIds: ['profile'],
            remainingProfileIds: ['profile'],
          }),
        }),
      }),
    });
    expect(f.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });
  it.each([null, 'another-user'])('does not queue profiles owned by %s', async (ownerId) => {
    const f = fixture();
    Object.assign(f.profile, { ownerUserId: ownerId });
    expect(await enqueueDailyBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      notDue: 1,
      queued: 0,
    });
  });
  it.each([-1, 0])('excludes expired monitoring at offset %i', async (offset) => {
    const f = fixture();
    Object.assign(f.profile, { monitoringUntil: new Date(now.getTime() + offset) });
    expect(await enqueueDailyBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      notDue: 1,
    });
  });
  it.each([
    [20 * 3600000 - 1, 0],
    [20 * 3600000, 1],
    [20 * 3600000 + 1, 1],
  ])('uses 20h freshness at age %i', async (age, expected) => {
    const f = fixture();
    Object.assign(f.profile, { lastSyncedAt: new Date(now.getTime() - age) });
    expect((await enqueueDailyBatch(['profile'], 'owner', '2026-11-24', f.client)).queued).toBe(
      expected,
    );
  });
  it('does not start another job for a profile already attempted on the same local date', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findFirst.mockResolvedValueOnce({ id: 'old-failed-batch' });
    expect(await enqueueDailyBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      reused: 1,
      queued: 0,
    });
  });
  it('detects a Daily reservation for a non-primary member', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findFirst.mockResolvedValueOnce({ id: 'batch' });
    expect(await findActiveProfileSyncJob('second', f.tx as unknown as PrismaClient)).toMatchObject(
      { id: 'batch' },
    );
    expect(f.tx.instagramSyncJob.findFirst).toHaveBeenCalledWith({
      where: {
        type: 'DAILY_PROFILE_SYNC',
        userId: 'owner',
        status: { in: ['PENDING', 'RUNNING'] },
        payload: { path: ['daily', 'remainingProfileIds'], array_contains: ['second'] },
      },
    });
  });
  it('does not let an old Daily prevent a new reservation after ownership is cleared', async () => {
    const f = fixture();
    Object.assign(f.profile, { ownerUserId: null });
    expect(await findActiveProfileSyncJob('profile', f.tx as unknown as PrismaClient)).toBeNull();
    expect(f.tx.instagramSyncJob.findFirst).not.toHaveBeenCalled();
  });
  it('rechecks ownership before Actor input and removes skipped members', async () => {
    const f = fixture();
    f.profile.ownerUserId = 'other';
    expect(await readDailyTargets(owner, f.client)).toEqual([]);
    expect(f.tx.instagramSyncJob.update.mock.calls[0]![0].data.payload.daily).toMatchObject({
      remainingProfileIds: [],
      skippedProfileIds: ['profile'],
    });
  });
  it('records a real run once against the batch owner', async () => {
    const f = fixture();
    await prepareDailyRun(
      owner,
      'profile',
      'apify/instagram-profile-scraper',
      ['profile'],
      f.client,
    );
    expect(f.tx.providerRun.create).toHaveBeenCalledWith({
      data: {
        actor: 'apify/instagram-profile-scraper',
        trigger: 'daily',
        userId: 'owner',
        status: 'running',
        instagramProfileId: 'profile',
      },
    });
  });
  it('reuses a broader known run when only part of the batch remains', async () => {
    const f = fixture();
    Object.assign(f.metadata, {
      providerSteps: { profile: ['old-run'] },
      providerAttempts: { 'old-run': 1 },
      runTargets: { 'old-run': ['profile', 'already-completed'] },
    });
    f.job.attempts = 2;
    f.tx.providerRun.findUniqueOrThrow.mockResolvedValue({
      id: 'old-run',
      actor: 'actor',
      trigger: 'daily',
      userId: 'owner',
      status: 'succeeded',
    });
    expect(await prepareDailyRun(owner, 'profile', 'actor', ['profile'], f.client)).toMatchObject({
      fresh: false,
    });
    expect(f.tx.providerRun.create).not.toHaveBeenCalled();
  });
  it('does not overwrite a completed profile when retrying another member', async () => {
    const f = fixture();
    f.metadata.daily.remainingProfileIds = [];
    await expect(
      commitDailyProfile(
        owner,
        'profile',
        initialProfileCollection(
          { ...profileFixture, latestPosts: [] },
          profileFixture.id,
          [],
          now,
        ),
        f.client,
      ),
    ).rejects.toThrow('ALREADY_PROCESSED');
    expect(f.tx.instagramProfile.upsert).not.toHaveBeenCalled();
  });
  it('commits a profile snapshot and removes its membership in one fenced transaction', async () => {
    const f = fixture();
    const data = initialProfileCollection(
      { ...profileFixture, latestPosts: [] },
      profileFixture.id,
      [],
      now,
    );
    await commitDailyProfile(owner, 'profile', data, f.client);
    expect(f.tx.instagramProfileSnapshot.create).toHaveBeenCalledTimes(1);
    expect(f.tx.instagramProfile.update).toHaveBeenCalledWith({
      where: { id: 'profile' },
      data: { syncStatus: 'ready', lastSyncedAt: now },
    });
    expect(f.tx.instagramSyncJob.update.mock.calls[0]![0].data.payload.daily).toMatchObject({
      completedProfileIds: ['profile'],
      remainingProfileIds: [],
    });
  });
  it('releases a corrupt payload through bounded retries instead of leaving a running lease forever', async () => {
    const f = fixture();
    Object.assign(f.job, { payload: { corrupted: true } });
    expect(await finishDailyAttempt(owner, {}, undefined, f.client)).toMatchObject({
      status: 'PENDING',
      updated: 0,
    });
    expect(f.tx.instagramProfile.update).not.toHaveBeenCalled();
  });
  it('preserves successful profiles and waits/retries when other members remain', async () => {
    const f = fixture();
    expect(
      await finishDailyAttempt(owner, { profile: 'PROFILE_PRIVATE' }, undefined, f.client),
    ).toMatchObject({ status: 'PENDING' });
    expect(f.tx.instagramProfile.update).not.toHaveBeenCalled();
  });
  it('completes an empty remaining set without touching profile status', async () => {
    const f = fixture();
    f.metadata.daily.remainingProfileIds = [];
    expect(await finishDailyAttempt(owner, {}, undefined, f.client)).toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(f.tx.instagramProfile.update).not.toHaveBeenCalled();
  });
  it('retries serializable conflicts without duplicating a batch', async () => {
    const f = fixture();
    f.transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    await enqueueDailyBatch(['profile'], 'owner', '2026-11-24', f.client);
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.tx.instagramSyncJob.create).toHaveBeenCalledTimes(1);
  });
});
