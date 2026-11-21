import { z } from 'zod/v4';

export const instagramInternalIdSchema = z.string().trim().min(1).max(200);
export const instagramProfileIdParamsSchema = z.strictObject({
  profileId: instagramInternalIdSchema,
});
const readDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const readRangeFields = {
  from: readDateSchema.optional(),
  to: readDateSchema.optional(),
};
export interface ReadRange {
  from?: string | undefined;
  to?: string | undefined;
}
const DAY_MS = 86400000;
export function validateReadRange(value: ReadRange, ctx: z.RefinementCtx) {
  if (value.from && value.to) {
    const end = Date.parse(value.to) + (value.to.length === 10 ? DAY_MS - 1 : 0);
    if (Date.parse(value.from) > end) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'to deve ser maior ou igual a from' });
    }
  }
}
export const instagramReadRangeSchema = z
  .strictObject(readRangeFields)
  .superRefine(validateReadRange);

// Datas simples incluem o dia UTC inteiro; instantes ISO são limites inclusivos.
export function storedDateFilter(range: ReadRange) {
  const filter: { gte?: Date; lt?: Date; lte?: Date } = {};
  if (range.from) filter.gte = new Date(range.from);
  if (range.to) {
    if (range.to.length === 10) filter.lt = new Date(Date.parse(range.to) + DAY_MS);
    else filter.lte = new Date(range.to);
  }
  return filter;
}
export const readErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), time: z.iso.datetime() }),
});
export const publicCountSchema = z.int().min(0).max(2147483647).nullable();

export const publicPostMetricSchema = z.object({
  likesCount: publicCountSchema,
  likesHidden: z.boolean(),
  commentsCount: publicCountSchema,
  viewsCount: z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  collectedAt: z.iso.datetime(),
});
