/** Dashboard derivations over finished runs (FR14, FR15): regression alert, sparkline, trend. Pure. */
import type { EvalMetricName, EvalPeriod, EvalRegressionAlert, EvalRunSummary, EvalSparkPoint } from '@devdigest/shared';
import { MS_PER_DAY, PERIOD_DAYS, REGRESSION_THRESHOLD, SPARKLINE_POINTS, TREND_POINTS } from './constants.js';
import { metricDelta } from './scoring.js';

const METRICS: readonly EvalMetricName[] = ['recall', 'precision', 'citation_accuracy'];

/**
 * The alert names every metric of the latest finished run that fell by ≥ 0.02 vs the
 * previous finished run (deltas are rounded first, so 0.92 → 0.90 counts). A metric that
 * is null on either side cannot regress. Null when nothing dropped enough.
 */
export function regressionAlert(
  latest: EvalRunSummary | null,
  previous: EvalRunSummary | null,
): EvalRegressionAlert | null {
  if (!latest || !previous) return null;
  const metrics = METRICS.flatMap((metric) => {
    const delta = metricDelta(previous[metric], latest[metric]);
    return delta !== null && delta <= -REGRESSION_THRESHOLD ? [{ metric, delta }] : [];
  });
  return metrics.length === 0 ? null : { metrics };
}

/** The last `max` points of finished runs given newest first, oldest first (chart order). */
function window(finishedNewestFirst: readonly EvalRunSummary[], max: number): EvalRunSummary[] {
  return finishedNewestFirst.slice(0, max).reverse();
}

/** Trend of the last `max` (default 20) finished runs, oldest first. */
export function trendOf(finishedNewestFirst: readonly EvalRunSummary[], max: number = TREND_POINTS): EvalRunSummary[] {
  return window(finishedNewestFirst, max);
}

/** Start of a period window: `now` minus N × 24 h; null for `all` (no lower bound). */
export function periodStart(period: EvalPeriod, now: Date): Date | null {
  if (period === 'all') return null;
  return new Date(now.getTime() - PERIOD_DAYS[period] * MS_PER_DAY);
}

/** Sparkline of the last 10 finished runs, oldest first. */
export function sparklineOf(finishedNewestFirst: readonly EvalRunSummary[]): EvalSparkPoint[] {
  return window(finishedNewestFirst, SPARKLINE_POINTS).map((r) => ({
    run_id: r.id,
    recall: r.recall,
    precision: r.precision,
    citation_accuracy: r.citation_accuracy,
  }));
}
