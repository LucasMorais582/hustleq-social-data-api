import { createApifyClient } from './config/apify.client.js';

//Consumo da api de Profile do Apify
export async function fetchInstagramProfile(username: string) {
  const client = createApifyClient();

  const run = await client.actor('apify/instagram-profile-scraper').call({ usernames: [username] });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  const rawItem = items[0];

  if (!rawItem) {
    throw new Error('Perfil não encontrado');
  }

  return rawItem;
}

//Consumo da api de Post do Apify
export async function fetchInstagramPost(username: string, resultLimits: number) {
  if (!Number.isInteger(resultLimits) || resultLimits < 1) {
    throw new Error('O limite de publicações deve ser um inteiro positivo');
  }

  const client = createApifyClient();

  const run = await client.actor('apify/instagram-post-scraper').call({
    username: [username],
    resultsLimit: resultLimits,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: resultLimits });

  return items.slice(0, resultLimits);
}

export async function fetchInstagramTrends(search: string, searchLimit: number, daysBack: number) {
  if (!Number.isInteger(searchLimit) || searchLimit < 1 || searchLimit > 250) {
    throw new Error('O limite de coleta deve ser um inteiro entre 1 e 250');
  }
  if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 30) {
    throw new Error('O período deve ser um inteiro entre 1 e 30 dias');
  }

  const client = createApifyClient();
  const run = await client.actor('seemuapps/instagram-keyword-posts-scraper').call({
    keywords: [search],
    maxPostsPerKeyword: searchLimit,
    postType: 'all',
    dateFrom: `${daysBack} days`,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}
