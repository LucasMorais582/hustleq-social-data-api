import { z } from 'zod/v4';

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
