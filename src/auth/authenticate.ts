import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod/v4';
import { ApiError } from '../errors/api.error.js';

export const JWT_MAX_LIFETIME_SECONDS = 5 * 60;
const identitySchema = z.object({
  sub: z
    .string()
    .min(1)
    .refine((value) => value === value.trim()),
  iat: z.number().int(),
  exp: z.number().int(),
  scope: z.string().optional(),
});

async function verifyIdentity(request: FastifyRequest) {
  try {
    await request.jwtVerify();
    const identity = identitySchema.parse(request.user);
    const now = Math.floor(Date.now() / 1000);
    if (
      identity.iat > now ||
      identity.exp <= identity.iat ||
      identity.exp <= now ||
      identity.exp - identity.iat > JWT_MAX_LIFETIME_SECONDS
    ) {
      throw new Error('Invalid token lifetime');
    }
    return identity;
  } catch {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Token Bearer ausente, inválido ou expirado');
  }
}

// Rotas de usuário: o backend principal deve enviar sub = ID do usuário HustleQ.
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const identity = await verifyIdentity(request);
    if (identity.scope !== undefined || identity.sub === 'hustleq-main') {
      throw new ApiError(403, 'FORBIDDEN', 'Esta rota exige um token de usuário');
    }
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      reply.header('WWW-Authenticate', 'Bearer');
    }
    throw error;
  }
}

// Usar nas novas rotas /internal e nos pontos explicitamente autorizados para jobs.
export async function authenticateService(request: FastifyRequest, reply: FastifyReply) {
  try {
    const identity = await verifyIdentity(request);
    if (identity.sub !== 'hustleq-main' || identity.scope !== 'service') {
      throw new ApiError(403, 'FORBIDDEN', 'Esta rota exige um token de serviço');
    }
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      reply.header('WWW-Authenticate', 'Bearer');
    }
    throw error;
  }
}

export function authenticatedUserId(request: FastifyRequest) {
  // O onRequest authenticate já verificou a assinatura e o papel do token.
  return identitySchema.parse(request.user).sub;
}
