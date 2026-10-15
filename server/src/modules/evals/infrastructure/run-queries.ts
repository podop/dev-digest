/**
 * Suite-run queries of the evals module (infrastructure): `eval_suite_runs` plus the
 * per-case `eval_runs` rows. Plain functions over a db handle; `EvalsRepository`
 * delegates to them. Workspace-scoped wherever an id comes from the client.
 */
import { and, desc, eq, getTableColumns, gte, inArray, lte, sql } from 'drizzle-orm';
import type { EvalRecentRun, EvalRunDetail, EvalRunSummary } from '@devdigest/shared';
import type { Db, DbOrTx } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { InsertRunResult } from '../application/ports.js';
import type { CompareSide } from '../domain/compare.js';
import type { AgentCaseCount, CaseOwner, CaseRecord, NewSuiteRun, RunFinal, RunnableCase } from '../domain/types.js';
import { toCaseResult, toRunnableCase, toRunSummary } from './mappers.js';
import { FOREIGN_KEY_VIOLATION, pgCode, UNIQUE_VIOLATION } from './pg-error.js';

const FINISHED = ['completed', 'failed'] as const;

// ---- reads ------------------------------------------------------------------

export async function caseIds(db: DbOrTx, workspaceId: string, owner: CaseOwner): Promise<string[]> {
  const rows = await db
    .select({ id: t.evalCases.id })
    .from(t.evalCases)
    .where(
      and(
        eq(t.evalCases.workspaceId, workspaceId),
        eq(t.evalCases.ownerKind, owner.kind),
        eq(t.evalCases.ownerId, owner.id),
      ),
    )
    .orderBy(t.evalCases.createdAt, t.evalCases.id);
  return rows.map((r) => r.id);
}

/** The runs one owner started: an agent's own runs (never the skill runs it hosts) or a skill's runs. */
function ownedRuns(owner: CaseOwner) {
  return owner.kind === 'skill'
    ? and(eq(t.evalSuiteRuns.ownerKind, 'skill'), eq(t.evalSuiteRuns.skillId, owner.id))
    : and(eq(t.evalSuiteRuns.ownerKind, 'agent'), eq(t.evalSuiteRuns.agentId, owner.id));
}

export async function listRuns(
  db: DbOrTx,
  workspaceId: string,
  owner: CaseOwner,
  limit: number,
  since?: Date,
): Promise<EvalRunSummary[]> {
  const rows = await db
    .select()
    .from(t.evalSuiteRuns)
    .where(
      and(
        eq(t.evalSuiteRuns.workspaceId, workspaceId),
        ownedRuns(owner),
        since ? gte(t.evalSuiteRuns.startedAt, since) : undefined,
      ),
    )
    .orderBy(desc(t.evalSuiteRuns.startedAt), desc(t.evalSuiteRuns.id))
    .limit(limit);
  return rows.map(toRunSummary);
}

async function runRow(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(t.evalSuiteRuns)
    .where(and(eq(t.evalSuiteRuns.workspaceId, workspaceId), eq(t.evalSuiteRuns.id, id)));
  return row;
}

/** A run's per-case results in execution order (each joined with its case's name + expectation). */
async function resultRows(db: DbOrTx, runId: string) {
  return db
    .select({
      caseId: t.evalRuns.caseId,
      status: t.evalRuns.status,
      actualOutput: t.evalRuns.actualOutput,
      droppedCount: t.evalRuns.droppedCount,
      durationMs: t.evalRuns.durationMs,
      costUsd: t.evalRuns.costUsd,
      error: t.evalRuns.error,
      name: t.evalCases.name,
      expectedOutput: t.evalCases.expectedOutput,
    })
    .from(t.evalRuns)
    .innerJoin(t.evalCases, eq(t.evalCases.id, t.evalRuns.caseId))
    .where(eq(t.evalRuns.runId, runId))
    .orderBy(t.evalRuns.ranAt, t.evalRuns.id);
}

export async function getRun(db: DbOrTx, workspaceId: string, id: string): Promise<EvalRunDetail | undefined> {
  const row = await runRow(db, workspaceId, id);
  if (!row) return undefined;
  return { run: toRunSummary(row), results: (await resultRows(db, row.id)).map(toCaseResult) };
}

export async function compareSide(db: DbOrTx, workspaceId: string, id: string): Promise<CompareSide | undefined> {
  const row = await runRow(db, workspaceId, id);
  if (!row) return undefined;
  const results = (await resultRows(db, row.id)).map(toCaseResult);
  return {
    run: toRunSummary(row),
    config: row.config,
    results: results.map((r) => ({ case_id: r.case_id, case_name: r.case_name, status: r.status })),
  };
}

export async function loadCase(db: DbOrTx, workspaceId: string, caseId: string): Promise<RunnableCase | undefined> {
  const [row] = await db
    .select()
    .from(t.evalCases)
    .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, caseId)));
  return row && toRunnableCase(row);
}

// ---- dashboards ---------------------------------------------------------------

export async function finishedRuns(
  db: DbOrTx,
  workspaceId: string,
  agentId: string,
  limit: number,
  since?: Date,
): Promise<EvalRunSummary[]> {
  const rows = await db
    .select()
    .from(t.evalSuiteRuns)
    .where(
      and(
        eq(t.evalSuiteRuns.workspaceId, workspaceId),
        ownedRuns({ kind: 'agent', id: agentId }),
        inArray(t.evalSuiteRuns.status, FINISHED),
        since ? gte(t.evalSuiteRuns.startedAt, since) : undefined,
      ),
    )
    .orderBy(desc(t.evalSuiteRuns.startedAt), desc(t.evalSuiteRuns.id))
    .limit(limit);
  return rows.map(toRunSummary);
}

export async function finishedRunsByAgent(
  db: DbOrTx,
  workspaceId: string,
  agentIds: string[],
  perAgent: number,
): Promise<Map<string, EvalRunSummary[]>> {
  const out = new Map<string, EvalRunSummary[]>();
  if (agentIds.length === 0) return out;
  const ranked = db
    .select({
      id: t.evalSuiteRuns.id,
      rank: sql<number>`row_number() over (partition by ${t.evalSuiteRuns.agentId} order by ${t.evalSuiteRuns.startedAt} desc, ${t.evalSuiteRuns.id} desc)`.as(
        'rank',
      ),
    })
    .from(t.evalSuiteRuns)
    .where(
      and(
        eq(t.evalSuiteRuns.workspaceId, workspaceId),
        eq(t.evalSuiteRuns.ownerKind, 'agent'),
        inArray(t.evalSuiteRuns.agentId, agentIds),
        inArray(t.evalSuiteRuns.status, FINISHED),
      ),
    )
    .as('ranked');
  const rows = await db
    .select(getTableColumns(t.evalSuiteRuns))
    .from(t.evalSuiteRuns)
    .innerJoin(ranked, eq(ranked.id, t.evalSuiteRuns.id))
    .where(lte(ranked.rank, perAgent))
    .orderBy(desc(t.evalSuiteRuns.startedAt), desc(t.evalSuiteRuns.id));
  for (const row of rows) {
    const list = out.get(row.agentId) ?? [];
    list.push(toRunSummary(row));
    out.set(row.agentId, list);
  }
  return out;
}

export async function agentsWithEvals(db: DbOrTx, workspaceId: string): Promise<AgentCaseCount[]> {
  const counts = await db
    .select({ agentId: t.evalCases.ownerId, n: sql<number>`count(*)::int` })
    .from(t.evalCases)
    .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.ownerKind, 'agent')))
    .groupBy(t.evalCases.ownerId);
  const casesByAgent = new Map(counts.map((c) => [c.agentId, c.n]));
  const agents = await db
    .select({ id: t.agents.id, name: t.agents.name, model: t.agents.model })
    .from(t.agents)
    .where(
      and(
        eq(t.agents.workspaceId, workspaceId),
        sql`(exists (select 1 from ${t.evalCases} where ${t.evalCases.ownerKind} = 'agent' and ${t.evalCases.ownerId} = ${t.agents.id})
          or exists (select 1 from ${t.evalSuiteRuns} where ${t.evalSuiteRuns.ownerKind} = 'agent' and ${t.evalSuiteRuns.agentId} = ${t.agents.id}))`,
      ),
    )
    .orderBy(t.agents.name, t.agents.id);
  return agents.map((a) => ({ agentId: a.id, name: a.name, model: a.model, casesTotal: casesByAgent.get(a.id) ?? 0 }));
}

export async function recentRuns(db: DbOrTx, workspaceId: string, limit: number): Promise<EvalRecentRun[]> {
  const rows = await db
    .select({ run: getTableColumns(t.evalSuiteRuns), agentName: t.agents.name })
    .from(t.evalSuiteRuns)
    .innerJoin(t.agents, eq(t.agents.id, t.evalSuiteRuns.agentId))
    .where(and(eq(t.evalSuiteRuns.workspaceId, workspaceId), eq(t.evalSuiteRuns.ownerKind, 'agent')))
    .orderBy(desc(t.evalSuiteRuns.startedAt), desc(t.evalSuiteRuns.id))
    .limit(limit);
  return rows.map((r) => ({ ...toRunSummary(r.run), agent_name: r.agentName }));
}

// ---- writes -------------------------------------------------------------------

export async function insertRun(db: DbOrTx, values: NewSuiteRun): Promise<InsertRunResult> {
  try {
    const [row] = await db
      .insert(t.evalSuiteRuns)
      .values({
        workspaceId: values.workspaceId,
        ownerKind: values.ownerKind,
        skillId: values.skillId,
        skillVersion: values.skillVersion,
        agentId: values.agentId,
        agentVersion: values.agentVersion,
        agentName: values.agentName,
        config: values.config,
        caseIds: values.caseIds,
        status: 'running',
        casesTotal: values.caseIds.length,
      })
      .returning();
    return { kind: 'created', run: toRunSummary(row!) };
  } catch (err) {
    // The partial unique indexes allow one `running` run per owner (agent or skill).
    if (pgCode(err) === UNIQUE_VIOLATION) return { kind: 'active' };
    throw err;
  }
}

export async function reapRunning(db: DbOrTx, error: string): Promise<number> {
  const rows = await db
    .update(t.evalSuiteRuns)
    .set({ status: 'failed', error, finishedAt: sql`now()` })
    .where(eq(t.evalSuiteRuns.status, 'running'))
    .returning({ id: t.evalSuiteRuns.id });
  return rows.length;
}

/** Store one case result and advance the run's counters in ONE transaction; an FK violation (case or run deleted meanwhile) stores nothing. */
export async function recordCase(db: Db, runId: string, record: CaseRecord): Promise<'recorded' | 'case_gone'> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(t.evalRuns).values({
        runId,
        caseId: record.caseId,
        status: record.status,
        pass: record.status === 'passed',
        actualOutput: record.findings,
        droppedCount: record.droppedCount,
        hitCount: record.hitCount,
        violationCount: record.violationCount,
        unlabeledCount: record.unlabeledCount,
        durationMs: record.durationMs,
        costUsd: record.costUsd,
        error: record.error,
      });
      await tx
        .update(t.evalSuiteRuns)
        .set({
          casesFinished: sql`${t.evalSuiteRuns.casesFinished} + 1`,
          casesPassed: sql`${t.evalSuiteRuns.casesPassed} + ${record.status === 'passed' ? 1 : 0}`,
          casesErrored: sql`${t.evalSuiteRuns.casesErrored} + ${record.status === 'error' ? 1 : 0}`,
        })
        .where(eq(t.evalSuiteRuns.id, runId));
    });
    return 'recorded';
  } catch (err) {
    if (pgCode(err) === FOREIGN_KEY_VIOLATION) return 'case_gone';
    throw err;
  }
}

export async function dropCase(db: DbOrTx, runId: string): Promise<void> {
  await db
    .update(t.evalSuiteRuns)
    .set({ casesTotal: sql`greatest(${t.evalSuiteRuns.casesTotal} - 1, 0)` })
    .where(eq(t.evalSuiteRuns.id, runId));
}

/** Terminal state; only a still-`running` run is written (a reaped run keeps its reason). */
export async function finishRun(db: DbOrTx, runId: string, final: RunFinal): Promise<void> {
  const { metrics } = final;
  await db
    .update(t.evalSuiteRuns)
    .set({
      status: final.status,
      error: final.error,
      finishedAt: sql`now()`,
      durationMs: final.durationMs,
      recall: metrics.recall,
      precision: metrics.precision,
      citationAccuracy: metrics.citation_accuracy,
      casesPassed: metrics.cases_passed,
      casesErrored: metrics.cases_errored,
      unlabeledFindings: metrics.unlabeled_findings,
      costUsd: metrics.cost_usd,
    })
    .where(and(eq(t.evalSuiteRuns.id, runId), eq(t.evalSuiteRuns.status, 'running')));
}
