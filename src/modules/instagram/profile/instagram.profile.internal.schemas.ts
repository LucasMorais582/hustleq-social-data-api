import { z } from 'zod/v4';
import { storedProfileResponseSchema } from './instagram.profile.read.schemas.js';
import { instagramUsernameSchema } from '../shared/instagram.provider.schemas.js';

export const reserveInstagramProfileSchema = z.strictObject({
  username: instagramUsernameSchema,
  inviteId: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value === value.trim()),
  reservedUntil: z.iso.datetime({ offset: true }),
});
export type ReserveInstagramProfileRequest = z.infer<typeof reserveInstagramProfileSchema>;
export const reservedInstagramProfileResponseSchema = z.object({
  profileId: z.string(),
  username: z.string(),
  status: z.enum(['syncing', 'ready']),
});

export const updateProfileMonitoringSchema = z.strictObject({
  monitoringUntil: z.iso.datetime({ offset: true }).nullable(),
});
export const profileMonitoringResponseSchema = storedProfileResponseSchema
  .omit({ metrics: true })
  .extend({ monitoringUntil: z.iso.datetime().nullable() });

export const assignProfileOwnerSchema = z.strictObject({
  userId: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value === value.trim()),
});
export const assignedProfileOwnerResponseSchema = z.object({
  profileId: z.string(),
  ownerUserId: z.string(),
});
// Fastify pode representar o body ausente do DELETE como null; ambos são vazios.
export const clearProfileReservationSchema = z.strictObject({}).nullish();

export const removeProfileOwnerQuerySchema = assignProfileOwnerSchema;
// A remoção aceita somente a query; body com campos deve ser rejeitado.
export const removeProfileOwnerBodySchema = z.null().optional();
