import { z } from 'zod/v4';
import { InstagramSyncJobType } from '@prisma/client';

const internalId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim());
// Entrada interna da fila, não é um DTO de rota pública.
export const enqueueSyncJobSchema = z
  .strictObject({
    type: z.enum(InstagramSyncJobType),
    trigger: z.enum(['initial', 'daily', 'on_open', 'refresh', 'watched', 'discover']),
    instagramProfileId: internalId.optional(),
    instagramPostId: internalId.optional(),
    userId: internalId.optional(),
    activeKey: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value === value.trim()),
    payload: z.json().optional(),
    runAt: z.date().optional(),
  })
  .superRefine((value, ctx) => {
    const profileType = ['INITIAL_PROFILE_SYNC', 'DAILY_PROFILE_SYNC', 'WATCHED_SYNC'].includes(
      value.type,
    );
    if (
      (profileType && (!value.instagramProfileId || value.instagramPostId)) ||
      (value.type === 'POST_REFRESH' && !value.instagramPostId) ||
      (value.type === 'DISCOVER_SEARCH' && (value.instagramProfileId || value.instagramPostId))
    )
      ctx.addIssue({ code: 'custom', message: 'Alvo incompatível com o tipo do job' });
    const allowed = {
      INITIAL_PROFILE_SYNC: ['initial', 'watched'],
      DAILY_PROFILE_SYNC: ['daily'],
      WATCHED_SYNC: ['watched'],
      POST_REFRESH: ['on_open', 'refresh'],
      DISCOVER_SEARCH: ['discover'],
    };
    if (!allowed[value.type].includes(value.trigger)) {
      ctx.addIssue({ code: 'custom', path: ['trigger'], message: 'Origem incompatível com o job' });
    }
  });
export type EnqueueSyncJobInput = z.input<typeof enqueueSyncJobSchema>;
export const syncJobLeaseSchema = z.number().int().min(1).max(3600000);
export const syncJobOwnershipSchema = z.strictObject({ id: internalId, lockToken: internalId });
// Persistir código sanitizado, não erros/URLs com credenciais.
export const syncJobErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
