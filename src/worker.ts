import { setTimeout } from 'node:timers/promises';
import { env } from './config/env.js';
import { runPostRefreshWorkerOnce } from './modules/instagram/jobs/instagram.post-refresh.service.js';
import { runDiscoverWorkerOnce } from './modules/instagram/jobs/instagram.discover.service.js';
import { getPrismaClient } from './provider/database/prisma.client.js';
import {
  initialSyncErrorCode,
  runInitialSyncWorkerOnce,
} from './modules/instagram/jobs/instagram.initial-sync.service.js';

async function main() {
  if (!env.INSTAGRAM_WORKER_ENABLED) {
    console.info(
      'Instagram worker desabilitado. Configure INSTAGRAM_WORKER_ENABLED=true para iniciar.',
    );
    return;
  }
  const client = getPrismaClient();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!shutdown.signal.aborted) {
      let processed = false;
      try {
        const result = await runInitialSyncWorkerOnce(client);
        processed = result !== null;
        if (result) console.info(JSON.stringify({ event: 'initial_sync', ...result }));
        if (!shutdown.signal.aborted) {
          const postResult = await runPostRefreshWorkerOnce(client);
          processed = processed || postResult !== null;
          if (postResult) console.info(JSON.stringify({ event: 'post_refresh', ...postResult }));
        }
        if (!shutdown.signal.aborted) {
          const discoverResult = await runDiscoverWorkerOnce(client);
          processed = processed || discoverResult !== null;
          if (discoverResult)
            console.info(JSON.stringify({ event: 'discover_search', ...discoverResult }));
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'instagram_worker_error',
            code: initialSyncErrorCode(error, 'INSTAGRAM_SYNC_FAILED'),
          }),
        );
      }
      if (!processed && !shutdown.signal.aborted) {
        await setTimeout(env.INSTAGRAM_WORKER_POLL_MS, undefined, {
          signal: shutdown.signal,
        }).catch((error: unknown) => {
          if (!shutdown.signal.aborted) throw error;
        });
      }
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await client.$disconnect();
  }
}
await main().catch(() => {
  console.error('Não foi possível iniciar o worker');
  process.exitCode = 1;
});
