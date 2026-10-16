/**
 * Performance use cases (read-only): the cross-agent dashboard and one agent's
 * stats. Both fold the same per-run facts with `buildRow`, so a dashboard row
 * equals the agent's stats for the same period (AC10). No LLM, job or write.
 */
import type { AgentPerf, AgentStats } from '@devdigest/shared';
import { NotFoundError } from '../../../platform/errors.js';
import { MIN_DECISIONS } from '../domain/constants.js';
import {
  buildRow,
  byName,
  costByAgent,
  costByModel,
  groupFindings,
  groupRuns,
  summarize,
} from '../domain/metrics.js';
import { resolveWindow, toPeriodInfo, type PeriodQuery } from '../domain/period.js';
import type { PerformanceReader } from './ports.js';

export interface PerformanceDeps {
  reader: PerformanceReader;
  clock: () => Date;
}

export class PerformanceService {
  constructor(private readonly deps: PerformanceDeps) {}

  /** GET /agents/performance: a row per current agent (0 runs too) + the deleted-agents row. */
  async overview(workspaceId: string, query: PeriodQuery): Promise<AgentPerf> {
    const { reader, clock } = this.deps;
    const win = resolveWindow(query, clock());
    const [agents, runs, counts] = await Promise.all([
      reader.listAgents(workspaceId),
      reader.countedRuns(workspaceId, win),
      reader.findingCounts(workspaceId, win),
    ]);

    const known = new Set(agents.map((a) => a.id));
    const runsByAgent = groupRuns(runs, known);
    const countsByAgent = groupFindings(counts, known);

    const rows = [...agents]
      .sort((a, b) => byName(a.name, b.name))
      .map((a) => buildRow(a, runsByAgent.get(a.id) ?? [], countsByAgent.get(a.id)));
    const deletedRuns = runsByAgent.get(null);
    if (deletedRuns) rows.push(buildRow(null, deletedRuns, countsByAgent.get(null)));

    return {
      period: toPeriodInfo(win),
      min_decisions: MIN_DECISIONS,
      cost_basis: 'estimate',
      summary: summarize(rows),
      agents: rows,
      cost_by_agent: costByAgent(rows),
      cost_by_model: costByModel(runs),
    };
  }

  /** GET /agents/:id/stats; an unknown agent or another workspace's is a 404. */
  async agentStats(workspaceId: string, agentId: string, query: PeriodQuery): Promise<AgentStats> {
    const { reader, clock } = this.deps;
    const win = resolveWindow(query, clock());
    const agent = await reader.findAgent(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');
    const [runs, counts] = await Promise.all([
      reader.countedRuns(workspaceId, win, agent.id),
      reader.findingCounts(workspaceId, win, agent.id),
    ]);
    const row = buildRow(agent, runs, counts[0]);
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      period: toPeriodInfo(win),
      min_decisions: MIN_DECISIONS,
      cost_basis: 'estimate',
      metrics: row.metrics,
      cost_by_model: costByModel(runs),
    };
  }
}
