import type { ApifyClient } from 'apify-client';
import {
  ProviderError,
  providerFailure,
  isProviderRateLimit,
} from '../../errors/provider.error.js';
import { createApifyClient } from './config/apify.client.js';

async function readActorResults(
  client: ApifyClient,
  actor: string,
  input: Record<string, unknown>,
  limit?: number,
  execution?: { timeout: number; waitSecs: number },
) {
  try {
    const actorClient = client.actor(actor);
    const run = execution
      ? await actorClient.call(input, execution)
      : await actorClient.call(input);
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
    return items;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const statusCode =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined;
    throw providerFailure(
      error instanceof Error ? error.message : 'Falha ao consultar a Apify',
      statusCode,
    );
  }
}

//Consumo da api de Profile do Apify
export async function fetchInstagramProfile(
  username: string,
  execution?: { timeout: number; waitSecs: number },
) {
  const client = createApifyClient();

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

  const client = createApifyClient();

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

  const client = createApifyClient();
  return readActorResults(client, 'seemuapps/instagram-keyword-posts-scraper', {
    keywords,
    maxPostsPerKeyword: searchLimit,
    postType,
    minLikes,
    dateFrom: `${daysBack} days`,
  });
}
