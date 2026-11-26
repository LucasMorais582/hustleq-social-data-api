import { describe, expect, it, vi } from 'vitest';
import {
  newYorkDayBounds,
  hasProfileSnapshotOnDate,
} from '../src/modules/instagram/shared/instagram.snapshot-day.js';

describe('New York snapshot dates', () => {
  it.each([
    ['2026-11-26', '2026-11-26T05:00:00.000Z', '2026-11-27T05:00:00.000Z'],
    ['2026-07-01', '2026-07-01T04:00:00.000Z', '2026-07-02T04:00:00.000Z'],
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['2026-12-31', '2026-12-31T05:00:00.000Z', '2027-01-01T05:00:00.000Z'],
  ])('uses the actual UTC boundaries for %s including 23/25h days', (day, from, to) => {
    const bounds = newYorkDayBounds(day);
    expect(bounds.from.toISOString()).toBe(from);
    expect(bounds.to.toISOString()).toBe(to);
  });
  it.each(['2026-02-30', 'invalid', '2026-13-01', '2026-1-01', ''])(
    'rejects invalid calendar date %s',
    (date) => {
      expect(() => newYorkDayBounds(date)).toThrow('INVALID_CALENDAR_DATE');
    },
  );
  it('checks any snapshot in the half-open local day, independent of its source', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'snapshot' });
    expect(
      await hasProfileSnapshotOnDate('profile', '2026-11-26', {
        instagramProfileSnapshot: { findFirst },
      } as never),
    ).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        instagramProfileId: 'profile',
        collectedAt: {
          gte: new Date('2026-11-26T05:00:00Z'),
          lt: new Date('2026-11-27T05:00:00Z'),
        },
      },
      select: { id: true },
    });
  });
});
