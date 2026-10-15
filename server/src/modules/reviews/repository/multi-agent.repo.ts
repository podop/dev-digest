import { and, desc, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { AgentColumn, FindingRecord } from '@devdigest/shared';
import type { DbOrTx } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { LearnTarget, LearnWrites, MultiAgentStore, NewLearnedMemory } from '../application/ports.js';
import { ESTIMATE_SAMPLE_SIZE } from '../domain/constants.js';
import { learnContext } from '../domain/multi-agent.js';
import type {
  AgentEstimateRow,
  MultiAgentRunHeader,
  MultiAgentRunListRow,
} from '../domain/multi-agent.js';
import { toFindingRecord } from './mappers.js';
import { evalCaseIdsByFinding } from './review.repo.js';

function byPosition(a: FindingRecord, b: FindingRecord): number {
  return (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.start_line - b.start_line || (a.id < b.id ? -1 : 1);
}

/** The `context` strings of a memory row's jsonb `sources` (any other shape → none). */
function sourceContexts(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((s: unknown) =>
    typeof s === 'object' && s !== null && 'context' in s && typeof s.context === 'string' ? [s.context] : [],
  );
}

/**
 * Multi-agent read model + Learn writes (infrastructure; implements
 * MultiAgentStore and the transaction-bound LearnWrites). Runs are selected
 * ONLY through `agent_runs.multi_agent_run_id`, so CI runs never appear.
 */
export class MultiAgentRepository implements MultiAgentStore, LearnWrites {
  constructor(private readonly db: DbOrTx) {}

  async getMultiAgentRun(workspaceId: string, id: string): Promise<MultiAgentRunHeader | undefined> {
    const [row] = await this.db
      .select({
        id: t.multiAgentRuns.id,
        prId: t.multiAgentRuns.prId,
        repoId: t.pullRequests.repoId,
        prNumber: t.pullRequests.number,
        prTitle: t.pullRequests.title,
        ranAt: t.multiAgentRuns.ranAt,
      })
      .from(t.multiAgentRuns)
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.multiAgentRuns.prId))
      .where(and(eq(t.multiAgentRuns.id, id), eq(t.multiAgentRuns.workspaceId, workspaceId)));
    return row;
  }

  /** One column per linked run (unordered): the run, its review (by run_id) and all that review's findings. */
  async columnsForMultiAgentRun(workspaceId: string, multiAgentRunId: string): Promise<AgentColumn[]> {
    const runs = await this.db
      .select({ run: t.agentRuns, agentName: t.agents.name })
      .from(t.agentRuns)
      .leftJoin(t.agents, eq(t.agents.id, t.agentRuns.agentId))
      .where(and(eq(t.agentRuns.multiAgentRunId, multiAgentRunId), eq(t.agentRuns.workspaceId, workspaceId)));
    if (runs.length === 0) return [];

    const reviewRows = await this.db
      .select()
      .from(t.reviews)
      .where(
        and(
          inArray(
            t.reviews.runId,
            runs.map((r) => r.run.id),
          ),
          eq(t.reviews.kind, 'review'),
        ),
      )
      .orderBy(desc(t.reviews.createdAt));
    // A run has one review; the newest wins should that ever change.
    const reviewByRun = new Map<string, (typeof reviewRows)[number]>();
    for (const review of reviewRows) if (review.runId && !reviewByRun.has(review.runId)) reviewByRun.set(review.runId, review);

    const reviewIds = [...reviewByRun.values()].map((r) => r.id);
    const findingRows =
      reviewIds.length === 0 ? [] : await this.db.select().from(t.findings).where(inArray(t.findings.reviewId, reviewIds));
    const findingIds = findingRows.map((f) => f.id);
    const evalCaseIds = await evalCaseIdsByFinding(this.db, findingIds);
    const memoryIds = await this.memoryIdsForFindings(workspaceId, findingIds);

    return runs.map(({ run, agentName }) => {
      const review = reviewByRun.get(run.id);
      const findings = findingRows
        .filter((f) => f.reviewId === review?.id)
        .map((f) => ({ ...toFindingRecord(f, evalCaseIds.get(f.id) ?? null), memory_id: memoryIds.get(f.id) ?? null }))
        .sort(byPosition);
      return {
        run_id: run.id,
        // A deleted agent leaves no stored name: '' (the client labels it).
        agent_id: run.agentId ?? '',
        agent_name: agentName ?? '',
        provider: run.provider,
        model: run.model,
        status: run.status ?? 'failed',
        error: run.error,
        verdict: review?.verdict ?? null,
        score: review?.score ?? run.score,
        summary: review?.summary ?? null,
        duration_ms: run.durationMs,
        cost_usd: run.costUsd,
        findings,
      };
    });
  }

  async repoInWorkspace(workspaceId: string, repoId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: t.repos.id })
      .from(t.repos)
      .where(and(eq(t.repos.id, repoId), eq(t.repos.workspaceId, workspaceId)));
    return row !== undefined;
  }

  async listMultiAgentRuns(workspaceId: string, repoId: string, limit: number): Promise<MultiAgentRunListRow[]> {
    // count/sum come back as bigint/numeric strings → cast in SQL (::int, ::float8).
    return this.db
      .select({
        id: t.multiAgentRuns.id,
        prId: t.multiAgentRuns.prId,
        prNumber: t.pullRequests.number,
        prTitle: t.pullRequests.title,
        ranAt: t.multiAgentRuns.ranAt,
        agentCount: sql<number>`count(${t.agentRuns.id})::int`,
        runningCount: sql<number>`(count(${t.agentRuns.id}) filter (where ${t.agentRuns.status} = 'running'))::int`,
        totalCostUsd: sql<number | null>`sum(${t.agentRuns.costUsd})::float8`,
      })
      .from(t.multiAgentRuns)
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.multiAgentRuns.prId))
      .leftJoin(t.agentRuns, eq(t.agentRuns.multiAgentRunId, t.multiAgentRuns.id))
      .where(and(eq(t.multiAgentRuns.workspaceId, workspaceId), eq(t.pullRequests.repoId, repoId)))
      .groupBy(t.multiAgentRuns.id, t.pullRequests.number, t.pullRequests.title)
      .orderBy(desc(t.multiAgentRuns.ranAt), t.multiAgentRuns.id)
      .limit(limit);
  }

  /** Per agent: averages over its newest `done` runs (any PR, any source) that have a duration or cost. */
  async agentRunEstimates(workspaceId: string): Promise<AgentEstimateRow[]> {
    const ranked = this.db
      .select({
        agentId: t.agentRuns.agentId,
        durationMs: t.agentRuns.durationMs,
        costUsd: t.agentRuns.costUsd,
        rn: sql<number>`row_number() over (partition by ${t.agentRuns.agentId} order by ${t.agentRuns.ranAt} desc, ${t.agentRuns.id})`.as(
          'rn',
        ),
      })
      .from(t.agentRuns)
      .where(
        and(
          eq(t.agentRuns.workspaceId, workspaceId),
          eq(t.agentRuns.status, 'done'),
          isNotNull(t.agentRuns.agentId),
          or(isNotNull(t.agentRuns.durationMs), isNotNull(t.agentRuns.costUsd)),
        ),
      )
      .as('ranked');
    const rows = await this.db
      .select({
        agentId: ranked.agentId,
        sampleSize: sql<number>`count(*)::int`,
        avgDurationMs: sql<number | null>`avg(${ranked.durationMs})::float8`,
        avgCostUsd: sql<number | null>`avg(${ranked.costUsd})::float8`,
      })
      .from(ranked)
      .where(lte(ranked.rn, ESTIMATE_SAMPLE_SIZE))
      .groupBy(ranked.agentId);
    return rows.flatMap((r) => (r.agentId ? [{ ...r, agentId: r.agentId }] : []));
  }

  // ---- Learn -----------------------------------------------------------------

  /** The finding with its PR context (undefined = no such finding); the caller checks the workspace. */
  async findingForLearn(findingId: string): Promise<LearnTarget | undefined> {
    const [row] = await this.db
      .select({
        finding: t.findings,
        workspaceId: t.pullRequests.workspaceId,
        repoId: t.pullRequests.repoId,
        prNumber: t.pullRequests.number,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.reviews.id, t.findings.reviewId))
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.reviews.prId))
      .where(eq(t.findings.id, findingId));
    if (!row) return undefined;
    const evalCaseId = (await evalCaseIdsByFinding(this.db, [findingId])).get(findingId) ?? null;
    return {
      finding: toFindingRecord(row.finding, evalCaseId),
      workspaceId: row.workspaceId,
      repoId: row.repoId,
      prNumber: row.prNumber,
    };
  }

  /** Transaction-scoped advisory lock per finding (released on commit/rollback). */
  async lockLearn(findingId: string): Promise<void> {
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`learn:${findingId}`}, 0))`);
  }

  /** Memory entry created by Learn for each given finding (finding id → memory id); one IN-style query. */
  async memoryIdsForFindings(workspaceId: string, findingIds: string[]): Promise<Map<string, string>> {
    if (findingIds.length === 0) return new Map();
    const keys = sql.join(
      findingIds.map((id) => sql`${JSON.stringify([{ context: learnContext(id) }])}::jsonb`),
      sql`, `,
    );
    const rows = await this.db
      .select({ id: t.memory.id, sources: t.memory.sources })
      .from(t.memory)
      .where(
        and(
          eq(t.memory.workspaceId, workspaceId),
          eq(t.memory.kind, 'learning'),
          sql`${t.memory.sources} @> ANY (ARRAY[${keys}])`,
        ),
      )
      .orderBy(t.memory.createdAt, t.memory.id);
    const byContext = new Map<string, string>();
    for (const row of rows) for (const ctx of sourceContexts(row.sources)) if (!byContext.has(ctx)) byContext.set(ctx, row.id);
    return new Map(findingIds.flatMap((id) => {
      const memoryId = byContext.get(learnContext(id));
      return memoryId ? [[id, memoryId] as const] : [];
    }));
  }

  async insertLearnedMemory(values: NewLearnedMemory): Promise<string> {
    const [row] = await this.db
      .insert(t.memory)
      .values({
        workspaceId: values.workspaceId,
        repoId: values.repoId,
        scope: 'repo',
        kind: 'learning',
        content: values.content,
        confidence: values.confidence,
        sources: [{ pr: values.prNumber, context: learnContext(values.findingId) }],
      })
      .returning({ id: t.memory.id });
    return row!.id;
  }
}
