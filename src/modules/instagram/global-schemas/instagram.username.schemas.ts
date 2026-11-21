import { z } from 'zod/v4';
import { instagramUsernameSchema } from '../shared/instagram.provider.schemas.js';

export const instagramProfileRequestSchema = z.object({
  username: instagramUsernameSchema,
});
export type profileRequest = z.infer<typeof instagramProfileRequestSchema>;
