import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../../provider/database/prisma.client.js';
import { ProviderError, providerFailure } from '../../../errors/provider.error.js';
import {
  createTrackedRunGateway,
  executeTrackedActor,
  type TrackedRunGateway,
} from '../../../provider/apify/apify.tracked-run.js';
import { parseInstagramProfileResult } from './instagram.profile.service.js';

type LookupContext = { trigger: 'initial' | 'search'; userId: string | null };

// Consulta/normalizacao compartilhada. Nao cadastra perfil, reserva, posts ou snapshots.
export async function lookupTrackedInstagramProfile(
  username: string,
  context: LookupContext,
  client: PrismaClient = getPrismaClient(),
  gateway?: TrackedRunGateway,
) {
  let providerRunId: string | undefined;
  const deadline = context.trigger === 'search' ? Date.now() + 25000 : null;
  const checkBudget = async () => {
    if (deadline !== null && Date.now() >= deadline)
      throw providerFailure('Tempo limite ao pesquisar o perfil na Apify');
  };
  const items = await executeTrackedActor(
    'apify/instagram-profile-scraper',
    { usernames: [username] },
    {
      prepare: async () => {
        const run = await client.providerRun.create({
          data: {
            actor: 'apify/instagram-profile-scraper',
            trigger: context.trigger,
            status: 'running',
            userId: context.userId,
          },
        });
        providerRunId = run.id;
        return { run, fresh: true };
      },
      update: (id, data) => client.providerRun.update({ where: { id }, data }),
    },
    checkBudget,
    gateway ??
      createTrackedRunGateway(
        context.trigger === 'search'
          ? { timeout: 20, waitForFinish: 2, timeoutSecs: 5 }
          : { timeout: 60 },
      ),
  );
  await checkBudget();
  if (items.length > 1)
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'A Apify retornou perfis inesperados',
    );
  const profile = parseInstagramProfileResult(items[0]);
  if (profile.username !== username) {
    throw new ProviderError(
      503,
      'PROVIDER_INVALID_RESPONSE',
      'O perfil retornado não corresponde ao username solicitado',
    );
  }
  if (!providerRunId) throw new Error('VERIFIED_PROFILE_RUN_NOT_FOUND');
  return { profile, providerRunId };
}
