import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  savePostCollection,
  type PostCollection,
} from '../src/modules/instagram/post/instagram.post.repository.js';

function collection(): PostCollection {
  return {
    collectedAt: new Date('2026-11-19T12:00:00Z'),
    posts: [
      {
        ownerInstagramId: 'external-author',
        instagramPostId: 'external-post',
        type: 'photo',
        url: null,
        caption: 'new caption',
        hashtags: ['rj'],
        displayUrl: null,
        images: [],
        timestamp: null,
        ownerUsername: null,
        likesCount: null,
        commentsCount: 2,
        viewsCount: 3000000000n,
      },
    ],
  };
}
function fixture() {
  const tx = {
    instagramProfile: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'internal-author', instagramId: 'external-author' }]),
    },
    instagramPost: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'internal-post' }),
    },
    instagramPostMetricSnapshot: { create: vi.fn() },
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  return { tx, transaction, client: { $transaction: transaction } as unknown as PrismaClient };
}

describe('post collection repository', () => {
  it('saves posts under the stored author and first metrics atomically', async () => {
    const { tx, client, transaction } = fixture();
    await savePostCollection(collection(), client);
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(tx.instagramPost.upsert.mock.calls[0]![0].create).toMatchObject({
      instagramProfileId: 'internal-author',
      instagramPostId: 'external-post',
    });
    expect(tx.instagramPost.upsert.mock.calls[0]![0].create).not.toHaveProperty('ownerInstagramId');
    expect(tx.instagramPost.upsert.mock.calls[0]![0].create).not.toHaveProperty('likesCount');
    expect(tx.instagramPostMetricSnapshot.create).toHaveBeenCalledWith({
      data: {
        instagramPostId: 'internal-post',
        likesCount: null,
        commentsCount: 2,
        viewsCount: 3000000000n,
        collectedAt: collection().collectedAt,
      },
    });
  });
  it('does not create profiles or save posts for unknown authors', async () => {
    const { tx, client } = fixture();
    tx.instagramProfile.findMany.mockResolvedValue([]);
    await savePostCollection(collection(), client);
    expect(tx.instagramPost.upsert).not.toHaveBeenCalled();
    expect(tx.instagramPostMetricSnapshot.create).not.toHaveBeenCalled();
  });
  it('only persists the known authors in a mixed collection', async () => {
    const { tx, client } = fixture();
    const input = collection();
    input.posts.push({
      ...input.posts[0]!,
      instagramPostId: 'unknown-author-post',
      ownerInstagramId: 'unknown',
    });
    await savePostCollection(input, client);
    expect(tx.instagramPost.upsert).toHaveBeenCalledTimes(1);
  });
  it('does not append metrics to existing posts', async () => {
    const { tx, client } = fixture();
    tx.instagramPost.findUnique.mockResolvedValue({ instagramProfileId: 'internal-author' });
    await savePostCollection(collection(), client);
    expect(tx.instagramPost.upsert).toHaveBeenCalledTimes(1);
    expect(tx.instagramPostMetricSnapshot.create).not.toHaveBeenCalled();
  });
  it('does not reassign a post already associated with another profile', async () => {
    const { tx, client } = fixture();
    tx.instagramPost.findUnique.mockResolvedValue({ instagramProfileId: 'different-author' });
    await expect(savePostCollection(collection(), client)).rejects.toThrow('outro perfil');
    expect(tx.instagramPost.upsert).not.toHaveBeenCalled();
  });
  it('deduplicates a post within the collection', async () => {
    const { tx, client } = fixture();
    const input = collection();
    input.posts.push({ ...input.posts[0]! });
    await savePostCollection(input, client);
    expect(tx.instagramPost.upsert).toHaveBeenCalledTimes(1);
    expect(tx.instagramPostMetricSnapshot.create).toHaveBeenCalledTimes(1);
  });
  it('rejects duplicate ids with conflicting authors', async () => {
    const { tx, client } = fixture();
    const input = collection();
    tx.instagramProfile.findMany.mockResolvedValue([
      { id: 'internal-author', instagramId: 'external-author' },
      { id: 'internal-other', instagramId: 'other' },
    ]);
    input.posts.push({ ...input.posts[0]!, ownerInstagramId: 'other' });
    await expect(savePostCollection(input, client)).rejects.toThrow('autores diferentes');
  });
  it('does not open a transaction for empty results', async () => {
    const { transaction, client } = fixture();
    await savePostCollection({ collectedAt: new Date(), posts: [] }, client);
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each(['P2002', 'P2034'])('retries %s safely', async (code) => {
    const { transaction, client } = fixture();
    transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', { code, clientVersion: '6' }),
    );
    await savePostCollection(collection(), client);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('stops after three retryable failures', async () => {
    const { transaction, client } = fixture();
    transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6' }),
    );
    await expect(savePostCollection(collection(), client)).rejects.toThrow('conflict');
    expect(transaction).toHaveBeenCalledTimes(3);
  });
  it('does not hide a failed snapshot write', async () => {
    const { tx, client } = fixture();
    tx.instagramPostMetricSnapshot.create.mockRejectedValue(new Error('snapshot failure'));
    await expect(savePostCollection(collection(), client)).rejects.toThrow('snapshot failure');
  });
});
