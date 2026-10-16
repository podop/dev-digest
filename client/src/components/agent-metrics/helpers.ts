/** Pure formatting of the Agent Performance numbers (specs/2026-10-16-agent-performance.md FR13). */

/** Whole milliseconds → seconds with one decimal ("6.2"); null stays null (shown as "—", never 0). */
export function formatDurationS(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return (ms / 1000).toFixed(1);
}

/** A 0..1 rate → whole percent (0.756 → 75.6 → 76); null stays null. */
export function formatPercent(rate: number | null | undefined): number | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  return Math.round(rate * 100);
}

/** `value` as a whole percent of `total`; 0 when there is nothing to divide by. */
export function sharePercent(value: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round((value / total) * 100);
}
