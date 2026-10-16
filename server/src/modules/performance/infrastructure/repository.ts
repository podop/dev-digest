/**
 * Performance data access (infrastructure; implements PerformanceReader).
 * SELECT only. Reads `agents`, `agent_runs`, `reviews`, `findings`,
 * `agent_run_skills`/`skills` and `run_traces.memory_pulled`,
 * workspace-scoped; one filter defines a "counted run" for runs and findings.
 */
import { and, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { RunHistoryItem } from '@devdigest/shared';
import type { DbOrTx } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { PerformanceReader } from '../application/ports.js';
import { COUNTED_SOURCES, COUNTED_STATUSES } from '../domain/constants.js';
import type { AgentRef, FindingCounts, RunFact } from '../domain/metrics.js';
import type { PeriodWindow } from '../domain/period.js';
import type { FindingFact, SkillFact } from '../domain/trends.js';

type CountedStatus = RunFact['status'];

/** The SQL filter has already restricted the status; this narrows the nullable column. */
function isCountedStatus(s: string | null): s is CountedStatus {
  return s === 'done' || s === 'failed' || s === 'cancelled';
}

export class PerformanceRepository implements PerformanceReader {
  constructor(private readonly db: DbOrTx) {}

  /** The counted-run filter: workspace, status, source, window, optional agent. */
  private counted(workspaceId: string, win: PeriodWindow, agentId?: string): SQL {
    const conditions: SQL[] = [
      eq(t.agentRuns.workspaceId, workspaceId),
      inArray(t.agentRuns.status, [...COUNTED_STATUSES]),
      inArray(t.agentRuns.source, [...COUNTED_SOURCES]),
      gte(t.agentRuns.ranAt, win.from),
      win.toInclusive ? lte(t.agentRuns.ranAt, win.to) : lt(t.agentRuns.ranAt, win.to),
    ];
    if (agentId !== undefined) conditions.push(eq(t.agentRuns.agentId, agentId));
    return and(...conditions)!;
  }

  async listAgents(workspaceId: string): Promise<AgentRef[]> {
    return this.db.select({ id: t.agents.id, name: t.agents.name }).from(t.agents).where(eq(t.agents.workspaceId, workspaceId));
  }

  async findAgent(workspaceId: string, id: string): Promise<AgentRef | undefined> {
    const [row] = await this.db
      .select({ id: t.agents.id, name: t.agents.name })
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)));
    return row;
  }

  async countedRuns(workspaceId: string, win: PeriodWindow, agentId?: string): Promise<RunFact[]> {
    const rows = await this.db
      .select({
        agentId: t.agentRuns.agentId,
        status: t.agentRuns.status,
        source: t.agentRuns.source,
        model: t.agentRuns.model,
        durationMs: t.agentRuns.durationMs,
        costUsd: t.agentRuns.costUsd,
        ranAt: t.agentRuns.ranAt,
      })
      .from(t.agentRuns)
      .where(this.counted(workspaceId, win, agentId));
    return rows.flatMap(({ status, ...rest }) => (isCountedStatus(status) ? [{ ...rest, status }] : []));
  }

  async findingCounts(workspaceId: string, win: PeriodWindow, agentId?: string): Promise<FindingCounts[]> {
    // Accept clears dismissed_at and vice versa; an accepted finding wins if both were ever set.
    return this.db
      .select({
        agentId: t.agentRuns.agentId,
        total: sql<number>`count(*)::int`,
        accepted: sql<number>`(count(*) filter (where ${t.findings.acceptedAt} is not null))::int`,
        dismissed: sql<number>`(count(*) filter (where ${t.findings.dismissedAt} is not null and ${t.findings.acceptedAt} is null))::int`,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.reviews.id, t.findings.reviewId))
      .innerJoin(t.agentRuns, eq(t.agentRuns.id, t.reviews.runId))
      .where(this.counted(workspaceId, win, agentId))
      .groupBy(t.agentRuns.agentId);
  }

  async findingFacts(workspaceId: string, win: PeriodWindow, agentId: string): Promise<FindingFact[]> {
    return this.db
      .select({
        ranAt: t.agentRuns.ranAt,
        severity: t.findings.severity,
        category: t.findings.category,
        count: sql<number>`count(*)::int`,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.reviews.id, t.findings.reviewId))
      .innerJoin(t.agentRuns, eq(t.agentRuns.id, t.reviews.runId))
      .where(this.counted(workspaceId, win, agentId))
      .groupBy(t.agentRuns.id, t.agentRuns.ranAt, t.findings.severity, t.findings.category);
  }

  async skillUsage(workspaceId: string, win: PeriodWindow, agentId: string): Promise<SkillFact[]> {
    return this.db
      .select({
        skillId: t.skills.id,
        name: t.skills.name,
        runs: sql<number>`count(distinct ${t.agentRunSkills.runId})::int`,
      })
      .from(t.agentRunSkills)
      .innerJoin(t.agentRuns, eq(t.agentRuns.id, t.agentRunSkills.runId))
      .innerJoin(t.skills, eq(t.skills.id, t.agentRunSkills.skillId))
      .where(this.counted(workspaceId, win, agentId))
      .groupBy(t.skills.id, t.skills.name);
  }

  async memoryPulled(workspaceId: string, win: PeriodWindow, agentId: string): Promise<unknown[]> {
    // Only the small memory_pulled array leaves the database, not the whole trace document.
    const rows = await this.db
      .select({ pulled: sql<unknown>`${t.runTraces.trace} -> 'memory_pulled'` })
      .from(t.runTraces)
      .innerJoin(t.agentRuns, eq(t.agentRuns.id, t.runTraces.runId))
      .where(this.counted(workspaceId, win, agentId));
    return rows.map((r) => r.pulled);
  }

  async runHistory(workspaceId: string, win: PeriodWindow, agentId: string, limit: number): Promise<RunHistoryItem[]> {
    const rows = await this.db
      .select({
        runId: t.agentRuns.id,
        ranAt: t.agentRuns.ranAt,
        status: t.agentRuns.status,
        source: t.agentRuns.source,
        prId: t.pullRequests.id,
        repoId: t.pullRequests.repoId,
        prNumber: t.pullRequests.number,
        tokensIn: t.agentRuns.tokensIn,
        tokensOut: t.agentRuns.tokensOut,
        costUsd: t.agentRuns.costUsd,
        findingsCount: t.agentRuns.findingsCount,
        traceRunId: t.runTraces.runId,
      })
      .from(t.agentRuns)
      .leftJoin(t.pullRequests, eq(t.pullRequests.id, t.agentRuns.prId))
      .leftJoin(t.runTraces, eq(t.runTraces.runId, t.agentRuns.id))
      .where(this.counted(workspaceId, win, agentId))
      .orderBy(desc(t.agentRuns.ranAt), desc(t.agentRuns.id))
      .limit(limit);
    return rows.flatMap((r) => {
      if (!isCountedStatus(r.status)) return [];
      const usage = r.tokensIn === null && r.tokensOut === null ? null : (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
      return [
        {
          run_id: r.runId,
          ran_at: r.ranAt.toISOString(),
          status: r.status,
          source: r.source,
          pr: r.prId !== null && r.repoId !== null && r.prNumber !== null ? { id: r.prId, repo_id: r.repoId, number: r.prNumber } : null,
          tokens: usage,
          cost_usd: r.costUsd,
          findings_count: r.findingsCount,
          has_trace: r.traceRunId !== null,
        },
      ];
    });
  }
}
