import { describe, expect, it } from 'vitest';
import profileSample from './fixtures/instagram/profile-sample.json' with { type: 'json' };
import carouselSample from './fixtures/instagram/post-carousel-sample.json' with { type: 'json' };
import reelSample from './fixtures/instagram/reel-documentation-sample.json' with { type: 'json' };
import {
  normalizeInstagramPost,
  toMvpPostData,
} from '../src/modules/instagram/shared/instagram.post.normalize.js';
import { instagramProviderProfileSchema } from '../src/modules/instagram/profile/instagram.profile.schemas.js';
import {
  normalizeHashtags,
  normalizeMediaType,
  normalizeProfileName,
} from '../src/modules/instagram/shared/instagram.normalize.js';

describe('MVP provider normalization with documented fixture provenance', () => {
  it('normalizes a profile sample without converting identifiers to numbers', () => {
    const profile = instagramProviderProfileSchema.parse(profileSample);
    expect(profile.id).toBe('90071992547409931234');
    expect(profile.username).toBe('example_profile');
    expect(normalizeProfileName(profile.fullName)).toBeNull();
    expect(profile.biography).toBe(profileSample.biography);
    const photo = normalizeInstagramPost(profile.latestPosts[0], 'profile');
    expect(photo.images).toEqual(['https://example.com/photo.jpg']);
    expect(toMvpPostData(photo).type).toBe('IMAGE');
  });
  it('preserves all available carousel images in order and builds the permalink', () => {
    const post = normalizeInstagramPost(carouselSample, 'post');
    expect(toMvpPostData(post)).toMatchObject({
      type: 'CAROUSEL',
      url: 'https://www.instagram.com/p/Fixture_AbC123/',
      images: ['https://example.com/first.jpg', 'https://example.com/second.jpg'],
      hashtags: ['sãopaulo', 'rj'],
      likesCount: 0,
      likesHidden: false,
      commentsCount: null,
      viewsCount: null,
    });
    expect(post.caption).toBe(carouselSample.caption);
  });
  it('handles hidden likes and views using the official Reel output example', () => {
    const post = toMvpPostData(normalizeInstagramPost(reelSample, 'reel'));
    expect(post).toMatchObject({
      type: 'REEL',
      likesCount: null,
      likesHidden: true,
      viewsCount: 809683,
    });
    expect(JSON.parse(JSON.stringify(post)).instagramPostId).toBe(reelSample.id);
  });
  it.each(['profile', 'post'] as const)('does not trust views from %s even for Reels', (source) => {
    expect(normalizeInstagramPost(reelSample, source).viewsCount).toBeNull();
  });
  it.each([
    { videoPlayCount: 0, videoViewCount: 100, expected: 0 },
    { videoPlayCount: null, videoViewCount: 100, expected: 100 },
    { videoPlayCount: undefined, videoViewCount: undefined, expected: null },
    { videoPlayCount: 3000000000, videoViewCount: null, expected: 3000000000 },
    {
      videoPlayCount: Number.MAX_SAFE_INTEGER,
      videoViewCount: null,
      expected: Number.MAX_SAFE_INTEGER,
    },
  ])('preserves known/unknown Reel views %j', ({ expected, ...patch }) => {
    expect(normalizeInstagramPost({ ...reelSample, ...patch }, 'reel').viewsCount).toBe(expected);
  });
  it.each([0, null, undefined])('does not infer hidden likes from %s', (likesCount) => {
    expect(normalizeInstagramPost({ ...reelSample, likesCount }, 'reel')).toMatchObject({
      likesCount: likesCount ?? null,
      likesHidden: false,
    });
  });
  it.each([
    { likesCount: -2 },
    { likesCount: 1.5 },
    { commentsCount: -1 },
    { videoPlayCount: Number.MAX_SAFE_INTEGER + 1 },
    { videoPlayCount: 1.5 },
    { id: 9007199254740992 },
    { ownerId: 123 },
    { ownerUsername: 'bad/name' },
    { timestamp: 'yesterday' },
  ])('rejects invalid or imprecise provider data %j', (patch) => {
    expect(() => normalizeInstagramPost({ ...reelSample, ...patch }, 'reel')).toThrow();
  });
  it('keeps missing date and URL unknown instead of inventing them', () => {
    expect(normalizeInstagramPost({ type: 'Image' }, 'post')).toMatchObject({
      url: null,
      timestamp: null,
      likesCount: null,
      commentsCount: null,
      images: [],
    });
  });
  it('uses clips metadata when the provider does not include type', () => {
    expect(normalizeMediaType(undefined, 'clips')).toBe('reel');
  });
  it('rejects non-Reel records coming from the Reel Scraper', () => {
    expect(() => normalizeInstagramPost({ type: 'Image' }, 'reel')).toThrow();
  });
  it('uses a provided image list before carousel fallback and preserves repeated frames', () => {
    const images = ['https://example.com/a.jpg', 'https://example.com/a.jpg'];
    expect(normalizeInstagramPost({ ...carouselSample, images }, 'post').images).toEqual(images);
  });
  it('does not call a carousel cover a complete image list', () => {
    expect(normalizeInstagramPost({ ...carouselSample, childPosts: [] }, 'post').images).toEqual(
      [],
    );
  });
  it('deduplicates hashtags after case normalization and preserves Unicode letters', () => {
    expect(normalizeHashtags(['#RJ', 'rj', '4', '#東京', '東京', '#SãoPaulo', 'sãopaulo'])).toEqual(
      ['rj', '東京', 'sãopaulo'],
    );
  });
});
