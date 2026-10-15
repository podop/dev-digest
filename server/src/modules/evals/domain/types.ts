/** Eval pipeline domain types — plain data, no DB or HTTP knowledge. */
import type {
  EvalCaseInputMeta,
  EvalCaseStatus,
  EvalExpectation,
  EvalExpectationKind,
  EvalFindingMatch,
} from '@devdigest/shared';

/** Agent config frozen at run start (what the run's cases were executed with). */
export interface EvalRunConfig {
  provider: string;
  model: string;
  system_prompt: string;
  strategy: string;
  skills: Array<{ id: string; name: string; description: string; body: string; version: number }>;
}

/** A finding the engine kept (grounded), reduced to what scoring and display need. */
export interface KeptFinding {
  file: string;
  start_line: number;
  end_line: number;
  severity: string | null;
  category: string | null;
  title: string | null;
}

export type LabeledFinding = KeptFinding & { match: EvalFindingMatch };

/** Scoring of ONE case from its kept findings (the case is never `error` here). */
export interface CaseScore {
  status: Exclude<EvalCaseStatus, 'error'>;
  findings: LabeledFinding[];
  hit_count: number;
  violation_count: number;
  unlabeled_count: number;
}

/** What the run aggregate needs from one finished case. */
export interface CaseOutcome {
  kind: EvalExpectationKind;
  status: EvalCaseStatus;
  hit_count: number;
  violation_count: number;
  unlabeled_count: number;
  dropped_count: number;
  cost_usd: number | null;
  error: string | null;
}

/** Aggregate metrics of a run over its non-error cases; a metric with denominator 0 is null. */
export interface RunMetrics {
  recall: number | null;
  precision: number | null;
  citation_accuracy: number | null;
  cases_passed: number;
  cases_errored: number;
  unlabeled_findings: number;
  cost_usd: number | null;
}

export interface RunVerdict {
  status: 'completed' | 'failed';
  error: string | null;
}

/** A finding with everything needed to turn it into a case (one joined read). */
export interface FindingSource {
  findingId: string;
  reviewId: string;
  prId: string;
  /** The agent that produced the review; null for the seed review and deleted agents. */
  agentId: string | null;
  /** accepted / dismissed; null = undecided. */
  decision: 'accepted' | 'dismissed' | null;
  file: string;
  startLine: number;
  endLine: number;
  severity: string;
  category: string;
  title: string;
  /** Stored per-file patch of the PR for `file` (null/empty = binary or not fetched). */
  patch: string | null;
  prTitle: string;
  prBody: string | null;
  prNumber: number;
  headSha: string | null;
  repoFullName: string;
}

/** A case ready to insert (owner kind is always `agent`). */
export interface NewEvalCase {
  workspaceId: string;
  agentId: string;
  name: string;
  notes: string | null;
  expectation: EvalExpectation;
  inputDiff: string;
  inputMeta: EvalCaseInputMeta;
  sourceFindingId: string;
  sourceReviewId: string;
  sourcePrId: string;
}

/** Editable fields of a case; absent = keep. */
export interface EvalCaseWrite {
  name?: string;
  notes?: string | null;
  expectation?: EvalExpectation;
}

/** A case as the executor runs it: only the fixed inputs and the expectation. */
export interface RunnableCase {
  id: string;
  expectation: EvalExpectation;
  inputDiff: string;
  inputMeta: EvalCaseInputMeta;
}

/** One case's persisted result (`eval_runs` row), already scored. */
export interface CaseRecord {
  caseId: string;
  status: EvalCaseStatus;
  findings: LabeledFinding[];
  droppedCount: number;
  hitCount: number;
  violationCount: number;
  unlabeledCount: number;
  durationMs: number;
  /** Summed engine usage cost; null = no usage reported or an unpriced model. */
  costUsd: number | null;
  error: string | null;
}

/** A suite run ready to insert as `running`. */
export interface NewSuiteRun {
  workspaceId: string;
  agentId: string;
  agentVersion: number;
  config: EvalRunConfig;
  caseIds: string[];
}

/** Terminal state of a suite run. */
export interface RunFinal {
  status: 'completed' | 'failed';
  error: string | null;
  metrics: RunMetrics;
  durationMs: number;
}

/** Everything the background executor needs to run one started suite run. */
export interface RunJob {
  runId: string;
  workspaceId: string;
  agentId: string;
  agentVersion: number;
  config: EvalRunConfig;
  caseIds: string[];
}

/** An agent of the dashboard overview with how many eval cases it owns. */
export interface AgentCaseCount {
  agentId: string;
  name: string;
  model: string;
  casesTotal: number;
}
