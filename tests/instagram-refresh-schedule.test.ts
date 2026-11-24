import { describe, expect, it } from 'vitest';
import { getInstagramRefreshDate } from '../src/modules/instagram/refresh/instagram.refresh.schedule.js';

describe('daily Instagram refresh schedule in New York', () => {
  it.each([
    ['2026-01-15T09:00:00.000Z', '2026-01-15'],
    ['2026-07-15T08:00:00.000Z', '2026-07-15'],
    ['2026-03-07T09:00:00.000Z', '2026-03-07'],
    ['2026-03-08T08:00:00.000Z', '2026-03-08'],
    ['2026-10-31T08:00:00.000Z', '2026-10-31'],
    ['2026-11-01T09:00:00.000Z', '2026-11-01'],
    ['2026-12-31T09:59:59.999Z', '2026-12-31'],
  ])('allows %s as local collection date %s', (instant, expected) => {
    expect(getInstagramRefreshDate(new Date(instant))).toBe(expected);
  });

  it.each([
    '2026-01-15T08:00:00.000Z',
    '2026-07-15T09:00:00.000Z',
    '2026-01-15T08:59:59.999Z',
    '2026-01-15T10:00:00.000Z',
    '2026-07-15T07:59:59.999Z',
    '2026-07-15T09:00:00.001Z',
    '2026-01-01T00:00:00.000Z',
  ])('ignores %s outside the New York 4am window', (instant) => {
    expect(getInstagramRefreshDate(new Date(instant))).toBeNull();
  });

  it('rejects invalid dates', () => {
    expect(() => getInstagramRefreshDate(new Date('invalid'))).toThrow('Data inválida');
  });
});
