/** Period resolution (FR8): the query → the window the aggregation filters on. */
import type { PeriodInfo } from '@devdigest/shared';
import { InvalidInputError } from '../../../platform/errors.js';
import { MS_PER_HOUR, PRESET_HOURS } from './constants.js';

export type PeriodKey = PeriodInfo['key'];

/** The validated period query (the route schema guarantees the custom invariants). */
export interface PeriodQuery {
  period: PeriodKey;
  /** ISO-8601 instants with an offset; present only for `custom`. */
  from?: string | undefined;
  to?: string | undefined;
}

export interface PeriodWindow {
  key: PeriodKey;
  from: Date;
  to: Date;
  /** Presets include `to` (= now); custom ranges are [from, to). */
  toInclusive: boolean;
}

/** Resolve the window against the server clock. */
export function resolveWindow(q: PeriodQuery, now: Date): PeriodWindow {
  if (q.period === 'custom') {
    if (!q.from || !q.to) throw new InvalidInputError('A custom period needs from and to');
    return { key: 'custom', from: new Date(q.from), to: new Date(q.to), toInclusive: false };
  }
  return {
    key: q.period,
    from: new Date(now.getTime() - PRESET_HOURS[q.period] * MS_PER_HOUR),
    to: now,
    toInclusive: true,
  };
}

export function toPeriodInfo(w: PeriodWindow): PeriodInfo {
  return { key: w.key, from: w.from.toISOString(), to: w.to.toISOString() };
}

/** The equally long window right before `w` (deltas and trend arrows); never overlaps it. */
export function previousWindow(w: PeriodWindow): PeriodWindow {
  const span = w.to.getTime() - w.from.getTime();
  return { key: w.key, from: new Date(w.from.getTime() - span), to: w.from, toInclusive: false };
}
