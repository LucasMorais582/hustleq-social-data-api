import { getPrismaClient } from '../../../provider/database/prisma.client.js';

// Uma única consulta agrega o mesmo conjunto de execuções para todo o relatório.
// Inclui running/failed: uma execução malsucedida também pode gerar cobrança.
export function readInstagramCostGroups(from: Date, to: Date, client = getPrismaClient()) {
  return client.providerRun.groupBy({
    by: ['userId', 'trigger'],
    where: { startedAt: { gte: from, lt: to } },
    _sum: { costUsd: true },
    _count: { _all: true, costUsd: true },
    orderBy: [{ userId: 'asc' }, { trigger: 'asc' }],
  });
}
