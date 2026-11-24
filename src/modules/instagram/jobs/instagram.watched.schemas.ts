import { z } from 'zod/v4';
import { dailyMetadataSchema } from './instagram.daily.schemas.js';

export const watchedMetadataSchema = dailyMetadataSchema.omit({ daily: true }).extend({
  watched: dailyMetadataSchema.shape.daily.omit({ ownerUserId: true }).extend({
    // Atribuição por usuários distintos elegíveis, nunca pelo dono do alvo.
    userId: z.string().min(1).nullable(),
  }),
});
