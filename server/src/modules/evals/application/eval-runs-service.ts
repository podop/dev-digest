/**
 * Eval run use cases (FR6, FR11–FR16, FR18): start a run of an agent's case set in the
 * background (one agent or all), list and read runs, compare two, the dashboards, reap
 * runs a stopped server left behind, shut down. Workspace-scoped; a foreign agent / run
 * id is a 404.
 */
import { ConflictError, NotFoundError, ValidationError } from '../../../platform/errors.js';
import type {
  EvalAgentDashboard,
  EvalCompare,
  EvalOverview,
  EvalRunAllResponse,
  EvalRunDetail,
  EvalRunSummary,
} from '@devdigest/shared';
import {
  EVAL_SHUTDOWN_WAIT_MS,
  INTERRUPTED_ERROR,
  RECENT_RUNS_LIMIT,
  SPARKLINE_POINTS,
  TREND_POINTS,
} from '../domain/constants.js';
import { compareRuns } from '../domain/compare.js';
import { regressionAlert, sparklineOf, trendOf } from '../domain/dashboard.js';
import type { AgentDirectory, AgentSnapshots, EvalLogger, EvalRunsStore, RunLauncher } from './ports.js';

export interface EvalRunsServiceDeps {
  runs: EvalRunsStore;
  agents: AgentDirectory & AgentSnapshots;
  executor: RunLauncher;
}

const NO_LOG: EvalLogger = { info: () => undefined, error: () => undefined };

export class EvalRunsService {
  constructor(private readonly deps: EvalRunsServiceDeps) {}

  /**
   * FR6: snapshot the agent's config and case ids, persist the run as `running`, return
   * it at once and execute in the background. 422 `no_eval_cases` / 409 `eval_run_active` (FR11).
   */
  async start(workspaceId: string, agentId: string, log: EvalLogger = NO_LOG): Promise<EvalRunSummary> {
    const outcome = await this.tryStart(workspaceId, agentId, log);
    if (outcome.kind === 'started') return outcome.run;
    if (outcome.reason === 'no_cases') {
      throw new ValidationError('This agent has no eval cases to run', undefined, 'no_eval_cases');
    }
    throw new ConflictError('An eval run is already in progress for this agent', undefined, 'eval_run_active');
  }

  /** The shared start path: a run that cannot start comes back as a skip reason instead of a throw. */
  private async tryStart(
    workspaceId: string,
    agentId: string,
    log: EvalLogger,
  ): Promise<{ kind: 'started'; run: EvalRunSummary } | { kind: 'skipped'; reason: 'no_cases' | 'run_active' }> {
    const { runs, agents, executor } = this.deps;
    const agent = await agents.snapshot(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    const caseIds = await runs.caseIds(workspaceId, agentId);
    if (caseIds.length === 0) return { kind: 'skipped', reason: 'no_cases' };

    const result = await runs.insertRun({
      workspaceId,
      agentId,
      agentVersion: agent.version,
      config: agent.config,
      caseIds,
    });
    if (result.kind === 'active') return { kind: 'skipped', reason: 'run_active' };

    executor.launch(
      { runId: result.run.id, workspaceId, agentId, agentVersion: agent.version, config: agent.config, caseIds },
      log,
    );
    return { kind: 'started', run: result.run };
  }

  /** FR16: start a run for every agent with cases and no running run (disabled agents included); report the rest. */
  async runAll(workspaceId: string, log: EvalLogger = NO_LOG): Promise<EvalRunAllResponse> {
    const response: EvalRunAllResponse = { started: [], skipped: [] };
    for (const agentId of await this.deps.agents.listIds(workspaceId)) {
      const outcome = await this.tryStart(workspaceId, agentId, log);
      if (outcome.kind === 'started') response.started.push(outcome.run);
      else response.skipped.push({ agent_id: agentId, reason: outcome.reason });
    }
    return response;
  }

  /** FR12: the agent's runs, newest first. */
  async list(workspaceId: string, agentId: string, limit: number): Promise<EvalRunSummary[]> {
    if (!(await this.deps.agents.exists(workspaceId, agentId))) throw new NotFoundError('Agent not found');
    return this.deps.runs.listRuns(workspaceId, agentId, limit);
  }

  /** FR12: one run with its per-case results and progress. */
  async get(workspaceId: string, id: string): Promise<EvalRunDetail> {
    const run = await this.deps.runs.getRun(workspaceId, id);
    if (!run) throw new NotFoundError('Eval run not found');
    return run;
  }

  /** FR13: run A (older) against run B (newer) of one agent; 422 `runs_not_comparable` otherwise. */
  async compare(workspaceId: string, aId: string, bId: string): Promise<EvalCompare> {
    const { runs } = this.deps;
    const [a, b] = await Promise.all([runs.compareSide(workspaceId, aId), runs.compareSide(workspaceId, bId)]);
    if (!a || !b) throw new NotFoundError('Eval run not found');
    return compareRuns(a, b);
  }

  /** FR14: per agent with cases or runs — latest finished run + sparkline; the most recent runs across agents. */
  async overview(workspaceId: string): Promise<EvalOverview> {
    const { runs } = this.deps;
    const agents = await runs.agentsWithEvals(workspaceId);
    const [finished, recent] = await Promise.all([
      runs.finishedRunsByAgent(
        workspaceId,
        agents.map((a) => a.agentId),
        SPARKLINE_POINTS,
      ),
      runs.recentRuns(workspaceId, RECENT_RUNS_LIMIT),
    ]);
    return {
      agents: agents.map((a) => {
        const list = finished.get(a.agentId) ?? [];
        return {
          agent_id: a.agentId,
          name: a.name,
          model: a.model,
          cases_total: a.casesTotal,
          latest: list[0] ?? null,
          sparkline: sparklineOf(list),
        };
      }),
      recent_runs: recent,
    };
  }

  /** FR14, FR15: one agent's latest and previous finished run, trend and regression alert. */
  async agentDashboard(workspaceId: string, agentId: string): Promise<EvalAgentDashboard> {
    const { runs, agents } = this.deps;
    if (!(await agents.exists(workspaceId, agentId))) throw new NotFoundError('Agent not found');
    const [finished, caseIds] = await Promise.all([
      runs.finishedRuns(workspaceId, agentId, TREND_POINTS),
      runs.caseIds(workspaceId, agentId),
    ]);
    const latest = finished[0] ?? null;
    const previous = finished[1] ?? null;
    return {
      agent_id: agentId,
      cases_total: caseIds.length,
      latest,
      previous,
      trend: trendOf(finished),
      alert: regressionAlert(latest, previous),
    };
  }

  /** FR18: at boot, every run still `running` belongs to a stopped server — fail it as interrupted. */
  reapInterrupted(): Promise<number> {
    return this.deps.runs.reapRunning(INTERRUPTED_ERROR);
  }

  /** Abort in-flight runs (they record themselves as interrupted); false = they did not finish in time. */
  shutdown(timeoutMs: number = EVAL_SHUTDOWN_WAIT_MS): Promise<boolean> {
    return this.deps.executor.shutdown(timeoutMs);
  }
}
