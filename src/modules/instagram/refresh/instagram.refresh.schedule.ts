export const INSTAGRAM_REFRESH_TIME_ZONE = 'America/New_York';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: INSTAGRAM_REFRESH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

// Vercel Cron usa UTC. O disparo das 10h ou 11h UTC só pode iniciar a
// coleta quando o relógio local de Nova York estiver na janela das 6h.
// A janela inteira admite os atrasos de até uma hora do plano Hobby.
export function getInstagramRefreshDate(now: Date): string | null {
  if (!Number.isFinite(now.getTime())) throw new Error('Data inválida para o agendamento');
  const parts = new Map(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  if (parts.get('hour') !== '06') return null;
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

export function getInstagramRefreshWindowStart(now: Date): Date | null {
  return getInstagramRefreshDate(now)
    ? new Date(Math.floor(now.getTime() / 3600000) * 3600000)
    : null;
}
