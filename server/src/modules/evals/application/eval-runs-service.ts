/**
 * Eval run use cases (FR6, FR11–FR16, FR18): start a run of an agent's case set in the
 * background (one agent or all) or of a skill's case set on a host agent, list and read
 * runs, compare two, the dashboards, reap runs a stopped server left behind, shut down.
 * Workspace-scoped; a foreign agent / skill / run id is a 404.
 */
import { ConflictError, NotFoundError, ValidationError } from '../../../platform/errors.js';
import type {
  EvalAgentDashboard,
  EvalCompare,
  EvalOverview,
  EvalPeriod,
  EvalRunAllResponse,
  EvalRunDetail,
  EvalRunSummary,
} from '@devdigest/shared';
import { EVAL_PERIOD_TREND_MAX } from '@devdigest/shared';
import {
  EVAL_SHUTDOWN_WAIT_MS,
  INTERRUPTED_ERROR,
  RECENT_RUNS_LIMIT,
  SPARKLINE_POINTS,
  TREND_POINTS,
} from '../domain/constants.js';
import { compareRuns } from '../domain/compare.js';
import { periodStart, regressionAlert, sparklineOf, trendOf } from '../domain/dashboard.js';
import type { NewSuiteRun } from '../domain/types.js';
import type {
  AgentDirectory,
  AgentSnapshots,
  EvalLogger,
  EvalRunsStore,
  RunLauncher,
  SkillDirectory,
} from './ports.js';

export interface EvalRunsServiceDeps {
  runs: EvalRunsStore;
  agents: AgentDirectory & AgentSnapshots;
  skills: SkillDirectory;
  executor: RunLauncher;
  /** Wall clock in ms (injectable for tests); anchors the `period` windows. */
  now?: () => number;
}

const NO_LOG: EvalLogger = { info: () => undefined, error: () => undefined };

export class EvalRunsService {
  private readonly now: () => number;

  constructor(private readonly deps: EvalRunsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Lower bound of a `period` window at the current server time; undefined = unbounded. */
  private since(period: EvalPeriod | undefined): Date | undefined {
    return period ? (periodStart(period, new Date(this.now())) ?? undefined) : undefined;
  }

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

  /** Persist `values` as a running run and execute it in the background; `active` = the owner already has a running run. */
  private async begin(values: NewSuiteRun, log: EvalLogger): Promise<EvalRunSummary | undefined> {
    const result = await this.deps.runs.insertRun(values);
    if (result.kind === 'active') return undefined;
    this.deps.executor.launch({ runId: result.run.id, ...values }, log);
    return result.run;
  }

  /** The agent start path: a run that cannot start comes back as a skip reason instead of a throw. */
  private async tryStart(
    workspaceId: string,
    agentId: string,
    log: EvalLogger,
  ): Promise<{ kind: 'started'; run: EvalRunSummary } | { kind: 'skipped'; reason: 'no_cases' | 'run_active' }> {
    const { runs, agents } = this.deps;
    const agent = await agents.snapshot(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    const caseIds = await runs.caseIds(workspaceId, { kind: 'agent', id: agentId });
    if (caseIds.length === 0) return { kind: 'skipped', reason: 'no_cases' };

    const run = await this.begin(
      {
        workspaceId,
        ownerKind: 'agent',
        skillId: null,
        skillVersion: null,
        agentId,
        agentVersion: agent.version,
        agentName: agent.name,
        config: agent.config,
        caseIds,
      },
      log,
    );
    return run ? { kind: 'started', run } : { kind: 'skipped', reason: 'run_active' };
  }

  /**
   * FR18, FR19: run a skill's case set on a host agent with ONLY that skill attached (the
   * host's own linked skills are dropped). The skill and host config are frozen at start.
   * 404 skill; 422 `host_agent_not_found` / `no_eval_cases`; 409 `eval_run_active`.
   */
  async startSkill(workspaceId: string, skillId: string, hostAgentId: string, log: EvalLogger = NO_LOG): Promise<EvalRunSummary> {
    const { runs, agents, skills } = this.deps;
    const skill = await skills.get(workspaceId, skillId);
    if (!skill) throw new NotFoundError('Skill not found');
    const host = await agents.snapshot(workspaceId, hostAgentId);
    if (!host) {
      throw new ValidationError('The host agent was not found in this workspace', undefined, 'host_agent_not_found');
    }
    const caseIds = await runs.caseIds(workspaceId, { kind: 'skill', id: skillId });
    if (caseIds.length === 0) {
      throw new ValidationError('This skill has no eval cases to run', undefined, 'no_eval_cases');
    }
    const run = await this.begin(
      {
        workspaceId,
        ownerKind: 'skill',
        skillId,
        skillVersion: skill.version,
        agentId: hostAgentId,
        agentVersion: host.version,
        agentName: host.name,
        config: { ...host.config, skills: [skill] },
        caseIds,
      },
      log,
    );
    if (!run) throw new ConflictError('An eval run is already in progress for this skill', undefined, 'eval_run_active');
    return run;
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

  /** FR12, FR3: the agent's runs (any status), newest first; with a `period`, only those started within it. */
  async list(workspaceId: string, agentId: string, limit: number, period?: EvalPeriod): Promise<EvalRunSummary[]> {
    if (!(await this.deps.agents.exists(workspaceId, agentId))) throw new NotFoundError('Agent not found');
    return this.deps.runs.listRuns(workspaceId, { kind: 'agent', id: agentId }, limit, this.since(period));
  }

  /** FR20: the skill's runs (any status), newest first. */
  async listSkillRuns(workspaceId: string, skillId: string, limit: number): Promise<EvalRunSummary[]> {
    if (!(await this.deps.skills.get(workspaceId, skillId))) throw new NotFoundError('Skill not found');
    return this.deps.runs.listRuns(workspaceId, { kind: 'skill', id: skillId }, limit);
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

  /**
   * FR14, FR15: one agent's latest and previous finished run, trend and regression alert.
   * Without a `period` the trend is the last 20 finished runs. With one, latest / previous /
   * alert still come from the unbounded newest two (FR2) and the trend from the newest 100
   * finished runs started within the window (FR1).
   */
  async agentDashboard(workspaceId: string, agentId: string, period?: EvalPeriod): Promise<EvalAgentDashboard> {
    const { runs, agents } = this.deps;
    if (!(await agents.exists(workspaceId, agentId))) throw new NotFoundError('Agent not found');
    const caseIdsP = runs.caseIds(workspaceId, { kind: 'agent', id: agentId });
    if (!period) {
      const [finished, caseIds] = await Promise.all([runs.finishedRuns(workspaceId, agentId, TREND_POINTS), caseIdsP]);
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
    const [newest, inPeriod, caseIds] = await Promise.all([
      runs.finishedRuns(workspaceId, agentId, 2),
      runs.finishedRuns(workspaceId, agentId, EVAL_PERIOD_TREND_MAX, this.since(period)),
      caseIdsP,
    ]);
    const latest = newest[0] ?? null;
    const previous = newest[1] ?? null;
    return {
      agent_id: agentId,
      cases_total: caseIds.length,
      latest,
      previous,
      trend: trendOf(inPeriod, EVAL_PERIOD_TREND_MAX),
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
