import { describe, expect, it } from 'vitest';
import { normalizeDiscoverPosts } from '../src/modules/instagram/discover/instagram.discover.normalize.js';
const now = new Date('2026-11-23T12:00:00Z');
const target = {
  niche: 'food',
  city: 'newark',
  query: null,
  key: '["food","newark",null]',
  keyword: 'food newark',
};
const post = {
  recordType: 'post',
  postId: '90071992547409939999',
  keyword: target.keyword,
  shortcode: 'ABC',
  type: 'reel',
  caption: '70 Adams St #4',
  hashtags: ['4', '#RJ', 'rj', 'SãoPaulo'],
  takenAt: now.toISOString(),
  ownerUsername: '@EXAMPLE',
  ownerFullName: 'Example',
  likeCount: -1,
  commentCount: 0,
  playCount: 123,
  locationName: null,
};
describe('Discover normalization', () => {
  it('normalizes IDs, hidden likes, hashtags, types, author and missing fields', () => {
    expect(normalizeDiscoverPosts([post], target, now)).toEqual([
      {
        instagramPostId: post.postId,
        url: 'https://www.instagram.com/p/ABC/',
        type: 'REEL',
        caption: post.caption,
        hashtags: ['rj', 'sãopaulo'],
        displayUrl: null,
        timestamp: now.toISOString(),
        ownerUsername: 'example',
        ownerFullName: 'Example',
        likesCount: null,
        likesHidden: true,
        commentsCount: 0,
        viewsCount: 123,
      },
    ]);
  });
  it('keeps low-like posts without location, unlike legacy trends', () => {
    expect(normalizeDiscoverPosts([{ ...post, likeCount: 0 }], target, now)[0]!.likesCount).toBe(0);
  });
  it.each([
    ['photo', 'IMAGE'],
    ['carousel', 'CAROUSEL'],
    ['video', 'REEL'],
  ] as const)('maps %s to %s and keeps views only for Reels', (type, expected) => {
    const result = normalizeDiscoverPosts([{ ...post, type }], target, now)[0]!;
    expect(result.type).toBe(expected);
    expect(result.viewsCount).toBe(expected === 'REEL' ? 123 : null);
  });
  it('preserves unknown metrics and blank names as null', () => {
    expect(
      normalizeDiscoverPosts(
        [
          {
            ...post,
            ownerFullName: '',
            ownerUsername: undefined,
            likeCount: null,
            commentCount: null,
            playCount: undefined,
          },
        ],
        target,
        now,
      )[0],
    ).toMatchObject({
      ownerFullName: null,
      ownerUsername: null,
      likesCount: null,
      commentsCount: null,
      viewsCount: null,
      likesHidden: false,
    });
  });
  it('filters missing, future and older-than-30-day timestamps, retaining the exact boundary', () => {
    const cutoff = new Date(now.getTime() - 30 * 86400000);
    const rows = [
      undefined,
      new Date(now.getTime() + 1).toISOString(),
      new Date(cutoff.getTime() - 1).toISOString(),
      cutoff.toISOString(),
    ].map((takenAt, i) => ({ ...post, postId: String(i), takenAt }));
    expect(normalizeDiscoverPosts(rows, target, now).map((row) => row.instagramPostId)).toEqual([
      '3',
    ]);
  });
  it('deduplicates, sorts newest first and caps at fifty', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      ...post,
      postId: String(i),
      takenAt: new Date(now.getTime() - i * 1000).toISOString(),
    }));
    const result = normalizeDiscoverPosts([...rows.reverse(), rows[0]], target, now);
    expect(result).toHaveLength(50);
    expect(result[0]!.instagramPostId).toBe('0');
    expect(result[49]!.instagramPostId).toBe('49');
  });
  it('accepts a genuine empty result', () => {
    expect(normalizeDiscoverPosts([], target, now)).toEqual([]);
  });
  it.each([
    { ...post, postId: 123 },
    { ...post, postId: '   ' },
    { ...post, shortcode: '../wrong' },
    { ...post, keyword: 'another query' },
    { ...post, type: 'story' },
    { ...post, takenAt: 'bad-date' },
    { ...post, commentCount: -1 },
    { ...post, playCount: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid provider output', (raw) => {
    expect(() => normalizeDiscoverPosts([raw], target, now)).toThrow();
  });
});
