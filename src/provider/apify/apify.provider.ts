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
