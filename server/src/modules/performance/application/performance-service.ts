/**
 * Performance use cases (read-only): the cross-agent dashboard and one agent's
 * stats. Both fold the same per-run facts with `buildRow` (current window and
 * the equally long window before it), so a dashboard row equals the agent's
 * stats for the same period (AC10). No LLM, job or write.
 */
import type { AgentPerf, AgentStats } from '@devdigest/shared';
import { NotFoundError } from '../../../platform/errors.js';
import { MIN_DECISIONS, RUN_HISTORY_LIMIT } from '../domain/constants.js';
import {
  buildRow,
  byName,
  costByAgent,
  costByModel,
  groupFindings,
  groupRuns,
  summarize,
  type AgentRef,
  type FindingCounts,
  type RunFact,
  type WindowFacts,
} from '../domain/metrics.js';
import { previousWindow, resolveWindow, toPeriodInfo, type PeriodQuery, type PeriodWindow } from '../domain/period.js';
import { findingsByCategory, findingsBySeverity, runsTrend, topMemories, topSkills } from '../domain/trends.js';
import type { PerformanceReader } from './ports.js';

export interface PerformanceDeps {
  reader: PerformanceReader;
  clock: () => Date;
}

/** All agents' facts of one window, keyed like `groupRuns` (null = deleted agents). */
interface WindowGroups {
  runs: RunFact[];
  runsByAgent: Map<string | null, RunFact[]>;
  countsByAgent: Map<string | null, FindingCounts>;
}

const NO_FACTS: WindowFacts = { runs: [], findings: undefined };

function factsOf(groups: WindowGroups, key: string | null): WindowFacts {
  return { runs: groups.runsByAgent.get(key) ?? [], findings: groups.countsByAgent.get(key) };
}

export class PerformanceService {
  constructor(private readonly deps: PerformanceDeps) {}

  private async windowGroups(workspaceId: string, win: PeriodWindow, known: ReadonlySet<string>): Promise<WindowGroups> {
    const { reader } = this.deps;
    const [runs, counts] = await Promise.all([reader.countedRuns(workspaceId, win), reader.findingCounts(workspaceId, win)]);
    return { runs, runsByAgent: groupRuns(runs, known), countsByAgent: groupFindings(counts, known) };
  }

  /** GET /agents/performance: a row per current agent (0 runs too) + the deleted-agents row. */
  async overview(workspaceId: string, query: PeriodQuery): Promise<AgentPerf> {
    const { reader, clock } = this.deps;
    const win = resolveWindow(query, clock());
    const prevWin = previousWindow(win);
    const agents = await reader.listAgents(workspaceId);
    const known = new Set(agents.map((a) => a.id));
    const [cur, prev] = await Promise.all([
      this.windowGroups(workspaceId, win, known),
      this.windowGroups(workspaceId, prevWin, known),
    ]);

    const row = (agent: AgentRef | null) =>
      buildRow(agent, factsOf(cur, agent?.id ?? null), factsOf(prev, agent?.id ?? null), win);
    const rows = [...agents].sort((a, b) => byName(a.name, b.name)).map(row);
    if (cur.runsByAgent.has(null)) rows.push(row(null));
    // Previous totals fold every agent's previous-window facts (deleted agents too).
    const prevRow = (agent: AgentRef | null) => buildRow(agent, factsOf(prev, agent?.id ?? null), NO_FACTS, prevWin);
    const prevRows = agents.map(prevRow);
    if (prev.runsByAgent.has(null)) prevRows.push(prevRow(null));

    return {
      period: toPeriodInfo(win),
      min_decisions: MIN_DECISIONS,
      cost_basis: 'estimate',
      summary: summarize(rows),
      previous_summary: summarize(prevRows),
      runs_trend: runsTrend(cur.runs, win),
      agents: rows,
      cost_by_agent: costByAgent(rows),
      cost_by_model: costByModel(cur.runs),
    };
  }

  /** GET /agents/:id/stats; an unknown agent or another workspace's is a 404. */
  async agentStats(workspaceId: string, agentId: string, query: PeriodQuery): Promise<AgentStats> {
    const { reader, clock } = this.deps;
    const win = resolveWindow(query, clock());
    const prevWin = previousWindow(win);
    const agent = await reader.findAgent(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');
    const [runs, counts, prevRuns, prevCounts, findings, skills, memory, history] = await Promise.all([
      reader.countedRuns(workspaceId, win, agent.id),
      reader.findingCounts(workspaceId, win, agent.id),
      reader.countedRuns(workspaceId, prevWin, agent.id),
      reader.findingCounts(workspaceId, prevWin, agent.id),
      reader.findingFacts(workspaceId, win, agent.id),
      reader.skillUsage(workspaceId, win, agent.id),
      reader.memoryPulled(workspaceId, win, agent.id),
      reader.runHistory(workspaceId, win, agent.id, RUN_HISTORY_LIMIT),
    ]);
    const row = buildRow(agent, { runs, findings: counts[0] }, { runs: prevRuns, findings: prevCounts[0] }, win);
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      period: toPeriodInfo(win),
      min_decisions: MIN_DECISIONS,
      cost_basis: 'estimate',
      metrics: row.metrics,
      previous: row.previous,
      runs_trend: row.runs_trend,
      cost_by_model: costByModel(runs),
      skills_used: topSkills(skills),
      memory_pulled: topMemories(memory),
      findings_by_severity: findingsBySeverity(findings, win),
      findings_by_category: findingsByCategory(findings),
      run_history: history,
    };
  }
}
