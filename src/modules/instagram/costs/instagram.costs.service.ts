import { Prisma, type PrismaClient } from '@prisma/client';
import { readInstagramCostGroups } from './instagram.costs.repository.js';
import {
  instagramCostsQuerySchema,
  instagramCostsResponseSchema,
} from './instagram.costs.schemas.js';

function accumulator() {
  return { sum: new Prisma.Decimal(0), runs: 0, known: 0 };
}
type Accumulator = ReturnType<typeof accumulator>;
function add(target: Accumulator, sum: Prisma.Decimal | null, runs: number, known: number) {
  if (
    !Number.isSafeInteger(runs) ||
    !Number.isSafeInteger(known) ||
    known < 0 ||
    known > runs ||
    runs < 0
  )
    throw new Error('INVALID_PROVIDER_COST_COUNT');
  if ((known > 0 && sum === null) || (sum !== null && (!sum.isFinite() || sum.isNegative())))
    throw new Error('INVALID_PROVIDER_COST_SUM');
  target.sum = target.sum.plus(sum ?? 0);
  target.runs += runs;
  target.known += known;
}
function money(value: Accumulator) {
  if (!Number.isSafeInteger(value.runs)) throw new Error('UNSAFE_PROVIDER_RUN_COUNT');
  if (value.known !== value.runs) return null;
  // Não arredondar silenciosamente valores fora da precisão de seis casas do ledger.
  const micros = value.sum.mul(1000000);
  if (!micros.isInteger() || micros.gt(Number.MAX_SAFE_INTEGER))
    throw new Error('UNSAFE_PROVIDER_COST');
  return value.sum.toNumber();
}

export async function getInstagramCosts(month: string, client?: PrismaClient) {
  instagramCostsQuerySchema.parse({ month });
  const from = new Date(`${month}-01T00:00:00.000Z`);
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + 1);
  const groups = await readInstagramCostGroups(from, to, client);
  const total = accumulator();
  const unattributed = accumulator();
  const users = new Map<string, Accumulator>();
  const triggers = new Map<string, Accumulator>();
  for (const group of groups) {
    const apply = (target: Accumulator) =>
      add(target, group._sum.costUsd, group._count._all, group._count.costUsd);
    apply(total);
    if (group.userId === null) apply(unattributed);
    else {
      const user = users.get(group.userId) ?? accumulator();
      apply(user);
      users.set(group.userId, user);
    }
    const trigger = triggers.get(group.trigger) ?? accumulator();
    apply(trigger);
    triggers.set(group.trigger, trigger);
  }
  const sorted = (values: Map<string, Accumulator>) =>
    [...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return instagramCostsResponseSchema.parse({
    month,
    totalUsd: money(total),
    byUser: sorted(users).map(([userId, value]) => ({
      userId,
      costUsd: money(value),
      runs: value.runs,
    })),
    byTrigger: sorted(triggers).map(([trigger, value]) => ({
      trigger,
      costUsd: money(value),
      runs: value.runs,
    })),
    unattributedUsd: money(unattributed),
  });
}
