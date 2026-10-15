import type { Finding, FindingRecord, Verdict } from '@devdigest/shared';
import type { FindingRow } from '../../../db/rows.js';
import type * as t from '../../../db/schema.js';
import type { StoredReview } from '../domain/review.js';

type ReviewRow = typeof t.reviews.$inferSelect;

/** findings row → the FindingRecord wire contract; `evalCaseId` = the eval case created from it (null = none). */
export function toFindingRecord(row: FindingRow, evalCaseId: string | null = null): FindingRecord {
  return {
    id: row.id,
    severity: row.severity as Finding['severity'],
    category: row.category as Finding['category'],
    title: row.title,
    file: row.file,
    start_line: row.startLine,
    end_line: row.endLine,
    rationale: row.rationale,
    suggestion: row.suggestion ?? null,
    confidence: row.confidence,
    kind: (row.kind as Finding['kind']) ?? 'finding',
    trifecta_components: (row.trifectaComponents as Finding['trifecta_components']) ?? null,
    evidence: null,
    skill: row.skillName ?? null,
    out_of_scope: row.outOfScope,
    review_id: row.reviewId,
    accepted_at: row.acceptedAt?.toISOString() ?? null,
    dismissed_at: row.dismissedAt?.toISOString() ?? null,
    eval_case_id: evalCaseId,
  };
}

/** reviews row + its findings → a StoredReview (agent name / usage joined later). */
export function toStoredReview(
  review: ReviewRow,
  findings: FindingRow[],
  evalCaseIds: ReadonlyMap<string, string> = new Map(),
): StoredReview {
  return {
    id: review.id,
    pr_id: review.prId,
    agent_id: review.agentId,
    run_id: review.runId,
    kind: review.kind as StoredReview['kind'],
    verdict: review.verdict as Verdict | null,
    summary: review.summary,
    score: review.score,
    model: review.model,
    created_at: review.createdAt.toISOString(),
    findings: findings.map((f) => toFindingRecord(f, evalCaseIds.get(f.id) ?? null)),
  };
}
