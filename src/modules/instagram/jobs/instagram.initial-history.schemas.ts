import { z } from 'zod/v4';

// Persistido na primeira tentativa; reiniciar o worker não muda janela ou teto.
export const initialHistorySchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  limit: z.int().min(1).max(1000),
  savedPostIds: z.array(z.string()).default([]),
  limitReached: z.boolean().default(false),
});
export type InitialHistory = z.infer<typeof initialHistorySchema>;
