import type { Prisma } from '@prisma/client';
import { PersistenceError } from '../../errors/persistence.error.js';
import { getPrismaClient } from '../database/prisma.client.js';

export async function beginProviderExecution(actor: string, userId: string) {
  try {
    return await getPrismaClient().providerRun.create({
      data: { actor, userId, trigger: 'search', status: 'running' },
    });
  } catch {
    throw new PersistenceError();
  }
}
export async function updateProviderExecution(id: string, data: Prisma.ProviderRunUpdateInput) {
  try {
    return await getPrismaClient().providerRun.update({ where: { id }, data });
  } catch {
    throw new PersistenceError();
  }
}
