import type { FastifyReply, FastifyRequest } from 'fastify';

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.header('WWW-Authenticate', 'Bearer').status(401).send({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Token Bearer ausente, inválido ou expirado',
    });
  }
}
