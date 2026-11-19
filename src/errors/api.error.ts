import type { FastifyReply } from 'fastify';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendApiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({
    error: { code, message, time: new Date().toISOString() },
  });
}
