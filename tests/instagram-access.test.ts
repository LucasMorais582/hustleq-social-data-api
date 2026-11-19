import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { assertPostReadAccess, assertProfileReadAccess } from '../src/auth/instagram-access.js';

function fixture() {
  const profile = vi.fn().mockResolvedValue({ ownerUserId: null, monitoredBy: [] });
  const post = vi.fn().mockResolvedValue({ instagramProfileId: 'profile' });
  const client = {
    instagramProfile: { findUnique: profile },
    instagramPost: { findUnique: post },
  } as unknown as PrismaClient;
  return { profile, post, client };
}
describe('MVP stored profile and post read scope', () => {
  it('allows the owner of the saved profile', async () => {
    const { profile, client } = fixture();
    profile.mockResolvedValue({ ownerUserId: 'user', monitoredBy: [] });
    expect(await assertProfileReadAccess('profile', 'user', client)).toBe('OWNER');
  });
  it('allows an actively watched account through a profile owned by the user', async () => {
    const { profile, client } = fixture();
    profile.mockResolvedValue({ ownerUserId: 'someone-else', monitoredBy: [{ id: 'relation' }] });
    expect(await assertProfileReadAccess('profile', 'user', client)).toBe('COMPETITOR');
    expect(profile).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'profile' },
        select: expect.objectContaining({
          monitoredBy: {
            where: { endedAt: null, instagramProfile: { ownerUserId: 'user' } },
            take: 1,
            select: { id: true },
          },
        }),
      }),
    );
  });
  it.each([null, 'another-user'])('denies unrelated profiles owned by %s', async (ownerUserId) => {
    const { profile, client } = fixture();
    profile.mockResolvedValue({ ownerUserId, monitoredBy: [] });
    await expect(assertProfileReadAccess('profile', 'user', client)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });
  it('returns 404 for absent profiles', async () => {
    const { profile, client } = fixture();
    profile.mockResolvedValue(null);
    await expect(assertProfileReadAccess('missing', 'user', client)).rejects.toMatchObject({
      statusCode: 404,
      code: 'PROFILE_NOT_FOUND',
    });
  });
  it('authorizes a post through its stored profile, without trusting external ownerUsername', async () => {
    const { profile, post, client } = fixture();
    profile.mockResolvedValue({ ownerUserId: 'user', monitoredBy: [] });
    expect(await assertPostReadAccess('post', 'user', client)).toBe('OWNER');
    expect(post).toHaveBeenCalledWith({
      where: { id: 'post' },
      select: { instagramProfileId: true },
    });
  });
  it('denies a saved post of an unrelated profile', async () => {
    const { client } = fixture();
    await expect(assertPostReadAccess('post', 'user', client)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it('returns post-specific 404 without reading a profile', async () => {
    const { post, profile, client } = fixture();
    post.mockResolvedValue(null);
    await expect(assertPostReadAccess('missing', 'user', client)).rejects.toMatchObject({
      statusCode: 404,
      code: 'POST_NOT_FOUND',
    });
    expect(profile).not.toHaveBeenCalled();
  });
});
