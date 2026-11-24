import { PersistenceError } from '../../errors/persistence.error.js';
import type { ApifyClient } from 'apify-client';
import {
  ProviderError,
  providerFailure,
  isProviderRateLimit,
} from '../../errors/provider.error.js';
import { apifyCallerUserId } from './apify.execution-context.js';
import { beginProviderExecution, updateProviderExecution } from './apify.execution.repository.js';
import { providerRunCost } from './apify.tracked-run.js';
import { createApifyClient } from './config/apify.client.js';

async function readActorResults(
  client: ApifyClient,
  actor: string,
  input: Record<string, unknown>,
  limit?: number,
  execution?: { timeout: number; waitSecs: number },
) {
  const userId = apifyCallerUserId();
  // Falha no ledger antes do POST impede uma chamada paga sem rastreabilidade.
  const ledger = userId === undefined ? null : await beginProviderExecution(actor, userId);
  let observed = false;
  try {
    const actorClient = client.actor(actor);
    const run = execution
      ? await actorClient.call(input, execution)
      : await actorClient.call(input);
    observed = true;
    if (ledger) {
      const cost = providerRunCost(run.usageTotalUsd);
      await updateProviderExecution(ledger.id, {
        ...(run.id ? { apifyRunId: run.id } : {}),
        status:
          run.status === 'SUCCEEDED'
            ? 'succeeded'
            : ['FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)
              ? 'failed'
              : 'running',
        ...(cost === null ? {} : { costUsd: cost }),
        ...(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)
          ? { finishedAt: run.finishedAt ?? new Date() }
          : {}),
      });
    }
    if (run.status !== 'SUCCEEDED') {
      throw providerFailure(
        run.statusMessage || `A execução da Apify terminou com status ${run.status}`,
      );
    }
    if (run.statusMessage && isProviderRateLimit(run.statusMessage)) {
      throw providerFailure(run.statusMessage);
    }
    if (!run.defaultDatasetId) {
      throw new ProviderError(
        503,
        'PROVIDER_INVALID_RESPONSE',
        'A Apify não retornou o dataset da execução',
      );
    }
    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems(limit === undefined ? {} : { limit });
    if (ledger) {
      const notices = items.filter((item) => item.recordType === 'notice');
      const messages = notices.map((notice) =>
        ['message', 'errorDescription', 'description', 'reason', 'error', 'notice', 'statusMessage']
          .map((field) => notice[field])
          .filter((field) => typeof field === 'string')
          .join(' — '),
      );
      const limited = messages.find(isProviderRateLimit);
      if (limited || (notices.length > 0 && notices.length === items.length)) {
        const failure = providerFailure(
          limited ?? (messages.join(' | ') || 'A Apify retornou apenas avisos'),
        );
        await updateProviderExecution(ledger.id, {
          status: 'failed',
          error: failure.code,
          items: items.length,
        });
        throw failure;
      }
      await updateProviderExecution(ledger.id, { items: items.length, error: null });
    }
    return items;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    const statusCode =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined;
    const failure =
      error instanceof ProviderError
        ? error
        : providerFailure(
            error instanceof Error ? error.message : 'Falha ao consultar a Apify',
            statusCode,
          );
    if (ledger) {
      const refused =
        !observed &&
        statusCode !== undefined &&
        statusCode >= 400 &&
        statusCode < 500 &&
        statusCode !== 408;
      // Sem ID confirmado, um timeout não prova que o Actor não iniciou/cobrou.
      await updateProviderExecution(ledger.id, {
        error: !observed && !refused ? 'PROVIDER_START_UNCERTAIN' : failure.code,
        ...(refused ? { status: 'failed', finishedAt: new Date() } : {}),
        ...(observed && failure.code === 'PROVIDER_RATE_LIMITED' ? { status: 'failed' } : {}),
      });
    }
    throw failure;
  }
}

//Consumo da api de Profile do Apify
export async function fetchInstagramProfile(
  username: string,
  execution?: { timeout: number; waitSecs: number },
) {
  const client = createApifyClient({ maxRetries: 0 });

  const items = await readActorResults(
    client,
    'apify/instagram-profile-scraper',
    {
      usernames: [username],
    },
    undefined,
    execution,
  );

  const rawItem = items[0];

  return rawItem;
}

//Consumo da api de Post do Apify
export async function fetchInstagramPost(username: string, resultLimits: number) {
  if (!Number.isInteger(resultLimits) || resultLimits < 1 || resultLimits > 50) {
    throw new Error('O limite de publicações deve ser um inteiro entre 1 e 50');
  }

  const client = createApifyClient({ maxRetries: 0 });

  const items = await readActorResults(
    client,
    'apify/instagram-post-scraper',
    {
      username: [username],
      resultsLimit: resultLimits,
    },
    resultLimits,
  );

  return items.slice(0, resultLimits);
}

interface TrendsProviderInput {
  keywords: string[];
  searchLimit: number;
  daysBack: number;
  minLikes: number;
  postType: 'all' | 'reel' | 'photo' | 'carousel' | 'video';
}

export async function fetchInstagramTrends(input: TrendsProviderInput) {
  const { keywords, searchLimit, daysBack, minLikes, postType } = input;
  if (!Number.isInteger(searchLimit) || searchLimit < 1 || searchLimit > 250) {
    throw new Error('O limite de coleta deve ser um inteiro entre 1 e 250');
  }
  if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 30) {
    throw new Error('O período deve ser um inteiro entre 1 e 30 dias');
  }

  const client = createApifyClient({ maxRetries: 0 });
  return readActorResults(client, 'seemuapps/instagram-keyword-posts-scraper', {
    keywords,
    maxPostsPerKeyword: searchLimit,
    postType,
    minLikes,
    dateFrom: `${daysBack} days`,
  });
}
