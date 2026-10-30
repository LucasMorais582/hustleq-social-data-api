import { describe, expect, it } from 'vitest';
import {
  normalizeHashtags,
  normalizeMediaType,
} from '../src/modules/instagram/shared/instagram.normalize.js';

describe('Instagram normalization', () => {
  it('removes number-only hashtags from addresses and preserves tags with Unicode letters', () => {
    expect(
      normalizeHashtags([
        '4',
        '#4',
        '#123',
        'rj2026',
        '#SãoPaulo',
        '#東京',
        '  #guaratiba ',
        'guaratiba',
        '___',
        '',
      ]),
    ).toEqual(['rj2026', 'SãoPaulo', '東京', 'guaratiba']);
  });
  it.each([
    ['Image', 'photo'],
    ['photo', 'photo'],
    ['Sidecar', 'carousel'],
    ['carousel', 'carousel'],
    ['Video', 'reel'],
    ['video', 'reel'],
    ['reel', 'reel'],
  ])('normalizes %s to %s', (input, output) => {
    expect(normalizeMediaType(input)).toBe(output);
  });
  it('does not silently classify unknown media', () => {
    expect(() => normalizeMediaType('unknown')).toThrow();
  });
  it('supports missing hashtags', () => {
    expect(normalizeHashtags(null)).toEqual([]);
  });
});
