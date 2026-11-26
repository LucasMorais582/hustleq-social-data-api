import type { Prisma } from '@prisma/client';
import {
  getInstagramLocalDate,
  INSTAGRAM_REFRESH_TIME_ZONE,
} from '../refresh/instagram.refresh.schedule.js';

const calendar = new Intl.DateTimeFormat('en-US', {
  timeZone: INSTAGRAM_REFRESH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function midnight(date: string) {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(target) ||
    new Date(target).toISOString().slice(0, 10) !== date
  )
    throw new Error('INVALID_CALENDAR_DATE');
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Map(
      calendar.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
    );
    const local = Date.UTC(
      Number(parts.get('year')),
      Number(parts.get('month')) - 1,
      Number(parts.get('day')),
      Number(parts.get('hour')),
      Number(parts.get('minute')),
      Number(parts.get('second')),
    );
    const difference = target - local;
    if (!difference) return new Date(instant);
    instant += difference;
  }
  throw new Error('CALENDAR_BOUNDARY_UNAVAILABLE');
}
export function newYorkDayBounds(date: string) {
  const from = midnight(date);
  const next = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
  return { from, to: midnight(next) };
}
export async function hasProfileSnapshotOnDate(
  profileId: string,
  date: string,
  client: Pick<Prisma.TransactionClient, 'instagramProfileSnapshot'>,
) {
  const { from, to } = newYorkDayBounds(date);
  return Boolean(
    await client.instagramProfileSnapshot.findFirst({
      where: { instagramProfileId: profileId, collectedAt: { gte: from, lt: to } },
      select: { id: true },
    }),
  );
}
export { getInstagramLocalDate };
