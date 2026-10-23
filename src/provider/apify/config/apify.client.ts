import { ApifyClient } from 'apify-client';

export function createApifyClient() {
  const token = process.env.APIFY_API_TOKEN;

  if (!token) {
    throw new Error('APIFY_API_TOKEN não configurado');
  }

  return new ApifyClient({ token });
}
