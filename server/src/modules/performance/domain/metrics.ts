/**
 * Pure aggregation (FR1–FR7). The repository returns per-run facts and grouped
 * finding counts; everything below folds them. Both endpoints use `buildRow`,
 * so a dashboard row equals the agent's stats by construction (AC10).
 */
import type { AgentPerf, AgentPerfRow, AgentPeriodMetrics, CostSegment } from '@devdigest/shared';
import { DELETED_AGENTS_NAME, MIN_DECISIONS, MONEY_DECIMALS } from './constants.js';
import { byName } from './order.js';
import type { PeriodWindow } from './period.js';
import { runsTrend } from './trends.js';

/** One counted run (done/failed/cancelled, local/ci) inside the window. */
export interface RunFact {
  agentId: string | null;
  status: 'done' | 'failed' | 'cancelled';
  source: 'local' | 'ci';
  model: string | null;
  durationMs: number | null;
  costUsd: number | null;
  ranAt: Date;
}

/** Findings of the counted runs of one agent (null = deleted agents). */
export interface FindingCounts {
  agentId: string | null;
  total: number;
  accepted: number;
  dismissed: number;
}

export interface AgentRef {
  id: string;
  name: string;
}

export type PerfSummary = AgentPerf['summary'];

const MONEY_FACTOR = 10 ** MONEY_DECIMALS;

export function roundMoney(n: number): number {
  return Math.round(n * MONEY_FACTOR) / MONEY_FACTOR;
}

export { byName };

/** Key order for null-able keys: ascending, null last. */
function byKey(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return byName(a, b);
}

/** FR2/FR3 over the counted runs of one agent and its finding counts. */
export function agentMetrics(
  runs: RunFact[],
  findings: FindingCounts | undefined,
  minDecisions: number = MIN_DECISIONS,
): AgentPeriodMetrics {
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let local = 0;
  let ci = 0;
  let priced = 0;
  let cost = 0;
  let doneWithDuration = 0;
  let durationSum = 0;
  let lastRun: number | null = null;

  for (const r of runs) {
    if (r.status === 'done') done++;
    else if (r.status === 'failed') failed++;
    else cancelled++;
    if (r.source === 'local') local++;
    else ci++;
    if (r.costUsd !== null) {
      priced++;
      cost = roundMoney(cost + r.costUsd);
    }
    if (r.status === 'done' && r.durationMs !== null) {
      doneWithDuration++;
      durationSum += r.durationMs;
    }
    const at = r.ranAt.getTime();
    if (lastRun === null || at > lastRun) lastRun = at;
  }

  const total = findings?.total ?? 0;
  const accepted = findings?.accepted ?? 0;
  const dismissed = findings?.dismissed ?? 0;
  const decisions = accepted + dismissed;

  return {
    runs: runs.length,
    runs_done: done,
    runs_failed: failed,
    runs_cancelled: cancelled,
    runs_local: local,
    runs_ci: ci,
    priced_runs: priced,
    unpriced_runs: runs.length - priced,
    total_cost_usd: priced > 0 ? cost : null,
    avg_cost_usd: priced > 0 ? roundMoney(cost / priced) : null,
    avg_duration_ms: doneWithDuration > 0 ? Math.round(durationSum / doneWithDuration) : null,
    last_run_at: lastRun === null ? null : new Date(lastRun).toISOString(),
    findings_total: total,
    accepted,
    dismissed,
    pending: total - decisions,
    decisions,
    accept_rate: decisions > 0 ? accepted / decisions : null,
    small_sample: decisions > 0 && decisions < minDecisions,
  };
}

/** One agent's facts in one window. */
export interface WindowFacts {
  runs: RunFact[];
  findings: FindingCounts | undefined;
}

/**
 * The one row builder behind both endpoints; `agent` null = deleted agents.
 * `previous` = the same agent's facts in the window right before `win`.
 */
export function buildRow(
  agent: AgentRef | null,
  current: WindowFacts,
  previous: WindowFacts,
  win: PeriodWindow,
): AgentPerfRow {
  return {
    agent_id: agent?.id ?? null,
    agent_name: agent?.name ?? DELETED_AGENTS_NAME,
    metrics: agentMetrics(current.runs, current.findings),
    previous: agentMetrics(previous.runs, previous.findings),
    runs_trend: runsTrend(current.runs, win),
  };
}

/** Group runs by agent id (null = deleted agents / unknown ids). */
export function groupRuns(runs: RunFact[], knownAgentIds: ReadonlySet<string>): Map<string | null, RunFact[]> {
  const out = new Map<string | null, RunFact[]>();
  for (const r of runs) {
    const key = r.agentId !== null && knownAgentIds.has(r.agentId) ? r.agentId : null;
    const bucket = out.get(key);
    if (bucket) bucket.push(r);
    else out.set(key, [r]);
  }
  return out;
}

/** Fold finding counts onto the same keys as `groupRuns`. */
export function groupFindings(
  counts: FindingCounts[],
  knownAgentIds: ReadonlySet<string>,
): Map<string | null, FindingCounts> {
  const out = new Map<string | null, FindingCounts>();
  for (const c of counts) {
    const key = c.agentId !== null && knownAgentIds.has(c.agentId) ? c.agentId : null;
    const prev = out.get(key);
    out.set(key, {
      agentId: key,
      total: (prev?.total ?? 0) + c.total,
      accepted: (prev?.accepted ?? 0) + c.accepted,
      dismissed: (prev?.dismissed ?? 0) + c.dismissed,
    });
  }
  return out;
}

/** EC9: most runs; ties → later last run, then name ascending. Deleted agents never qualify. */
export function mostActive(rows: AgentPerfRow[]): PerfSummary['most_active'] {
  let best: AgentPerfRow | null = null;
  for (const row of rows) {
    if (row.agent_id === null || row.metrics.runs === 0) continue;
    if (best === null || beats(row, best)) best = row;
  }
  if (best === null || best.agent_id === null) return null;
  return { agent_id: best.agent_id, agent_name: best.agent_name, runs: best.metrics.runs };
}

function beats(a: AgentPerfRow, b: AgentPerfRow): boolean {
  if (a.metrics.runs !== b.metrics.runs) return a.metrics.runs > b.metrics.runs;
  const at = a.metrics.last_run_at ? Date.parse(a.metrics.last_run_at) : 0;
  const bt = b.metrics.last_run_at ? Date.parse(b.metrics.last_run_at) : 0;
  if (at !== bt) return at > bt;
  return byName(a.agent_name, b.agent_name) < 0;
}

/** FR6: sums over all rows; the accept rate is pooled (Σaccepted / Σdecisions). */
export function summarize(rows: AgentPerfRow[]): PerfSummary {
  let runs = 0;
  let priced = 0;
  let unpriced = 0;
  let accepted = 0;
  let dismissed = 0;
  let pending = 0;
  let cost = 0;
  for (const { metrics: m } of rows) {
    runs += m.runs;
    priced += m.priced_runs;
    unpriced += m.unpriced_runs;
    accepted += m.accepted;
    dismissed += m.dismissed;
    pending += m.pending;
    if (m.total_cost_usd !== null) cost = roundMoney(cost + m.total_cost_usd);
  }
  const decisions = accepted + dismissed;
  return {
    runs,
    priced_runs: priced,
    unpriced_runs: unpriced,
    accepted,
    dismissed,
    pending,
    decisions,
    total_cost_usd: priced > 0 ? cost : null,
    avg_accept_rate: decisions > 0 ? accepted / decisions : null,
    most_active: mostActive(rows),
  };
}

/** Largest first, then key ascending; zero-value segments are dropped (FR7). */
function toSegments(items: CostSegment[]): CostSegment[] {
  return items.filter((s) => s.value > 0).sort((a, b) => b.value - a.value || byKey(a.key, b.key));
}

/** FR7: one segment per row that has a positive priced cost. */
export function costByAgent(rows: AgentPerfRow[]): CostSegment[] {
  return toSegments(
    rows.map((r) => ({
      key: r.agent_id,
      label: r.agent_id === null ? null : r.agent_name,
      value: r.metrics.total_cost_usd ?? 0,
      runs: r.metrics.priced_runs,
    })),
  );
}

/** FR7: priced runs grouped by the run's own stored model (null = unknown model). */
export function costByModel(runs: RunFact[]): CostSegment[] {
  const byModel = new Map<string | null, { value: number; runs: number }>();
  for (const r of runs) {
    if (r.costUsd === null) continue;
    const seg = byModel.get(r.model) ?? { value: 0, runs: 0 };
    seg.value = roundMoney(seg.value + r.costUsd);
    seg.runs += 1;
    byModel.set(r.model, seg);
  }
  return toSegments([...byModel].map(([model, s]) => ({ key: model, label: model, value: s.value, runs: s.runs })));
}
