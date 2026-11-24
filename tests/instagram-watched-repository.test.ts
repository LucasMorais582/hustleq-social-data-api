import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  enqueueWatchedBatch,
  prepareWatchedRun,
  readWatchedTargets,
  commitWatchedProfile,
  finishWatchedAttempt,
} from '../src/modules/instagram/jobs/instagram.watched.repository.js';
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
    watched: {
      userId: 'owner',
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
    type: 'WATCHED_SYNC',
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
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'batch' }),
      update: vi.fn(),
    },
    instagramCompetitor: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { competitorProfileId: 'profile', instagramProfile: { ownerUserId: 'owner' } },
        ]),
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
describe('Watched persistence and attribution', () => {
  it('queues an unowned target using the eligible watcher, ignoring the target monitoring date', async () => {
    const f = fixture();
    Object.assign(f.profile, { ownerUserId: null, monitoringUntil: new Date(0) });
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      queued: 1,
    });
    expect(f.tx.instagramCompetitor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          endedAt: null,
          competitorProfileId: { in: ['profile'] },
          instagramProfile: {
            ownerUserId: { not: null },
            OR: [{ monitoringUntil: null }, { monitoringUntil: { gt: now } }],
          },
        },
      }),
    );
  });
  it('deduplicates multiple sources of the same user and does not consider it shared billing', async () => {
    const f = fixture();
    const rows = f.tx.instagramCompetitor.findMany.getMockImplementation()!;
    f.tx.instagramCompetitor.findMany.mockImplementation(async () => [
      ...(await rows()),
      ...(await rows()),
    ]);
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      queued: 1,
    });
    expect(f.tx.instagramSyncJob.create.mock.calls[0]![0].data.userId).toBe('owner');
  });
  it('queues a target shared by distinct users only with unattributed billing', async () => {
    const f = fixture();
    f.tx.instagramCompetitor.findMany.mockResolvedValue([
      { competitorProfileId: 'profile', instagramProfile: { ownerUserId: 'owner' } },
      { competitorProfileId: 'profile', instagramProfile: { ownerUserId: 'another' } },
    ]);
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      notDue: 1,
    });
    expect(await enqueueWatchedBatch(['profile'], null, '2026-11-24', f.client)).toMatchObject({
      queued: 1,
    });
    expect(f.tx.instagramSyncJob.create.mock.calls[0]![0].data.userId).toBeNull();
  });
  it('drops ended/paused/no-owner sources and rechecks them before reading and saving', async () => {
    const f = fixture();
    f.tx.instagramCompetitor.findMany.mockResolvedValue([]);
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      notDue: 1,
    });
    expect(await readWatchedTargets(owner, f.client)).toEqual([]);
    const collection = initialProfileCollection(
      { ...profileFixture, latestPosts: [] },
      profileFixture.id,
      [],
      now,
    );
    await commitWatchedProfile(owner, 'profile', collection, f.client);
    expect(f.tx.instagramProfile.upsert).not.toHaveBeenCalled();
  });
  it.each([20 * 3600000 - 1, 0])('does not collect a fresh target (%i ms)', async (age) => {
    const f = fixture();
    f.profile.lastSyncedAt = new Date(now.getTime() - age) as never;
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      notDue: 1,
    });
    expect(await readWatchedTargets(owner, f.client)).toEqual([]);
  });
  it('allows collection exactly at 20h', async () => {
    const f = fixture();
    f.profile.lastSyncedAt = new Date(now.getTime() - 20 * 3600000) as never;
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      queued: 1,
    });
  });
  it('skips a failed Daily that actually prepared a Profile Actor for this target', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findMany.mockResolvedValue([
      {
        payload: {
          daily: {
            ownerUserId: 'owner',
            date: '2026-11-24',
            profileIds: ['profile'],
            remainingProfileIds: ['profile'],
          },
          providerSteps: { profile: ['run'] },
          runTargets: { run: ['profile'] },
        },
      },
    ] as never);
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      reused: 1,
    });
    expect(await readWatchedTargets(owner, f.client)).toEqual([]);
    expect(f.tx.instagramSyncJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: 'DAILY_PROFILE_SYNC',
          AND: expect.arrayContaining([
            { payload: { path: ['daily', 'date'], equals: '2026-11-24' } },
          ]),
        },
      }),
    );
  });
  it('checks the current New York date too when a job is delayed across midnight', async () => {
    const f = fixture();
    f.metadata.watched.date = '2026-11-23';
    await readWatchedTargets(owner, f.client);
    expect(f.tx.instagramSyncJob.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        AND: expect.arrayContaining([
          {
            OR: [
              { payload: { path: ['daily', 'date'], equals: '2026-11-23' } },
              { payload: { path: ['daily', 'date'], equals: '2026-11-24' } },
            ],
          },
        ]),
      },
    });
  });
  it('allows a Daily target that was merely queued then skipped without an Actor', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findMany.mockResolvedValue([
      {
        payload: {
          daily: {
            ownerUserId: 'former',
            date: '2026-11-24',
            profileIds: ['profile'],
            remainingProfileIds: [],
            skippedProfileIds: ['profile'],
          },
        },
      },
    ] as never);
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      queued: 1,
    });
  });
  it('skips a new sequence after a terminal Watched failure on the same local date', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findFirst.mockResolvedValueOnce({ id: 'old-failed' });
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      reused: 1,
    });
  });
  it('can reserve Watched behind an unattempted Daily; the worker barrier prevents another execution', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findFirst.mockImplementation(
      async (input: { where: { type: string } }) =>
        input.where.type === 'DAILY_PROFILE_SYNC'
          ? { id: 'daily', type: 'DAILY_PROFILE_SYNC' }
          : null,
    );
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      queued: 1,
    });
  });
  it('does not reset paid attempts when an old batch skipped a member after its payer changed', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findMany.mockResolvedValue([
      {
        payload: {
          watched: {
            userId: 'former',
            date: '2026-11-24',
            profileIds: ['profile'],
            remainingProfileIds: [],
            skippedProfileIds: ['profile'],
          },
          providerSteps: { profile: ['paid'] },
          runTargets: { paid: ['profile'] },
        },
      },
    ] as never);
    expect(await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client)).toMatchObject({
      queued: 0,
      reused: 1,
    });
  });
  it('retains an active target reservation even when the current payer changed', async () => {
    const f = fixture();
    Object.assign(f.profile, { ownerUserId: null });
    f.tx.instagramSyncJob.findFirst.mockResolvedValue({
      id: 'running-watched',
      userId: 'former',
      type: 'WATCHED_SYNC',
    });
    expect(
      await findActiveProfileSyncJob('profile', f.tx as unknown as PrismaClient),
    ).toMatchObject({ id: 'running-watched' });
  });
  it('does not charge the old user if attribution changes before the Actor starts', async () => {
    const f = fixture();
    f.tx.instagramCompetitor.findMany.mockResolvedValue([
      { competitorProfileId: 'profile', instagramProfile: { ownerUserId: 'new-user' } },
    ]);
    expect(await readWatchedTargets(owner, f.client)).toEqual([]);
    await expect(
      prepareWatchedRun(owner, 'profile', 'actor', ['profile'], f.client),
    ).rejects.toThrow('ELIGIBILITY_CHANGED');
    expect(f.tx.providerRun.create).not.toHaveBeenCalled();
  });
  it('blocks a newly queued Daily before a paid Watched run', async () => {
    const f = fixture();
    f.tx.instagramSyncJob.findFirst.mockResolvedValue({ id: 'daily' });
    await expect(
      prepareWatchedRun(owner, 'profile', 'actor', ['profile'], f.client),
    ).rejects.toThrow('DAILY_SYNC_IN_PROGRESS');
    expect(f.tx.providerRun.create).not.toHaveBeenCalled();
  });
  it('records the shared execution cost once with null userId and watched trigger', async () => {
    const f = fixture();
    Object.assign(f.job, { userId: null });
    Object.assign(f.metadata.watched, { userId: null });
    f.tx.instagramCompetitor.findMany.mockResolvedValue([
      { competitorProfileId: 'profile', instagramProfile: { ownerUserId: 'one' } },
      { competitorProfileId: 'profile', instagramProfile: { ownerUserId: 'two' } },
    ]);
    await prepareWatchedRun(owner, 'profile', 'actor', ['profile'], f.client);
    expect(f.tx.providerRun.create).toHaveBeenCalledWith({
      data: {
        actor: 'actor',
        trigger: 'watched',
        userId: null,
        status: 'running',
        instagramProfileId: 'profile',
      },
    });
  });
  it('reuses a known broader dataset and never repeats an uncertain Actor start', async () => {
    const f = fixture();
    Object.assign(f.metadata, {
      providerSteps: { profile: ['run'] },
      providerAttempts: { run: 1 },
      runTargets: { run: ['profile', 'completed'] },
    });
    f.job.attempts = 2;
    f.tx.providerRun.findUniqueOrThrow.mockResolvedValue({
      id: 'run',
      actor: 'actor',
      trigger: 'watched',
      userId: 'owner',
      status: 'running',
      apifyRunId: null,
    });
    expect(await prepareWatchedRun(owner, 'profile', 'actor', ['profile'], f.client)).toMatchObject(
      { fresh: false },
    );
    expect(f.tx.providerRun.create).not.toHaveBeenCalled();
  });
  it('commits public identity and source daily with progress atomically', async () => {
    const f = fixture();
    const collection = initialProfileCollection(
      { ...profileFixture, latestPosts: [] },
      profileFixture.id,
      [],
      now,
    );
    await commitWatchedProfile(owner, 'profile', collection, f.client);
    expect(f.tx.instagramProfileSnapshot.create).toHaveBeenCalledTimes(1);
    expect(f.tx.instagramSyncJob.update.mock.calls[0]![0].data.payload.watched).toMatchObject({
      completedProfileIds: ['profile'],
      remainingProfileIds: [],
    });
  });
  it('bounds retries for corrupt metadata without altering the old profile', async () => {
    const f = fixture();
    Object.assign(f.job, { payload: { invalid: true } });
    expect(await finishWatchedAttempt(owner, {}, undefined, f.client)).toMatchObject({
      status: 'PENDING',
      updated: 0,
    });
    expect(f.tx.instagramProfile.update).not.toHaveBeenCalled();
  });
  it('retains membership on a retry and completes an empty remaining set', async () => {
    const f = fixture();
    expect(
      await finishWatchedAttempt(owner, { profile: 'PROFILE_PRIVATE' }, undefined, f.client),
    ).toMatchObject({ status: 'PENDING' });
    f.metadata.watched.remainingProfileIds = [];
    expect(await finishWatchedAttempt(owner, {}, undefined, f.client)).toMatchObject({
      status: 'SUCCEEDED',
    });
  });
  it('retries a serialization conflict without duplicating the job', async () => {
    const f = fixture();
    f.transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    await enqueueWatchedBatch(['profile'], 'owner', '2026-11-24', f.client);
    expect(f.tx.instagramSyncJob.create).toHaveBeenCalledTimes(1);
  });
  it('recognizes a non-primary unowned member, but releases an ended relation', async () => {
    const f = fixture();
    Object.assign(f.profile, { ownerUserId: null });
    f.tx.instagramSyncJob.findFirst.mockResolvedValue({
      id: 'batch',
      type: 'WATCHED_SYNC',
      userId: 'owner',
    });
    expect(
      await findActiveProfileSyncJob('profile', f.tx as unknown as PrismaClient),
    ).toMatchObject({ id: 'batch' });
    f.tx.instagramCompetitor.findMany.mockResolvedValue([]);
    expect(await findActiveProfileSyncJob('profile', f.tx as unknown as PrismaClient)).toBeNull();
  });
});
