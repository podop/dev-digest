import { z } from 'zod';
import { DEFAULT_PERIOD, MAX_CUSTOM_SPAN_DAYS, MS_PER_DAY } from '../domain/constants.js';

const Instant = z.string().datetime({ offset: true });

/**
 * Period query of both endpoints (spec §7). The rules live on the route schema
 * so a violation is a 422 `validation_error` before any query runs.
 */
export const PeriodQuery = z
  .object({
    period: z.enum(['1d', '30d', 'custom']).default(DEFAULT_PERIOD),
    from: Instant.optional(),
    to: Instant.optional(),
  })
  .superRefine((q, ctx) => {
    if (q.period !== 'custom') {
      for (const key of ['from', 'to'] as const) {
        if (q[key] !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is only allowed with period=custom` });
        }
      }
      return;
    }
    for (const key of ['from', 'to'] as const) {
      if (q[key] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required with period=custom` });
      }
    }
    if (q.from === undefined || q.to === undefined) return;
    const span = Date.parse(q.to) - Date.parse(q.from);
    if (span <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to must be after from' });
    } else if (span > MAX_CUSTOM_SPAN_DAYS * MS_PER_DAY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `The range can be at most ${MAX_CUSTOM_SPAN_DAYS} days`,
      });
    }
  });
export type PeriodQuery = z.infer<typeof PeriodQuery>;
