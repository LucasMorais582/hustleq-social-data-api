import { z } from 'zod/v4';
import {
  instagramInternalIdSchema,
  publicPostMetricSchema,
} from '../shared/instagram.read.schemas.js';

export const instagramPostIdParamsSchema = z.strictObject({ postId: instagramInternalIdSchema });
export const postMetricsResponseSchema = z.object({
  postId: z.string(),
  metrics: z.array(
    publicPostMetricSchema.extend({
      // Nulo no legado de teste, conforme decisão do usuário.
      source: z.enum(['initial', 'daily', 'on_open', 'refresh']).nullable(),
    }),
  ),
});
