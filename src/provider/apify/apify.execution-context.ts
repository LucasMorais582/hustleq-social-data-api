import { AsyncLocalStorage } from 'node:async_hooks';

const callers = new AsyncLocalStorage<{ userId: string }>();
// Somente os handlers autenticados definem o chamador; não vem do body de negócio.
export function withApifyCaller<T>(userId: string, work: () => T): T {
  return callers.run({ userId }, work);
}
export function apifyCallerUserId(): string | undefined {
  return callers.getStore()?.userId;
}
