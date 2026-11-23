import { Prisma, type ProviderRun } from '@prisma/client';
import {
  ProviderError,
  providerFailure,
  isProviderRateLimit,
} from '../../errors/provider.error.js';
import { createApifyClient } from './config/apify.client.js';

export interface ApifyRunSnapshot {
  id: string;
  status: string;
  statusMessage?: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
  finishedAt?: Date | null;
}
export interface TrackedRunGateway {
  start(actor: string, input: Record<string, unknown>): Promise<ApifyRunSnapshot>;
  get(id: string): Promise<ApifyRunSnapshot | undefined>;
  items(datasetId: string): Promise<{ items: unknown[]; total: number }>;
}
export interface TrackedRunStore {
  prepare(): Promise<{ run: ProviderRun; fresh: boolean }>;
  update(id: string, data: Prisma.ProviderRunUpdateInput): Promise<unknown>;
}
export class ProviderStartUncertain extends Error {
  readonly code = 'PROVIDER_START_UNCERTAIN';
  constructor() {
    super('Não é possível confirmar o início anterior da execução');
  }
}

export function createTrackedRunGateway(): TrackedRunGateway {
  // POST de início não pode ser repetido automaticamente pelo SDK após timeout.
  const client = createApifyClient({ maxRetries: 0 });
  return {
    start: (actor, input) =>
      client.actor(actor).start(input, { timeout: 300, restartOnError: false }),
    get: (id) => client.run(id).get({ waitForFinish: 20 }),
    items: (id) => client.dataset(id).listItems({ limit: 1000 }),
  };
}
export function providerRunCost(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  const cost = new Prisma.Decimal(value).toDecimalPlaces(6);
  return cost.greaterThan('9999.999999') ? null : cost;
}
const terminal = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

export async function executeTrackedActor(
  actor: string,
  input: Record<string, unknown>,
  store: TrackedRunStore,
  heartbeat: () => Promise<void>,
  gateway: TrackedRunGateway,
) {
  await heartbeat();
  const prepared = await store.prepare();
  if (!prepared.fresh && prepared.run.status === 'failed') {
    throw providerFailure(
      'A execução desta tentativa já terminou com falha',
      prepared.run.error === 'PROVIDER_RATE_LIMITED' ? 429 : undefined,
    );
  }
  let run: ApifyRunSnapshot | undefined;
  if (prepared.run.apifyRunId) {
    run = await gateway.get(prepared.run.apifyRunId);
  } else if (!prepared.fresh) {
    // Uma queda entre o POST e a gravação do id não permite assumir que não houve cobrança.
    await store.update(prepared.run.id, { error: 'PROVIDER_START_UNCERTAIN' });
    throw new ProviderStartUncertain();
  } else {
    await heartbeat();
    try {
      run = await gateway.start(actor, input);
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
        const failure = providerFailure('A Apify recusou o início da execução', status);
        await store.update(prepared.run.id, {
          status: 'failed',
          error: failure.code,
          finishedAt: new Date(),
        });
        throw failure;
      }
      await store.update(prepared.run.id, { error: 'PROVIDER_START_UNCERTAIN' });
      throw new ProviderStartUncertain();
    }
    await store.update(prepared.run.id, { apifyRunId: run.id });
  }
  if (!run) throw providerFailure('A execução da Apify não foi encontrada');
  let polls = 0;
  while (!terminal.has(run.status)) {
    if (++polls > 30) throw providerFailure('Tempo limite ao aguardar a execução da Apify');
    await heartbeat();
    const current = await gateway.get(run.id);
    if (!current) throw providerFailure('A execução da Apify não foi encontrada');
    run = current;
  }
  const failed =
    run.status !== 'SUCCEEDED' ||
    Boolean(run.statusMessage && isProviderRateLimit(run.statusMessage));
  const failure = failed
    ? providerFailure(run.statusMessage ?? `Execução terminou com ${run.status}`)
    : null;
  const cost = providerRunCost(run.usageTotalUsd);
  await store.update(prepared.run.id, {
    status: failure ? 'failed' : 'succeeded',
    error: failure?.code ?? null,
    // Ausência em uma releitura não apaga um custo real já observado.
    ...(cost === null ? {} : { costUsd: cost }),
    finishedAt: run.finishedAt ?? prepared.run.finishedAt ?? new Date(),
  });
  if (failure) throw failure;
  if (!run.defaultDatasetId)
    throw new ProviderError(503, 'PROVIDER_INVALID_RESPONSE', 'A Apify não retornou o dataset');
  await heartbeat();
  // Falha de download preserva a execução SUCCEEDED, para reler o mesmo dataset no retry.
  const dataset = await gateway.items(run.defaultDatasetId);
  if (dataset.total > dataset.items.length)
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'Dataset excedeu o limite desta coleta',
    );
  const notices = dataset.items.filter((item): item is Record<string, unknown> =>
    Boolean(
      item && typeof item === 'object' && 'recordType' in item && item.recordType === 'notice',
    ),
  );
  const messages = notices.map((notice) =>
    ['message', 'errorDescription', 'description', 'reason', 'error', 'notice', 'statusMessage']
      .map((field) => notice[field])
      .filter((field): field is string => typeof field === 'string')
      .join(' — '),
  );
  const limited = messages.find(isProviderRateLimit);
  if (limited || (notices.length > 0 && notices.length === dataset.items.length)) {
    const error = providerFailure(
      limited ?? (messages.join(' | ') || 'A Apify retornou apenas avisos'),
    );
    await store.update(prepared.run.id, {
      status: 'failed',
      error: error.code,
      items: dataset.items.length,
    });
    throw error;
  }
  const items = dataset.items.filter((item) => !notices.includes(item as Record<string, unknown>));
  await store.update(prepared.run.id, { items: items.length });
  return items;
}
