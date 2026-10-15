/**
 * Evals data access (infrastructure; implements EvalCasesStore and EvalRunsStore). Owns
 * `eval_cases` for agent-owned cases and reads `eval_runs` / `eval_suite_runs` for each
 * case's last result; the finding source read joins findings → reviews → PR → repo →
 * stored patch. Suite-run SQL lives in `run-queries.ts`. Workspace-scoped throughout.
 * Case transactions are opened by the use case; `recordCase` owns its own (adapter-side).
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AgentEvalCase, EvalCaseLastResult, EvalRecentRun, EvalRunDetail, EvalRunSummary } from '@devdigest/shared';
import type { Db, DbOrTx } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type {
  EvalCasesReader,
  EvalCasesWriter,
  EvalRunsStore,
  InsertCaseResult,
  InsertRunResult,
} from '../application/ports.js';
import type { CompareSide } from '../domain/compare.js';
import type {
  AgentCaseCount,
  CaseRecord,
  EvalCaseWrite,
  FindingSource,
  NewEvalCase,
  NewSuiteRun,
  RunFinal,
  RunnableCase,
} from '../domain/types.js';
import { toAgentEvalCase, toFindingSource } from './mappers.js';
import { pgCode, UNIQUE_VIOLATION } from './pg-error.js';
import * as runQueries from './run-queries.js';

export class EvalsRepository implements EvalCasesReader, EvalCasesWriter, EvalRunsStore {
  constructor(private readonly db: DbOrTx) {}

  private agentCase(workspaceId: string, id: string) {
    return and(
      eq(t.evalCases.workspaceId, workspaceId),
      eq(t.evalCases.ownerKind, 'agent'),
      eq(t.evalCases.id, id),
    );
  }

  // ---- reads ----------------------------------------------------------------

  /** Per case: its result in the latest FINISHED suite run that contained it (one query). */
  private async lastResults(caseIds: string[]): Promise<Map<string, EvalCaseLastResult>> {
    if (caseIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([t.evalRuns.caseId], {
        caseId: t.evalRuns.caseId,
        runId: t.evalRuns.runId,
        status: t.evalRuns.status,
        ranAt: t.evalRuns.ranAt,
      })
      .from(t.evalRuns)
      .innerJoin(t.evalSuiteRuns, eq(t.evalSuiteRuns.id, t.evalRuns.runId))
      .where(
        and(
          inArray(t.evalRuns.caseId, caseIds),
          inArray(t.evalSuiteRuns.status, ['completed', 'failed']),
          isNotNull(t.evalRuns.status),
        ),
      )
      .orderBy(t.evalRuns.caseId, desc(t.evalSuiteRuns.finishedAt), desc(t.evalSuiteRuns.startedAt));
    const out = new Map<string, EvalCaseLastResult>();
    for (const r of rows) {
      if (r.runId && r.status) out.set(r.caseId, { run_id: r.runId, status: r.status, ran_at: r.ranAt.toISOString() });
    }
    return out;
  }

  async list(workspaceId: string, agentId: string): Promise<AgentEvalCase[]> {
    const rows = await this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          eq(t.evalCases.ownerId, agentId),
        ),
      )
      .orderBy(desc(t.evalCases.createdAt), desc(t.evalCases.id));
    const last = await this.lastResults(rows.map((r) => r.id));
    return rows.map((r) => toAgentEvalCase(r, last.get(r.id) ?? null));
  }

  async find(workspaceId: string, id: string): Promise<AgentEvalCase | undefined> {
    const [row] = await this.db.select().from(t.evalCases).where(this.agentCase(workspaceId, id));
    if (!row) return undefined;
    const last = await this.lastResults([row.id]);
    return toAgentEvalCase(row, last.get(row.id) ?? null);
  }

  async count(workspaceId: string, agentId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          eq(t.evalCases.ownerId, agentId),
        ),
      );
    return row?.n ?? 0;
  }

  async caseIdForFinding(workspaceId: string, findingId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ id: t.evalCases.id })
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.sourceFindingId, findingId)));
    return row?.id;
  }

  async findingSource(workspaceId: string, findingId: string): Promise<FindingSource | undefined> {
    const [row] = await this.db
      .select({
        findingId: t.findings.id,
        reviewId: t.reviews.id,
        prId: t.pullRequests.id,
        agentId: t.reviews.agentId,
        acceptedAt: t.findings.acceptedAt,
        dismissedAt: t.findings.dismissedAt,
        file: t.findings.file,
        startLine: t.findings.startLine,
        endLine: t.findings.endLine,
        severity: t.findings.severity,
        category: t.findings.category,
        title: t.findings.title,
        patch: t.prFiles.patch,
        prTitle: t.pullRequests.title,
        prBody: t.pullRequests.body,
        prNumber: t.pullRequests.number,
        headSha: t.pullRequests.headSha,
        repoFullName: t.repos.fullName,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.reviews.id, t.findings.reviewId))
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.reviews.prId))
      .innerJoin(t.repos, eq(t.repos.id, t.pullRequests.repoId))
      .leftJoin(t.prFiles, and(eq(t.prFiles.prId, t.pullRequests.id), eq(t.prFiles.path, t.findings.file)))
      .where(and(eq(t.findings.id, findingId), eq(t.pullRequests.workspaceId, workspaceId)));
    return row && toFindingSource(row);
  }

  // ---- writes ---------------------------------------------------------------

  async insert(values: NewEvalCase): Promise<InsertCaseResult> {
    try {
      const [row] = await this.db
        .insert(t.evalCases)
        .values({
          workspaceId: values.workspaceId,
          ownerKind: 'agent',
          ownerId: values.agentId,
          name: values.name,
          notes: values.notes,
          inputDiff: values.inputDiff,
          inputMeta: values.inputMeta,
          expectedOutput: values.expectation,
          sourceFindingId: values.sourceFindingId,
          sourceReviewId: values.sourceReviewId,
          sourcePrId: values.sourcePrId,
        })
        .returning();
      return { kind: 'created', case: toAgentEvalCase(row!, null) };
    } catch (err) {
      if (pgCode(err) !== UNIQUE_VIOLATION) throw err;
      // Lost the one-case-per-finding race (double click, two tabs): hand back the winner.
      const caseId = await this.caseIdForFinding(values.workspaceId, values.sourceFindingId);
      if (!caseId) throw err;
      return { kind: 'exists', caseId };
    }
  }

  async lockForUpdate(
    workspaceId: string,
    id: string,
  ): Promise<{ id: string; expectation: AgentEvalCase['expectation'] } | undefined> {
    const [row] = await this.db.select().from(t.evalCases).where(this.agentCase(workspaceId, id)).for('update');
    return row && { id: row.id, expectation: toAgentEvalCase(row, null).expectation };
  }

  async update(workspaceId: string, id: string, values: EvalCaseWrite): Promise<AgentEvalCase> {
    const set = {
      ...(values.name !== undefined ? { name: values.name } : {}),
      ...(values.notes !== undefined ? { notes: values.notes } : {}),
      ...(values.expectation !== undefined ? { expectedOutput: values.expectation } : {}),
    };
    if (Object.keys(set).length > 0) {
      await this.db.update(t.evalCases).set(set).where(this.agentCase(workspaceId, id));
    }
    const fresh = await this.find(workspaceId, id);
    if (!fresh) throw new Error(`eval case ${id} vanished inside its own transaction`);
    return fresh;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.evalCases)
      .where(this.agentCase(workspaceId, id))
      .returning({ id: t.evalCases.id });
    return rows.length > 0;
  }

  // ---- suite runs (SQL in run-queries.ts) -----------------------------------

  caseIds(workspaceId: string, agentId: string): Promise<string[]> {
    return runQueries.caseIds(this.db, workspaceId, agentId);
  }

  listRuns(workspaceId: string, agentId: string, limit: number): Promise<EvalRunSummary[]> {
    return runQueries.listRuns(this.db, workspaceId, agentId, limit);
  }

  getRun(workspaceId: string, id: string): Promise<EvalRunDetail | undefined> {
    return runQueries.getRun(this.db, workspaceId, id);
  }

  insertRun(values: NewSuiteRun): Promise<InsertRunResult> {
    return runQueries.insertRun(this.db, values);
  }

  reapRunning(error: string): Promise<number> {
    return runQueries.reapRunning(this.db, error);
  }

  loadCase(workspaceId: string, caseId: string): Promise<RunnableCase | undefined> {
    return runQueries.loadCase(this.db, workspaceId, caseId);
  }

  recordCase(runId: string, record: CaseRecord): Promise<'recorded' | 'case_gone'> {
    return runQueries.recordCase(this.db as Db, runId, record);
  }

  dropCase(runId: string): Promise<void> {
    return runQueries.dropCase(this.db, runId);
  }

  finish(runId: string, final: RunFinal): Promise<void> {
    return runQueries.finishRun(this.db, runId, final);
  }

  compareSide(workspaceId: string, id: string): Promise<CompareSide | undefined> {
    return runQueries.compareSide(this.db, workspaceId, id);
  }

  finishedRuns(workspaceId: string, agentId: string, limit: number): Promise<EvalRunSummary[]> {
    return runQueries.finishedRuns(this.db, workspaceId, agentId, limit);
  }

  finishedRunsByAgent(workspaceId: string, agentIds: string[], perAgent: number): Promise<Map<string, EvalRunSummary[]>> {
    return runQueries.finishedRunsByAgent(this.db, workspaceId, agentIds, perAgent);
  }

  agentsWithEvals(workspaceId: string): Promise<AgentCaseCount[]> {
    return runQueries.agentsWithEvals(this.db, workspaceId);
  }

  recentRuns(workspaceId: string, limit: number): Promise<EvalRecentRun[]> {
    return runQueries.recentRuns(this.db, workspaceId, limit);
  }
}
