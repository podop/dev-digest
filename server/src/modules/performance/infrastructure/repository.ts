/**
 * Performance data access (infrastructure; implements PerformanceReader).
 * SELECT only. Reads `agents`, `agent_runs`, `reviews` and `findings`,
 * workspace-scoped; one filter defines a "counted run" for runs and findings.
 */
import { and, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { PerformanceReader } from '../application/ports.js';
import { COUNTED_SOURCES, COUNTED_STATUSES } from '../domain/constants.js';
import type { AgentRef, FindingCounts, RunFact } from '../domain/metrics.js';
import type { PeriodWindow } from '../domain/period.js';

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
}
