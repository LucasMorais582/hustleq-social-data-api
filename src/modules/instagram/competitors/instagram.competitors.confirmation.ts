import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
import { env } from '../../../config/env.js';
import { CompetitorError } from './instagram.competitors.errors.js';
import {
  competitorIdentitySchema,
  type CompetitorIdentity,
} from './instagram.competitors.schemas.js';

const payloadSchema = z.strictObject({
  profileId: z.string(),
  subject: z.string(),
  expiresAt: z.number().int(),
  profile: competitorIdentitySchema,
});
function signature(payload: string) {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`instagram-competitor-confirmation:${payload}`)
    .digest('base64url');
}
export function createCompetitorConfirmation(
  profileId: string,
  subject: string,
  profile: CompetitorIdentity,
) {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ profileId, subject, expiresAt, profile })).toString(
    'base64url',
  );
  return {
    confirmationToken: `${payload}.${signature(payload)}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}
export function readCompetitorConfirmation(token: string, profileId: string, subject: string) {
  try {
    const [payload, signed, extra] = token.split('.');
    if (!payload || !signed || extra !== undefined) throw new Error();
    const actual = Buffer.from(signed);
    const expected = Buffer.from(signature(payload));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const data = payloadSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (data.profileId !== profileId || data.subject !== subject || data.expiresAt <= Date.now()) {
      throw new Error();
    }
    return data.profile;
  } catch {
    throw new CompetitorError(
      400,
      'COMPETITOR_CONFIRMATION_INVALID',
      'Confirmação inválida ou expirada. Busque o username novamente',
    );
  }
}
