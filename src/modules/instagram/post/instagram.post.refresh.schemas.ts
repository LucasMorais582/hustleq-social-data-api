import { z } from 'zod/v4';
import { storedPostResponseSchema } from '../profile/instagram.profile.read.schemas.js';

export const postRefreshingResponseSchema = z.object({ status: z.literal('refreshing') });
export const postRefreshingWithDataResponseSchema = postRefreshingResponseSchema.extend({
  post: storedPostResponseSchema,
});
export const postRefreshBodySchema = z.union([z.null(), z.strictObject({})]).optional();
export const postRefreshQuerySchema = z.strictObject({});
