/** eval_cases row → contract DTO mappers (infrastructure: they know the row shapes). */
import { EvalCaseInputMeta, EvalExpectation, EvalResultFinding } from '@devdigest/shared';
import type { AgentEvalCase, EvalCaseLastResult, EvalCaseResult, EvalRunSummary } from '@devdigest/shared';
import type * as t from '../../../db/schema.js';
import type { FindingSource, RunnableCase } from '../domain/types.js';

type EvalCaseRow = typeof t.evalCases.$inferSelect;

/** Agent cases are written only by this module, so the JSON columns hold valid contract shapes. */
export function toAgentEvalCase(row: EvalCaseRow, lastResult: EvalCaseLastResult | null): AgentEvalCase {
  return {
    id: row.id,
    agent_id: row.ownerId,
    name: row.name,
    notes: row.notes ?? null,
    expectation: EvalExpectation.parse(row.expectedOutput),
    input_diff: row.inputDiff ?? '',
    input_meta: EvalCaseInputMeta.parse(row.inputMeta),
    source_finding_id: row.sourceFindingId ?? null,
    source_pr_id: row.sourcePrId ?? null,
    created_at: row.createdAt.toISOString(),
    last_result: lastResult,
  };
}

interface FindingSourceRow {
  findingId: string;
  reviewId: string;
  prId: string;
  agentId: string | null;
  acceptedAt: Date | null;
  dismissedAt: Date | null;
  file: string;
  startLine: number;
  endLine: number;
  severity: string;
  category: string;
  title: string;
  patch: string | null;
  prTitle: string;
  prBody: string | null;
  prNumber: number;
  headSha: string | null;
  repoFullName: string;
}

export function toFindingSource(row: FindingSourceRow): FindingSource {
  const { acceptedAt, dismissedAt, ...rest } = row;
  return { ...rest, decision: acceptedAt ? 'accepted' : dismissedAt ? 'dismissed' : null };
}

export function toRunnableCase(row: EvalCaseRow): RunnableCase {
  return {
    id: row.id,
    expectation: EvalExpectation.parse(row.expectedOutput),
    inputDiff: row.inputDiff ?? '',
    inputMeta: EvalCaseInputMeta.parse(row.inputMeta),
  };
}

type SuiteRunRow = typeof t.evalSuiteRuns.$inferSelect;

export function toRunSummary(row: SuiteRunRow): EvalRunSummary {
  return {
    id: row.id,
    agent_id: row.agentId,
    agent_version: row.agentVersion,
    model: row.config.model,
    status: row.status,
    started_at: row.startedAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
    cases_total: row.casesTotal,
    cases_finished: row.casesFinished,
    cases_passed: row.casesPassed,
    cases_errored: row.casesErrored,
    recall: row.recall,
    precision: row.precision,
    citation_accuracy: row.citationAccuracy,
    unlabeled_findings: row.unlabeledFindings,
    cost_usd: row.costUsd,
    duration_ms: row.durationMs,
    error: row.error,
  };
}

/** `eval_runs.actual_output` holds the case's labelled kept findings (an `EvalResultFinding[]`). */
type ResultRow = Pick<
  typeof t.evalRuns.$inferSelect,
  'caseId' | 'status' | 'actualOutput' | 'droppedCount' | 'durationMs' | 'costUsd' | 'error'
> &
  Pick<EvalCaseRow, 'name' | 'expectedOutput'>;

export function toCaseResult(row: ResultRow): EvalCaseResult {
  return {
    case_id: row.caseId,
    case_name: row.name,
    expectation: EvalExpectation.parse(row.expectedOutput),
    // Rows of a suite run always have a status (only legacy single-case rows lack it).
    status: row.status ?? 'error',
    findings: EvalResultFinding.array().parse(row.actualOutput ?? []),
    dropped_count: row.droppedCount,
    duration_ms: row.durationMs ?? 0,
    cost_usd: row.costUsd,
    error: row.error,
  };
}
