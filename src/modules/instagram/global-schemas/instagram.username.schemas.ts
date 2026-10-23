import { z } from 'zod/v4';

export const instagramProfileRequestSchema = z.object({
  username: z.string().min(3),
});
export type profileRequest = z.infer<typeof instagramProfileRequestSchema>;
