import { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

// A conexão só é aberta na primeira operação; importar um módulo não acessa o banco.
export function getPrismaClient() {
  client ??= new PrismaClient();
  return client;
}
