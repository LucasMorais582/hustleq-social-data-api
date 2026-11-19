import { describe, expect, it } from 'vitest';
import { instagramPersistablePostSchema } from '../src/modules/instagram/post/instagram.post.schemas.js';

const valid = { id: 'post-1', ownerId: 'author-1', ownerUsername: 'example', type: 'Image' };

describe('post persistence input', () => {
  it.each([
    { id: null },
    { id: '' },
    { ownerId: null },
    { ownerId: ' ' },
    { ownerUsername: '' },
    { likesCount: -1 },
    { likesCount: 1.5 },
    { likesCount: 2147483648 },
    { commentsCount: -1 },
    { commentsCount: 2147483648 },
    { videoPlayCount: 1.5 },
    { videoPlayCount: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects data that cannot be persisted reliably: %j', async (patch) => {
    expect(instagramPersistablePostSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it('preserves unknown counts as null and accepts views above INTEGER', () => {
    expect(
      instagramPersistablePostSchema.parse({
        ...valid,
        likesCount: null,
        videoPlayCount: 3000000000,
      }),
    ).toMatchObject({ likesCount: null, videoPlayCount: 3000000000 });
  });
  it('keeps alphanumeric external identifiers as strings', () => {
    expect(instagramPersistablePostSchema.parse(valid).ownerId).toBe('author-1');
  });
});
