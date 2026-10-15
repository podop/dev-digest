import { z } from 'zod';

/**
 * Eval pipeline contracts (specs/eval-pipeline.md §7): turn a decided finding into an
 * agent-owned eval case, run an agent's case set in the background with code-only
 * metrics, then list / compare / dashboard the runs.
 *
 * ADDITIVE next to the legacy `EvalRun` / `EvalCase` / `EvalRunRecord` / `EvalDashboard`
 * contracts (knowledge.ts, eval-ci.ts), which stay unchanged — the names here are
 * deliberately distinct (`AgentEvalCase`, `EvalRunSummary`, …).
 */

// ---- limits (zod-free consumers can mirror these) ----
export const EVAL_CASE_NAME_MAX = 120;
export const EVAL_INPUT_DIFF_MAX_CHARS = 200_000;
export const EVAL_CASES_PER_AGENT_MAX = 200;

// ---- enums ----
export const EvalExpectationKind = z.enum(['must_find', 'must_not_flag']);
export type EvalExpectationKind = z.infer<typeof EvalExpectationKind>;

/** Per-case outcome. */
export const EvalCaseStatus = z.enum(['passed', 'failed', 'error']);
export type EvalCaseStatus = z.infer<typeof EvalCaseStatus>;

/** Status of one execution of an agent's whole case set (a "suite run"). */
export const EvalRunStatus = z.enum(['running', 'completed', 'failed']);
export type EvalRunStatus = z.infer<typeof EvalRunStatus>;

export const EvalFindingMatch = z.enum(['hit', 'violation', 'unlabeled']);
export type EvalFindingMatch = z.infer<typeof EvalFindingMatch>;

export const EvalMetricName = z.enum(['recall', 'precision', 'citation_accuracy']);
export type EvalMetricName = z.infer<typeof EvalMetricName>;

/** Error `code` values of the eval routes (lower snake_case, like the rest of the envelope). */
export const EvalErrorCode = z.enum([
  'not_found',
  'validation_error',
  'eval_case_exists',
  'finding_undecided',
  'finding_no_agent',
  'patch_unavailable',
  'patch_too_large',
  'eval_case_limit',
  'eval_run_active',
  'no_eval_cases',
  'runs_not_comparable',
]);
export type EvalErrorCode = z.infer<typeof EvalErrorCode>;

// ---- eval case ----
export const EvalExpectation = z
  .object({
    kind: EvalExpectationKind,
    file: z.string(),
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
    severity: z.string().nullable(),
    category: z.string().nullable(),
    title: z.string().nullable(),
  })
  .refine((e) => e.end_line >= e.start_line, {
    message: 'end_line must be >= start_line',
    path: ['end_line'],
  });
export type EvalExpectation = z.infer<typeof EvalExpectation>;

export const EvalCaseInputMeta = z.object({
  pr_title: z.string(),
  pr_description: z.string().nullable(),
  repo: z.string(),
  pr_number: z.number().int(),
  head_sha: z.string().nullable(),
});
export type EvalCaseInputMeta = z.infer<typeof EvalCaseInputMeta>;

export const EvalCaseLastResult = z.object({
  run_id: z.string(),
  status: EvalCaseStatus,
  ran_at: z.string(),
});
export type EvalCaseLastResult = z.infer<typeof EvalCaseLastResult>;

export const AgentEvalCase = z.object({
  id: z.string(),
  agent_id: z.string(),
  name: z.string().min(1).max(EVAL_CASE_NAME_MAX),
  notes: z.string().nullable(),
  expectation: EvalExpectation,
  input_diff: z.string(),
  input_meta: EvalCaseInputMeta,
  source_finding_id: z.string().nullable(),
  source_pr_id: z.string().nullable(),
  created_at: z.string(),
  last_result: EvalCaseLastResult.nullable(),
});
export type AgentEvalCase = z.infer<typeof AgentEvalCase>;

/** `PATCH /eval-cases/:id` — field shape only; `end_line >= start_line` is checked against the stored values. */
export const AgentEvalCaseUpdateInput = z.object({
  name: z.string().min(1).max(EVAL_CASE_NAME_MAX).optional(),
  notes: z.string().nullable().optional(),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});
export type AgentEvalCaseUpdateInput = z.infer<typeof AgentEvalCaseUpdateInput>;

export const AgentEvalCaseList = z.object({ cases: z.array(AgentEvalCase) });
export type AgentEvalCaseList = z.infer<typeof AgentEvalCaseList>;

// ---- runs ----
/** Metrics are null while running and when their denominator is 0. */
export const EvalRunSummary = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_version: z.number().int(),
  model: z.string(),
  status: EvalRunStatus,
  started_at: z.string(),
  finished_at: z.string().nullable(),
  cases_total: z.number().int(),
  cases_finished: z.number().int(),
  cases_passed: z.number().int(),
  cases_errored: z.number().int(),
  recall: z.number().min(0).max(1).nullable(),
  precision: z.number().min(0).max(1).nullable(),
  citation_accuracy: z.number().min(0).max(1).nullable(),
  unlabeled_findings: z.number().int(),
  cost_usd: z.number().nullable(),
  duration_ms: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type EvalRunSummary = z.infer<typeof EvalRunSummary>;

export const EvalResultFinding = z.object({
  file: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  severity: z.string().nullable(),
  category: z.string().nullable(),
  title: z.string().nullable(),
  match: EvalFindingMatch,
});
export type EvalResultFinding = z.infer<typeof EvalResultFinding>;

export const EvalCaseResult = z.object({
  case_id: z.string(),
  case_name: z.string(),
  expectation: EvalExpectation,
  status: EvalCaseStatus,
  findings: z.array(EvalResultFinding),
  dropped_count: z.number().int(),
  duration_ms: z.number().int(),
  cost_usd: z.number().nullable(),
  error: z.string().nullable(),
});
export type EvalCaseResult = z.infer<typeof EvalCaseResult>;

export const EvalRunList = z.object({ runs: z.array(EvalRunSummary) });
export type EvalRunList = z.infer<typeof EvalRunList>;

export const EvalRunListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type EvalRunListQuery = z.infer<typeof EvalRunListQuery>;

export const EvalRunDetail = z.object({
  run: EvalRunSummary,
  results: z.array(EvalCaseResult),
});
export type EvalRunDetail = z.infer<typeof EvalRunDetail>;

// ---- compare ----
export const EvalCompareQuery = z.object({ a: z.string().min(1), b: z.string().min(1) });
export type EvalCompareQuery = z.infer<typeof EvalCompareQuery>;

export const EvalCompareCaseStatus = z.union([EvalCaseStatus, z.literal('absent')]);
export type EvalCompareCaseStatus = z.infer<typeof EvalCompareCaseStatus>;

export const EvalPromptDiffLine = z.object({
  op: z.enum(['same', 'add', 'del']),
  line: z.string(),
});
export type EvalPromptDiffLine = z.infer<typeof EvalPromptDiffLine>;

const EvalValueChange = z.object({ a: z.string(), b: z.string() });

export const EvalCompare = z.object({
  a: EvalRunSummary,
  b: EvalRunSummary,
  delta: z.object({
    recall: z.number().nullable(),
    precision: z.number().nullable(),
    citation_accuracy: z.number().nullable(),
    cost_usd: z.number().nullable(),
  }),
  cases: z.array(
    z.object({
      case_id: z.string(),
      case_name: z.string(),
      a: EvalCompareCaseStatus,
      b: EvalCompareCaseStatus,
      flipped: z.boolean(),
    }),
  ),
  config_diff: z.object({
    system_prompt: z.array(EvalPromptDiffLine),
    model: EvalValueChange.nullable(),
    strategy: EvalValueChange.nullable(),
    skills_added: z.array(z.string()),
    skills_removed: z.array(z.string()),
  }),
});
export type EvalCompare = z.infer<typeof EvalCompare>;

// ---- dashboards ----
export const EvalSparkPoint = z.object({
  run_id: z.string(),
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
});
export type EvalSparkPoint = z.infer<typeof EvalSparkPoint>;

export const EvalAgentOverview = z.object({
  agent_id: z.string(),
  name: z.string(),
  model: z.string(),
  cases_total: z.number().int(),
  latest: EvalRunSummary.nullable(),
  sparkline: z.array(EvalSparkPoint).max(10),
});
export type EvalAgentOverview = z.infer<typeof EvalAgentOverview>;

export const EvalRecentRun = EvalRunSummary.extend({ agent_name: z.string() });
export type EvalRecentRun = z.infer<typeof EvalRecentRun>;

export const EvalOverview = z.object({
  agents: z.array(EvalAgentOverview),
  recent_runs: z.array(EvalRecentRun).max(20),
});
export type EvalOverview = z.infer<typeof EvalOverview>;

export const EvalRegressionAlert = z.object({
  metrics: z.array(z.object({ metric: EvalMetricName, delta: z.number() })),
});
export type EvalRegressionAlert = z.infer<typeof EvalRegressionAlert>;

export const EvalAgentDashboard = z.object({
  agent_id: z.string(),
  cases_total: z.number().int(),
  latest: EvalRunSummary.nullable(),
  previous: EvalRunSummary.nullable(),
  trend: z.array(EvalRunSummary).max(20),
  alert: EvalRegressionAlert.nullable(),
});
export type EvalAgentDashboard = z.infer<typeof EvalAgentDashboard>;

// ---- run-all ----
export const EvalRunAllSkipReason = z.enum(['no_cases', 'run_active']);
export type EvalRunAllSkipReason = z.infer<typeof EvalRunAllSkipReason>;

export const EvalRunAllResponse = z.object({
  started: z.array(EvalRunSummary),
  skipped: z.array(z.object({ agent_id: z.string(), reason: EvalRunAllSkipReason })),
});
export type EvalRunAllResponse = z.infer<typeof EvalRunAllResponse>;
