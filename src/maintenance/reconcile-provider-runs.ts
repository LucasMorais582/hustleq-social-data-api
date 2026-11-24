import { pathToFileURL } from 'node:url';
import { reconcileProviderRuns } from '../provider/apify/apify.reconciliation.service.js';
import { getPrismaClient } from '../provider/database/prisma.client.js';

export function reconciliationOptions(args: string[]) {
  let limit = 100;
  let after: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!value || seen.has(key)) throw new Error('Argumentos inválidos');
    seen.add(key);
    if (key === '--limit' && /^[1-9]\d*$/.test(value) && Number(value) <= 500)
      limit = Number(value);
    else if (key === '--after' && /^[A-Za-z0-9_-]{1,200}$/.test(value)) after = value;
    else throw new Error('Use --limit 1..500 e --after ID (opcional)');
  }
  return { limit, after };
}
export function reconciliationLimit(args: string[]) {
  return reconciliationOptions(args).limit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = getPrismaClient();
  try {
    const options = reconciliationOptions(process.argv.slice(2));
    const result = await reconcileProviderRuns(options.limit, client, undefined, options.after);
    console.info(JSON.stringify(result));
    if (result.failed > 0) process.exitCode = 1;
  } catch {
    console.error(
      'Não foi possível conciliar as execuções. Confira argumentos, banco e APIFY_API_TOKEN.',
    );
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}
