/**
 * Port of the performance use case. Infrastructure implements it
 * (PerformanceRepository); the composition root wires the real one and tests
 * pass a fake. Read-only: nothing here writes.
 */
import type { RunHistoryItem } from '@devdigest/shared';
import type { AgentRef, FindingCounts, RunFact } from '../domain/metrics.js';
import type { PeriodWindow } from '../domain/period.js';
import type { FindingFact, SkillFact } from '../domain/trends.js';

export interface PerformanceReader {
  /** Every agent of the workspace (enabled or not), unordered. */
  listAgents(workspaceId: string): Promise<AgentRef[]>;
  /** One agent of the workspace; undefined = unknown or another workspace's. */
  findAgent(workspaceId: string, id: string): Promise<AgentRef | undefined>;
  /** Counted runs (done/failed/cancelled, local/ci) with `ran_at` in the window; optionally one agent's. */
  countedRuns(workspaceId: string, win: PeriodWindow, agentId?: string): Promise<RunFact[]>;
  /** Findings of those counted runs, grouped by the run's agent. */
  findingCounts(workspaceId: string, win: PeriodWindow, agentId?: string): Promise<FindingCounts[]>;
  /** One agent's findings of its counted runs, grouped per run by severity and category. */
  findingFacts(workspaceId: string, win: PeriodWindow, agentId: string): Promise<FindingFact[]>;
  /** Skills in one agent's counted runs, with the number of runs that had each. */
  skillUsage(workspaceId: string, win: PeriodWindow, agentId: string): Promise<SkillFact[]>;
  /** `trace.memory_pulled` of each of one agent's counted runs that has a trace (raw jsonb). */
  memoryPulled(workspaceId: string, win: PeriodWindow, agentId: string): Promise<unknown[]>;
  /** One agent's newest counted runs of the window, newest first. */
  runHistory(workspaceId: string, win: PeriodWindow, agentId: string, limit: number): Promise<RunHistoryItem[]>;
}
