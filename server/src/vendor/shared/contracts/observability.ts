import { z } from 'zod';
import { Severity } from './findings.js';
import { FindingRecord } from './review-api.js';

/**
 * A5 — Observability / Multi-agent contracts (L07, specs/multi-agent-review.md).
 *
 * These are NEW contracts (A5 owns this file; the barrel re-exports it). They
 * sit alongside A2's `review-api.ts`:
 *   - MultiAgentRun        GET /multi-agent-runs/:id (parent of N agent runs,
 *                          started by POST /pulls/:id/review with 2+ agentIds)
 *   - MultiAgentRunSummary GET /repos/:id/multi-agent-runs (newest first)
 *   - AgentRunEstimate     GET /runs/estimates (Configure run screen)
 *   - AgentColumn          one agent's column in the multi-agent view
 *   - Conflict / ConflictTake  one location group and each agent's take on it
 *   - AgentStats           per-agent quality aggregates (GET /agents/:id/stats)
 *   - CuratorResult        the cross-session memory curator outcome
 *
 * The single-document run trace itself stays in `contracts/trace.ts` (RunTrace).
 */

// ---------------------------------------------------------------------------
// Multi-Agent Review
// ---------------------------------------------------------------------------

/** A finding as surfaced in a multi-agent column (subset of FindingRecord). */
export const AgentColumnFinding = z.object({
  id: z.string(),
  severity: Severity,
  category: z.string(),
  title: z.string(),
  file: z.string(),
  start_line: z.number().int(),
  kind: z.string().nullish(),
});
export type AgentColumnFinding = z.infer<typeof AgentColumnFinding>;

/** One agent's result column in the multi-agent review. */
export const AgentColumn = z.object({
  run_id: z.string(),
  agent_id: z.string(),
  /** Stored name; the client labels a deleted agent. */
  agent_name: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  status: z.enum(['done', 'failed', 'running', 'cancelled']),
  error: z.string().nullish(),
  verdict: z.string().nullable(),
  score: z.number().int().nullable(),
  summary: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  findings: z.array(FindingRecord),
});
export type AgentColumn = z.infer<typeof AgentColumn>;

/** One agent's stance on a location group. */
export const ConflictTake = z.object({
  agent_id: z.string(),
  /** Agent name. */
  persona: z.string(),
  run_id: z.string(),
  /** Highest severity the agent flagged in the group, or 'ignored' = "did not flag". */
  verdict: z.union([Severity, z.literal('ignored')]),
  /** Title of the agent's highest-severity finding in the group; "" when ignored. */
  note: z.string(),
  /** The agent's findings in the group; empty when ignored. */
  finding_ids: z.array(z.string()),
});
export type ConflictTake = z.infer<typeof ConflictTake>;

/**
 * A location group = findings in the same file whose line ranges overlap
 * (chains merge). `is_conflict` is false when every finished agent flagged it
 * with the same severity. Computed from persisted findings on read; not stored.
 */
export const Conflict = z.object({
  file: z.string(),
  /** Min start_line of the group. */
  line: z.number().int(),
  /** Max end_line of the group. */
  end_line: z.number().int(),
  title: z.string(),
  is_conflict: z.boolean(),
  takes: z.array(ConflictTake),
});
export type Conflict = z.infer<typeof Conflict>;

/** Response of GET /multi-agent-runs/:id. Totals and status are derived on read. */
export const MultiAgentRun = z.object({
  id: z.string(),
  pr_id: z.string(),
  repo_id: z.string(),
  pr_number: z.number().int().nullish(),
  pr_title: z.string().nullish(),
  ran_at: z.string(),
  agent_count: z.number().int(),
  /** Wall clock of a parallel fan-out: max column duration_ms (0 when none). */
  total_duration_ms: z.number().int(),
  /** Sum of non-null column costs; null when all are null. */
  total_cost_usd: z.number().nullable(),
  columns: z.array(AgentColumn),
  /** Every location group, conflict or not. */
  conflicts: z.array(Conflict),
});
export type MultiAgentRun = z.infer<typeof MultiAgentRun>;

/** Row of GET /repos/:id/multi-agent-runs (newest ran_at first). */
export const MultiAgentRunSummary = z.object({
  id: z.string(),
  pr_id: z.string(),
  pr_number: z.number().int().nullable(),
  pr_title: z.string().nullable(),
  ran_at: z.string(),
  agent_count: z.number().int(),
  running_count: z.number().int(),
  total_cost_usd: z.number().nullable(),
});
export type MultiAgentRunSummary = z.infer<typeof MultiAgentRunSummary>;

/** Per-agent averages over its last ≤ 10 done runs (GET /runs/estimates). */
export const AgentRunEstimate = z.object({
  agent_id: z.string(),
  sample_size: z.number().int(),
  avg_duration_ms: z.number().nullable(),
  avg_cost_usd: z.number().nullable(),
});
export type AgentRunEstimate = z.infer<typeof AgentRunEstimate>;

// ---------------------------------------------------------------------------
// Per-agent Stats (GET /agents/:id/stats)
// ---------------------------------------------------------------------------

/** A single (date, value) point for a sparkline/trend. */
export const StatPoint = z.object({ label: z.string(), value: z.number() });
export type StatPoint = z.infer<typeof StatPoint>;

export const AgentStats = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  runs: z.number().int(),
  findings_total: z.number().int(),
  /** accept-rate is the headline quality signal. 0..1 over acted findings. */
  accepted: z.number().int(),
  dismissed: z.number().int(),
  pending: z.number().int(),
  accept_rate: z.number().nullable(),
  dismiss_rate: z.number().nullable(),
  avg_findings_per_run: z.number().nullable(),
  total_cost_usd: z.number().nullable(),
  avg_cost_usd: z.number().nullable(),
  avg_latency_ms: z.number().nullable(),
  findings_by_severity: z.object({
    CRITICAL: z.number().int(),
    WARNING: z.number().int(),
    SUGGESTION: z.number().int(),
  }),
  /** recent runs for a small trend chart (oldest→newest). */
  trend: z.array(StatPoint),
});
export type AgentStats = z.infer<typeof AgentStats>;

// ---------------------------------------------------------------------------
// Cross-session memory curator
// ---------------------------------------------------------------------------

/** A merge the curator performed (or would perform in dry-run). */
export const CuratorMerge = z.object({
  kept_id: z.string(),
  merged_ids: z.array(z.string()),
  content: z.string(),
  similarity: z.number(),
});
export type CuratorMerge = z.infer<typeof CuratorMerge>;

export const CuratorResult = z.object({
  scanned: z.number().int(),
  merges: z.array(CuratorMerge),
  removed: z.number().int(),
  dry_run: z.boolean(),
});
export type CuratorResult = z.infer<typeof CuratorResult>;
