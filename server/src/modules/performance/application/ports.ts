/**
 * Port of the performance use case. Infrastructure implements it
 * (PerformanceRepository); the composition root wires the real one and tests
 * pass a fake. Read-only: nothing here writes.
 */
import type { AgentRef, FindingCounts, RunFact } from '../domain/metrics.js';
import type { PeriodWindow } from '../domain/period.js';

export interface PerformanceReader {
  /** Every agent of the workspace (enabled or not), unordered. */
  listAgents(workspaceId: string): Promise<AgentRef[]>;
  /** One agent of the workspace; undefined = unknown or another workspace's. */
  findAgent(workspaceId: string, id: string): Promise<AgentRef | undefined>;
  /** Counted runs (done/failed/cancelled, local/ci) with `ran_at` in the window; optionally one agent's. */
  countedRuns(workspaceId: string, win: PeriodWindow, agentId?: string): Promise<RunFact[]>;
  /** Findings of those counted runs, grouped by the run's agent. */
  findingCounts(workspaceId: string, win: PeriodWindow, agentId?: string): Promise<FindingCounts[]>;
}
