/**
 * Deterministic eval scoring (specs/eval-pipeline.md Glossary "Scoring", FR9).
 * Pure code over kept findings, dropped counts and expectations — it makes no LLM call.
 */
import type { EvalExpectation } from '@devdigest/shared';
import { COST_DECIMALS, METRIC_DECIMALS } from './constants.js';
import type { CaseOutcome, CaseScore, KeptFinding, LabeledFinding, RunMetrics, RunVerdict } from './types.js';

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export const roundMetric = (value: number): number => roundTo(value, METRIC_DECIMALS);

/** `next − prev`, rounded; null when either side is null. */
export function metricDelta(prev: number | null, next: number | null, decimals = METRIC_DECIMALS): number | null {
  if (prev === null || next === null) return null;
  return roundTo(next - prev, decimals);
}

/** Inclusive line ranges intersect (either bound order, like the grounding gate). */
export function rangesIntersect(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const aLo = Math.min(aStart, aEnd);
  const aHi = Math.max(aStart, aEnd);
  const bLo = Math.min(bStart, bEnd);
  const bHi = Math.max(bStart, bEnd);
  return aLo <= bHi && bLo <= aHi;
}

/** A kept finding matches the expectation when the file is equal and the line ranges intersect. */
export function matchesExpectation(expectation: EvalExpectation, f: KeptFinding): boolean {
  return (
    f.file === expectation.file &&
    rangesIntersect(f.start_line, f.end_line, expectation.start_line, expectation.end_line)
  );
}

/**
 * Score one case: a matching finding is a hit (`must_find`) or a violation (`must_not_flag`),
 * every other kept finding is unlabeled. `must_find` passes iff ≥ 1 hit; `must_not_flag` iff 0 violations.
 */
export function scoreCase(expectation: EvalExpectation, kept: readonly KeptFinding[]): CaseScore {
  const matchLabel = expectation.kind === 'must_find' ? 'hit' : 'violation';
  let hits = 0;
  let violations = 0;
  let unlabeled = 0;
  const findings: LabeledFinding[] = kept.map((f) => {
    if (!matchesExpectation(expectation, f)) {
      unlabeled++;
      return { ...f, match: 'unlabeled' };
    }
    if (matchLabel === 'hit') hits++;
    else violations++;
    return { ...f, match: matchLabel };
  });
  const passed = expectation.kind === 'must_find' ? hits >= 1 : violations === 0;
  return {
    status: passed ? 'passed' : 'failed',
    findings,
    hit_count: hits,
    violation_count: violations,
    unlabeled_count: unlabeled,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : roundMetric(numerator / denominator);
}

/**
 * Aggregate a run over its non-error cases: recall = must_find cases passed / must_find cases;
 * precision = hits / (hits + violations); citation accuracy = kept / (kept + dropped).
 * Cost sums every case that reported one — an errored case's spend still counts.
 */
export function aggregateRun(outcomes: readonly CaseOutcome[]): RunMetrics {
  const scored = outcomes.filter((o) => o.status !== 'error');
  const mustFind = scored.filter((o) => o.kind === 'must_find');
  const hits = scored.reduce((n, o) => n + o.hit_count, 0);
  const violations = scored.reduce((n, o) => n + o.violation_count, 0);
  const unlabeled = scored.reduce((n, o) => n + o.unlabeled_count, 0);
  const dropped = scored.reduce((n, o) => n + o.dropped_count, 0);
  const kept = hits + violations + unlabeled;
  const costs = outcomes.flatMap((o) => (o.cost_usd === null ? [] : [o.cost_usd]));
  return {
    recall: ratio(mustFind.filter((o) => o.status === 'passed').length, mustFind.length),
    precision: ratio(hits, hits + violations),
    citation_accuracy: ratio(kept, kept + dropped),
    cases_passed: scored.filter((o) => o.status === 'passed').length,
    cases_errored: outcomes.length - scored.length,
    unlabeled_findings: unlabeled,
    cost_usd: costs.length === 0 ? null : roundTo(costs.reduce((a, b) => a + b, 0), COST_DECIMALS),
  };
}

/** `failed` (with the first case error) when every case errored; otherwise `completed` (EC10). */
export function runVerdict(outcomes: readonly CaseOutcome[]): RunVerdict {
  const allErrored = outcomes.length > 0 && outcomes.every((o) => o.status === 'error');
  if (!allErrored) return { status: 'completed', error: null };
  return { status: 'failed', error: outcomes.find((o) => o.error)?.error ?? 'every case errored' };
}
