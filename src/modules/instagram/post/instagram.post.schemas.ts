import { z } from 'zod/v4';
import {
  instagramProviderPostSchema,
  instagramUsernameSchema,
} from '../shared/instagram.provider.schemas.js';
export { instagramProviderPostSchema } from '../shared/instagram.provider.schemas.js';

export const instagramPostRequestSchema = z.object({
  username: instagramUsernameSchema,
  resultLimits: z.int().min(1).max(50),
});
export type profileRequestWithResultLimits = z.infer<typeof instagramPostRequestSchema>;
export type postRequestApify = z.infer<typeof instagramProviderPostSchema>;

export const instagramPersistablePostSchema = instagramProviderPostSchema.extend({
  id: z.string().trim().min(1),
  ownerId: z.string().trim().min(1),
});
