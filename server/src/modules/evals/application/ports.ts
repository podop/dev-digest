/**
 * Ports of the evals use cases. Infrastructure implements them (EvalsRepository); the
 * composition root wires the real ones and tests pass fakes.
 */
import type {
  AgentEvalCase,
  EvalRecentRun,
  EvalRunDetail,
  EvalRunSummary,
  LLMProvider,
  UnifiedDiff,
} from '@devdigest/shared';
import type { TransactionRunner } from '../../../application/transaction.js';
import type { CompareSide } from '../domain/compare.js';
import type {
  AgentCaseCount,
  CaseOwner,
  CaseRecord,
  EvalCaseWrite,
  EvalRunConfig,
  FindingSource,
  NewEvalCase,
  NewSuiteRun,
  RunFinal,
  RunJob,
  RunnableCase,
  StoredCase,
} from '../domain/types.js';

/** Case reads, workspace-scoped where the id comes from the client. */
export interface EvalCasesReader {
  /** An owner's cases, newest first, each with its result in the latest finished run containing it. */
  list(workspaceId: string, owner: CaseOwner): Promise<AgentEvalCase[]>;
  /** A case of any owner. */
  find(workspaceId: string, id: string): Promise<AgentEvalCase | undefined>;
  count(workspaceId: string, owner: CaseOwner): Promise<number>;
  /** Id of the case already created from a finding (undefined = none). */
  caseIdForFinding(workspaceId: string, findingId: string): Promise<string | undefined>;
  /** The finding joined with its review, PR, repo and stored patch of its file. */
  findingSource(workspaceId: string, findingId: string): Promise<FindingSource | undefined>;
}

export type InsertCaseResult = { kind: 'created'; case: AgentEvalCase } | { kind: 'exists'; caseId: string };

export interface EvalCasesWriter {
  /** One case per finding: a lost race (unique violation) comes back as `exists`, never a throw. */
  insert(values: NewEvalCase): Promise<InsertCaseResult>;
  /** The case's current content (any owner), row locked FOR UPDATE (undefined = not in the workspace). */
  lockForUpdate(workspaceId: string, id: string): Promise<StoredCase | undefined>;
  /** Write the given fields (nothing to write = no-op); returns the fresh case. */
  update(workspaceId: string, id: string, values: EvalCaseWrite): Promise<AgentEvalCase>;
  /** Delete the case (its per-run results cascade). */
  delete(workspaceId: string, id: string): Promise<boolean>;
}

export interface EvalCasesStore extends EvalCasesReader, EvalCasesWriter {}

/** Edit boundary: read the stored expectation and write the merged one atomically. */
export type EvalCasesTx = TransactionRunner<{ cases: EvalCasesWriter }>;

/** Skills as the evals module sees them (reached through the skills service, never its repository). */
export interface SkillDirectory {
  /** undefined = not a skill of the workspace. A disabled skill is still returned (EC16). */
  get(workspaceId: string, skillId: string): Promise<EvalRunConfig['skills'][number] | undefined>;
}

/** Agents as the evals module sees them (reached through the agents repository). */
export interface AgentDirectory {
  exists(workspaceId: string, agentId: string): Promise<boolean>;
  /** Ids of every agent of the workspace (disabled ones included, EC14). */
  listIds(workspaceId: string): Promise<string[]>;
}

// ---- runs ------------------------------------------------------------------

/** An agent's config frozen for a run: version + provider/model/prompt/strategy + enabled linked skills. */
export interface AgentRunSnapshot {
  version: number;
  name: string;
  config: EvalRunConfig;
}

/** Reached through the agents repository (the only cross-module read of the runs use cases). */
export interface AgentSnapshots {
  /** undefined = not an agent of the workspace. A disabled agent is still snapshotted (EC14). */
  snapshot(workspaceId: string, agentId: string): Promise<AgentRunSnapshot | undefined>;
}

export type InsertRunResult = { kind: 'created'; run: EvalRunSummary } | { kind: 'active' };

export interface EvalRunsReader {
  /** Ids of the owner's cases, oldest first (the run's case set). */
  caseIds(workspaceId: string, owner: CaseOwner): Promise<string[]>;
  /** The owner's runs (an agent's own, or a skill's), newest first; `since` keeps only runs started at or after it. */
  listRuns(workspaceId: string, owner: CaseOwner, limit: number, since?: Date): Promise<EvalRunSummary[]>;
  /** A run with its per-case results (undefined = not in the workspace). */
  getRun(workspaceId: string, id: string): Promise<EvalRunDetail | undefined>;
}

export interface EvalRunsWriter {
  /** Persist as `running`; a second running run for the owner (unique violation) comes back as `active`, never a throw. */
  insertRun(values: NewSuiteRun): Promise<InsertRunResult>;
  /** Mark every `running` run failed with `error` (+ finished_at); returns how many. */
  reapRunning(error: string): Promise<number>;
}

/** What the background executor reads and writes while a run executes. */
export interface EvalRunProgress {
  /** undefined = the case no longer exists in the workspace (deleted mid-run, EC9). */
  loadCase(workspaceId: string, caseId: string): Promise<RunnableCase | undefined>;
  /**
   * Store the case result and advance the run's progress counters together. `case_gone` =
   * the case was deleted meanwhile (FK violation): nothing is stored.
   */
  recordCase(runId: string, record: CaseRecord): Promise<'recorded' | 'case_gone'>;
  /** Exclude one case from the run's total (it vanished before / while running). */
  dropCase(runId: string): Promise<void>;
  /** Write the terminal state (status, aggregate metrics, duration, finished_at). */
  finish(runId: string, final: RunFinal): Promise<void>;
}

/** What compare reads: a run with its frozen config and per-case statuses. */
export interface EvalComparisonReader {
  /** undefined = not in the workspace. */
  compareSide(workspaceId: string, id: string): Promise<CompareSide | undefined>;
}

/** What the dashboards read; "finished" = `completed` or `failed` (not `running`). */
export interface EvalDashboardReader {
  /** The agent's finished runs, newest first; `since` keeps only runs started at or after it. */
  finishedRuns(workspaceId: string, agentId: string, limit: number, since?: Date): Promise<EvalRunSummary[]>;
  /** Per agent id, its last `perAgent` finished runs, newest first (one query). */
  finishedRunsByAgent(
    workspaceId: string,
    agentIds: string[],
    perAgent: number,
  ): Promise<Map<string, EvalRunSummary[]>>;
  /** Agents with at least one case or one run, by name, with their case count. */
  agentsWithEvals(workspaceId: string): Promise<AgentCaseCount[]>;
  /** The workspace's most recent runs of any status, newest first, with the agent's name. */
  recentRuns(workspaceId: string, limit: number): Promise<EvalRecentRun[]>;
}

export interface EvalRunsStore
  extends EvalRunsReader,
    EvalRunsWriter,
    EvalRunProgress,
    EvalComparisonReader,
    EvalDashboardReader {}

/** Request-scoped pino-compatible logger (the Container exposes none): `(obj, msg)`. */
export interface EvalLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Resolve an agent's LLM provider (throws a ConfigError when its key is missing). */
export type LlmResolver = (provider: string) => Promise<LLMProvider>;

/** Raw unified diff text → the parsed diff the engine takes. */
export type DiffParser = (raw: string) => UnifiedDiff;

/** Run the tasks with the composition root's bounded concurrency (one call = one run's case set). */
export type BoundedRunner = <T>(tasks: Array<() => Promise<T>>) => Promise<T[]>;

/** What the runs use cases need from the background executor. */
export interface RunLauncher {
  /** Fire and forget: runs the job in the background, never throws into the caller. */
  launch(job: RunJob, log: EvalLogger): void;
  /** Abort in-flight runs and wait (bounded) for them to record their final state; false = timed out. */
  shutdown(timeoutMs: number): Promise<boolean>;
}
