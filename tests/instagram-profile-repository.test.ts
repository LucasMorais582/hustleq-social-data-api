import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  saveProfileCollection,
  type ProfileCollection,
} from '../src/modules/instagram/profile/instagram.profile.repository.js';

function collection(): ProfileCollection {
  return {
    collectedAt: new Date('2026-11-17T12:00:00.000Z'),
    profile: {
      instagramId: 'external-id',
      username: 'example',
      name: null,
      url: null,
      bio: null,
      profilePhoto: null,
      category: null,
      isVerified: null,
      followers: 10,
      following: null,
      postsCount: 1,
    },
    posts: [
      {
        instagramPostId: 'post-external',
        type: 'photo',
        url: null,
        caption: null,
        hashtags: [],
        images: [],
        displayUrl: null,
        timestamp: null,
        ownerUsername: 'example',
        likesCount: null,
        likesHidden: false,
        commentsCount: 1,
        viewsCount: 3000000000n,
      },
    ],
  };
}

function fixture() {
  const tx = {
    instagramProfile: { upsert: vi.fn().mockResolvedValue({ id: 'profile-internal' }) },
    instagramProfileSnapshot: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    instagramPost: {
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'post-internal' }),
    },
    instagramPostMetricSnapshot: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  const client = { $transaction: transaction } as unknown as PrismaClient;
  return { tx, transaction, client };
}

describe('profile collection persistence', () => {
  it.each(['initial', 'daily'] as const)(
    'records %s as the follower snapshot source',
    async (source) => {
      const f = fixture();
      const input = collection();
      input.metricSource = source;
      await saveProfileCollection(input, f.client);
      expect(f.tx.instagramProfileSnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ source }),
      });
    },
  );
  it('refreshes a collected historical post even outside the top twelve on Initial Sync', async () => {
    const f = fixture();
    const input = collection();
    input.metricSource = 'initial';
    input.refreshAllCollectedPosts = true;
    f.tx.instagramPost.findUnique.mockResolvedValue({
      id: 'post-internal',
      instagramProfileId: 'profile-internal',
    });
    await saveProfileCollection(input, f.client);
    expect(f.tx.instagramPostMetricSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: 'initial' }),
    });
    expect(f.tx.instagramPost.findMany).not.toHaveBeenCalled();
    expect(f.tx.instagramPost.update).toHaveBeenCalledWith({
      where: { id: 'post-internal' },
      data: { lastCollectedAt: input.collectedAt },
    });
  });
  it('does not supersede newer metrics with a delayed Initial history chunk', async () => {
    const f = fixture();
    const input = collection();
    input.refreshAllCollectedPosts = true;
    f.tx.instagramPost.findUnique.mockResolvedValue({
      id: 'post-internal',
      instagramProfileId: 'profile-internal',
    });
    f.tx.instagramPostMetricSnapshot.findFirst.mockResolvedValue({
      collectedAt: new Date(input.collectedAt.getTime() + 1),
    });
    await saveProfileCollection(input, f.client);
    expect(f.tx.instagramPostMetricSnapshot.create).not.toHaveBeenCalled();
    expect(f.tx.instagramPost.update).not.toHaveBeenCalled();
  });
  it('allows a daily count the next New York day even when the previous snapshot is less than 20h old', async () => {
    const f = fixture();
    const input = collection();
    input.collectedAt = new Date('2026-11-26T09:00:00Z');
    input.profileSnapshotCadence = 'new-york-day';
    input.profileSnapshotMinIntervalHours = 20; // The calendar policy deliberately takes precedence.
    f.tx.instagramProfileSnapshot.findFirst.mockImplementation(async ({ where }) => {
      const previous = new Date('2026-11-25T22:32:00-03:00');
      return previous >= where.collectedAt.gte && previous < where.collectedAt.lt
        ? { collectedAt: previous }
        : null;
    });
    await saveProfileCollection(input, f.client);
    expect(f.tx.instagramProfileSnapshot.create).toHaveBeenCalledTimes(1);
  });
  it('does not create another follower count on the same New York day', async () => {
    const f = fixture();
    const input = collection();
    input.profileSnapshotCadence = 'new-york-day';
    f.tx.instagramProfileSnapshot.findFirst.mockResolvedValue({ collectedAt: input.collectedAt });
    await saveProfileCollection(input, f.client);
    expect(f.tx.instagramProfileSnapshot.create).not.toHaveBeenCalled();
    expect(f.tx.instagramPost.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    [20 * 3600000 - 1, 0],
    [20 * 3600000, 1],
    [23 * 3600000, 1],
  ])('uses the automatic 20h snapshot interval at age %i', async (age, expected) => {
    const f = fixture();
    const input = collection();
    input.profileSnapshotMinIntervalHours = 20;
    f.tx.instagramProfileSnapshot.findFirst.mockResolvedValue({
      collectedAt: new Date(input.collectedAt.getTime() - age),
    } as never);
    await saveProfileCollection(input, f.client);
    expect(f.tx.instagramProfileSnapshot.create).toHaveBeenCalledTimes(expected);
  });

  it('saves identity and first snapshots together without claiming ownership', async () => {
    const { tx, client, transaction } = fixture();
    await saveProfileCollection(collection(), client);
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    const identity = tx.instagramProfile.upsert.mock.calls[0]![0];
    expect(identity.where).toEqual({ instagramId: 'external-id' });
    expect(identity.create).not.toHaveProperty('ownerUserId');
    expect(identity.update).not.toHaveProperty('followers');
    expect(tx.instagramProfileSnapshot.create).toHaveBeenCalledWith({
      data: {
        instagramProfileId: 'profile-internal',
        source: null,
        followers: 10,
        following: null,
        postsCount: 1,
        collectedAt: collection().collectedAt,
      },
    });
    expect(tx.instagramPostMetricSnapshot.create).toHaveBeenCalledWith({
      data: {
        instagramPostId: 'post-internal',
        source: 'initial',
        likesCount: null,
        likesHidden: false,
        commentsCount: 1,
        viewsCount: 3000000000n,
        collectedAt: collection().collectedAt,
      },
    });
    expect(tx.instagramPost.upsert.mock.calls[0]![0].create).not.toHaveProperty('likesCount');
  });

  it.each([
    { elapsed: 0, expected: 0 },
    { elapsed: 86400000 - 1, expected: 0 },
    { elapsed: 86400000, expected: 1 },
    { elapsed: 86400001, expected: 1 },
    { elapsed: -1, expected: 0 },
  ])('creates $expected profile snapshots after $elapsed ms', async ({ elapsed, expected }) => {
    const { tx, client } = fixture();
    const input = collection();
    input.posts = [];
    tx.instagramProfileSnapshot.findFirst.mockResolvedValue({
      collectedAt: new Date(input.collectedAt.getTime() - elapsed),
    });
    await saveProfileCollection(input, client);
    expect(tx.instagramProfileSnapshot.create).toHaveBeenCalledTimes(expected);
  });

  it('updates existing posts without rewriting their metrics history', async () => {
    const { tx, client } = fixture();
    tx.instagramPost.findUnique.mockResolvedValue({
      id: 'post-internal',
      instagramProfileId: 'profile-internal',
    });
    await saveProfileCollection(collection(), client);
    expect(tx.instagramPost.upsert).toHaveBeenCalledTimes(1);
    expect(tx.instagramPostMetricSnapshot.create).not.toHaveBeenCalled();
  });

  it('does not make existing metrics look fresh when only content changes', async () => {
    const { tx, client } = fixture();
    tx.instagramPost.findUnique.mockResolvedValue({
      id: 'post-internal',
      instagramProfileId: 'profile-internal',
    });
    await saveProfileCollection(collection(), client);
    expect(tx.instagramPost.upsert.mock.calls[0]![0].update).not.toHaveProperty('lastCollectedAt');
    expect(tx.instagramPost.update).not.toHaveBeenCalled();
  });

  it('marks a post discovered during the daily collection with the daily source', async () => {
    const { tx, client } = fixture();
    const input = collection();
    input.refreshMetricsSince = input.collectedAt;
    await saveProfileCollection(input, client);
    expect(tx.instagramPostMetricSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: 'daily' }),
    });
    expect(tx.instagramPost.upsert.mock.calls[0]![0].create.lastCollectedAt).toEqual(
      input.collectedAt,
    );
  });

  it('never silently transfers posts between profiles', async () => {
    const { tx, client } = fixture();
    tx.instagramPost.findUnique.mockResolvedValue({
      id: 'post-internal',
      instagramProfileId: 'another-profile',
    });
    await expect(saveProfileCollection(collection(), client)).rejects.toThrow('outro perfil');
    expect(tx.instagramPost.upsert).not.toHaveBeenCalled();
  });

  it.each(['P2034', 'P2002'])('retries transactional conflicts %s', async (code) => {
    const { transaction, client } = fixture();
    transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', { code, clientVersion: '6' }),
    );
    await saveProfileCollection(collection(), client);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after three conflicts', async () => {
    const { transaction, client } = fixture();
    transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6' }),
    );
    await expect(saveProfileCollection(collection(), client)).rejects.toThrow('conflict');
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('propagates persistence failures so the caller cannot report success', async () => {
    const { tx, transaction, client } = fixture();
    tx.instagramPostMetricSnapshot.create.mockRejectedValue(new Error('database error'));
    await expect(saveProfileCollection(collection(), client)).rejects.toThrow('database error');
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('refreshes only collected posts among the ten most recent, preserving daily snapshots', async () => {
    const { tx, client } = fixture();
    const input = collection();
    input.refreshMetricsSince = new Date('2026-11-17T11:00:00Z');
    tx.instagramPost.findUnique.mockResolvedValue({
      id: 'post-internal',
      instagramProfileId: 'profile-internal',
    });
    tx.instagramPost.findMany.mockResolvedValue([
      { id: 'post-internal', instagramPostId: 'post-external' },
      { id: 'missing', instagramPostId: 'uncollected-post' },
    ]);
    await saveProfileCollection(input, client);
    expect(tx.instagramPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        where: { instagramProfileId: 'profile-internal', timestamp: { not: null } },
      }),
    );
    expect(tx.instagramPostMetricSnapshot.create).toHaveBeenCalledTimes(1);
    expect(tx.instagramPostMetricSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: 'daily' }),
    });
    expect(tx.instagramPost.update).toHaveBeenCalledWith({
      where: { id: 'post-internal' },
      data: { lastCollectedAt: input.collectedAt },
    });
    tx.instagramPost.update.mockClear();
    tx.instagramPostMetricSnapshot.create.mockClear();
    tx.instagramPostMetricSnapshot.findFirst.mockResolvedValue({ collectedAt: input.collectedAt });
    await saveProfileCollection(input, client);
    expect(tx.instagramPostMetricSnapshot.create).not.toHaveBeenCalled();
    expect(tx.instagramPost.update).not.toHaveBeenCalled();
  });
  it('does not refresh existing posts outside the top ten', async () => {
    const { tx, client } = fixture();
    const input = collection();
    input.refreshMetricsSince = new Date('2026-11-17T11:00:00Z');
    tx.instagramPost.findUnique.mockResolvedValue({
      id: 'post-internal',
      instagramProfileId: 'profile-internal',
    });
    tx.instagramPost.findMany.mockResolvedValue([]);
    await saveProfileCollection(input, client);
    expect(tx.instagramPostMetricSnapshot.create).not.toHaveBeenCalled();
    expect(tx.instagramPost.update).not.toHaveBeenCalled();
  });
});
