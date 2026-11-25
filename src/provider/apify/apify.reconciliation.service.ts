import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../database/prisma.client.js';
import {
  createTrackedRunGateway,
  providerRunCost,
  type TrackedRunGateway,
} from './apify.tracked-run.js';
import { providerFailure, isProviderRateLimit } from '../../errors/provider.error.js';

const terminal = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
// Apenas consulta execuções conhecidas: nunca inicia/reinicia Actors nem tenta adivinhar IDs.
export async function reconcileProviderRuns(
  limit = 100,
  client: PrismaClient = getPrismaClient(),
  transport?: Pick<TrackedRunGateway, 'get'>,
  after?: string,
) {
  if (after !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(after))
    throw new Error('INVALID_CURSOR');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('INVALID_LIMIT');
  const anchor = after
    ? await client.providerRun.findUnique({
        where: { id: after },
        select: { id: true, startedAt: true },
      })
    : null;
  if (after && !anchor) throw new Error('INVALID_CURSOR');
  const rows = await client.providerRun.findMany({
    where: {
      apifyRunId: { not: null },
      OR: [{ status: 'running' }, { costUsd: null }, { costUsd: 0 }],
      ...(anchor
        ? {
            AND: [
              {
                OR: [
                  { startedAt: { gt: anchor.startedAt } },
                  { startedAt: anchor.startedAt, id: { gt: anchor.id } },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  const summary = {
    nextCursor: rows.length === limit ? rows.at(-1)!.id : null,
    inspected: rows.length,
    updated: 0,
    pending: 0,
    conflicts: 0,
    failed: 0,
    unknownCost: 0,
    unresolvedStarts: await client.providerRun.count({
      where: { apifyRunId: null, error: 'PROVIDER_START_UNCERTAIN' },
    }),
  };
  if (!rows.length) return summary;
  const gateway = transport ?? createTrackedRunGateway({ waitForFinish: 0, timeoutSecs: 10 });
  for (const row of rows) {
    try {
      const run = await gateway.get(row.apifyRunId!);
      if (!run || run.id !== row.apifyRunId) {
        summary.failed++;
        continue;
      }
      if (!terminal.has(run.status)) {
        summary.pending++;
        continue;
      }
      const cost = providerRunCost(run.usageTotalUsd);
      if (cost === null && row.costUsd === null) summary.unknownCost++;
      const failure =
        run.status !== 'SUCCEEDED' ||
        Boolean(run.statusMessage && isProviderRateLimit(run.statusMessage))
          ? providerFailure(run.statusMessage ?? `Execução terminou com ${run.status}`)
          : null;
      // SUCCEEDED não invalida uma falha semântica já detectada no dataset (ex.: notice).
      const semanticFailure = run.status === 'SUCCEEDED' && row.status === 'failed';
      const finishedAt = run.finishedAt ?? row.finishedAt;
      if (finishedAt && !Number.isFinite(finishedAt.getTime())) {
        summary.failed++;
        continue;
      }
      const saved = await client.providerRun.updateMany({
        where: {
          id: row.id,
          apifyRunId: row.apifyRunId,
          status: row.status,
          costUsd: row.costUsd,
          error: row.error,
          finishedAt: row.finishedAt,
          items: row.items,
        },
        data: {
          status: failure || semanticFailure ? 'failed' : 'succeeded',
          error: failure?.code ?? (row.error === 'PROVIDER_START_UNCERTAIN' ? null : row.error),
          ...(cost === null ? {} : { costUsd: cost }),
          ...(finishedAt ? { finishedAt } : {}),
        },
      });
      if (saved.count) summary.updated++;
      else summary.conflicts++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
