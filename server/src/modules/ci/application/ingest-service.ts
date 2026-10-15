/**
 * Pull-based ingest of CI results (specs/export-to-ci.md FR19–FR23, NFR4–NFR7): for each workflow
 * installation, read the newest completed runs through the studio's own GitHub calls, verify each
 * result artifact against the run, and store it as one `agent_runs` + one `ci_runs` row.
 * Nothing is written for a skipped run; no log line carries the token or artifact bytes.
 */
import type {
  CiInstallation,
  CiRefreshResult,
  CiRun,
  GitHubClient,
  RunArtifactSummary,
  WorkflowRunSummary,
} from '@devdigest/shared';
import { NotFoundError } from '../../../platform/errors.js';
import {
  MAX_ARTIFACT_ZIP_BYTES,
  REFRESH_BUDGET_MS,
  RUNS_PER_INSTALLATION,
  artifactNameFor,
  workflowPathFor,
} from '../domain/constants.js';
import { githubErrorCode, githubStatus, verifyArtifact } from '../domain/ingest.js';
import { readResultArtifact } from './artifact-reader.js';
import type { AgentDirectory, CiLogger, CiStore, GitHubProvider, NewCiRun, ZipEntryReader } from './ports.js';

const NO_LOG: CiLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

type InstallationResult = CiRefreshResult['installations'][number];
type SkipReason = InstallationResult['skipped'][number]['reason'];
type GithubCall = <T>(fn: () => Promise<T>) => Promise<T>;

/** Conclusions of runs that never produced a verdict: they are not stored (FR21). */
const NOT_STORED_CONCLUSIONS = new Set<string | null>(['skipped', 'cancelled', null]);

export interface CiIngestDeps {
  agents: AgentDirectory;
  store: CiStore;
  github: GitHubProvider;
  zip: ZipEntryReader;
  /** Clock in ms; injectable for the refresh budget. */
  now?: () => number;
}

/** The refresh time budget ran out before a GitHub call could start. */
class BudgetExhausted extends Error {}

/** A database failure inside a refresh: surfaces as a 500, never as a GitHub error code. */
class StoreFailure extends Error {
  constructor(readonly original: unknown) {
    super('ci store failure');
  }
}

/** What the use case needs from one run's artifacts. */
type ArtifactOutcome =
  | { kind: 'none' }
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'store'; run: NewCiRun };

export class CiIngestService {
  private readonly now: () => number;

  constructor(private readonly deps: CiIngestDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Newest CI runs of the workspace, optionally of one agent. */
  listRuns(workspaceId: string, filter: { agentId?: string; limit: number }): Promise<CiRun[]> {
    return this.deps.store.listRuns(workspaceId, filter);
  }

  async refresh(workspaceId: string, agentId: string | undefined, log: CiLogger = NO_LOG): Promise<CiRefreshResult> {
    if (agentId !== undefined && !(await this.deps.agents.exists(workspaceId, agentId))) {
      throw new NotFoundError('Agent not found', undefined, 'agent_not_found');
    }
    const github = await this.deps.github();
    const installations = await this.deps.store.listInstallations(workspaceId, { agentId });
    const deadline = this.now() + REFRESH_BUDGET_MS;
    /** Every GitHub call goes through here so the budget is checked before each one. */
    const call: GithubCall = (fn) => {
      if (this.now() >= deadline) return Promise.reject(new BudgetExhausted());
      return fn();
    };

    const results: InstallationResult[] = [];
    for (const installation of installations) {
      if (!installation.slug) continue;
      const result: InstallationResult = {
        installation_id: installation.id,
        repo: installation.repo,
        state: 'ok',
        ingested: 0,
        skipped: [],
      };
      results.push(result);
      try {
        await this.refreshInstallation(workspaceId, installation, installation.slug, github, call, result, log);
      } catch (err) {
        if (err instanceof StoreFailure) throw err.original;
        if (err instanceof BudgetExhausted) {
          result.state = 'not_checked';
          continue;
        }
        const code = githubErrorCode(err);
        result.state = 'error';
        result.error_code = code;
        log.error(
          { installation_id: installation.id, repo: installation.repo, code, status: githubStatus(err) },
          'ci refresh: installation failed',
        );
      }
    }
    return {
      ingested: results.reduce((n, r) => n + r.ingested, 0),
      degraded: results.some((r) => r.state === 'error' || r.state === 'not_checked'),
      installations: results,
    };
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new StoreFailure(err);
    }
  }

  private async refreshInstallation(
    workspaceId: string,
    installation: CiInstallation,
    slug: string,
    github: GitHubClient,
    call: GithubCall,
    result: InstallationResult,
    log: CiLogger,
  ): Promise<void> {
    const [owner, name] = installation.repo.split('/');
    if (!owner || !name) throw new Error('malformed installation repository');
    const repo = { owner, name };
    const workflowPath = workflowPathFor(slug);
    const workflowFile = workflowPath.slice(workflowPath.lastIndexOf('/') + 1);

    let runs: WorkflowRunSummary[];
    try {
      runs = await call(() => github.listWorkflowRuns(repo, workflowFile, { perPage: RUNS_PER_INSTALLATION }));
    } catch (err) {
      // EC7: the workflow file is not on the default branch yet — not an error.
      if (githubStatus(err) === 404) {
        result.state = 'not_installed';
        return;
      }
      throw err;
    }

    const stored = await this.guarded(() =>
      this.deps.store.storedRunKeys(runs.map((r) => ({ id: r.id, attempt: r.run_attempt }))),
    );
    for (const run of runs) {
      if (NOT_STORED_CONCLUSIONS.has(run.conclusion) || stored.has(`${run.id}:${run.run_attempt}`)) continue;
      const outcome = await this.inspectRun(workspaceId, installation, slug, workflowPath, run, github, call, repo);
      if (outcome.kind === 'skip') {
        result.skipped.push({ github_run_id: run.id, reason: outcome.reason });
        log.warn(
          { installation_id: installation.id, repo: installation.repo, github_run_id: run.id, reason: outcome.reason },
          'ci refresh: run skipped',
        );
        continue;
      }
      const newRun =
        outcome.kind === 'store'
          ? outcome.run
          : this.failedRun(workspaceId, installation, run);
      // false = another refresh stored it first (EC6): nothing to count.
      if (await this.guarded(() => this.deps.store.recordRun(newRun))) result.ingested += 1;
    }
  }

  /** Find, download, read and verify the run's result artifact (FR20, NFR4, NFR5). */
  private async inspectRun(
    workspaceId: string,
    installation: CiInstallation,
    slug: string,
    workflowPath: string,
    run: WorkflowRunSummary,
    github: GitHubClient,
    call: GithubCall,
    repo: { owner: string; name: string },
  ): Promise<ArtifactOutcome> {
    const artifacts = await call(() => github.listRunArtifacts(repo, run.id));
    const artifact = newestNamed(artifacts, artifactNameFor(slug));
    if (!artifact) return { kind: 'none' };
    if (artifact.expired) return { kind: 'skip', reason: 'artifact_expired' };
    // GitHub reports the size up front: never download what is over the limit.
    if (artifact.size_in_bytes > MAX_ARTIFACT_ZIP_BYTES) return { kind: 'skip', reason: 'artifact_too_large' };

    let zip: Uint8Array | null;
    try {
      zip = await call(() => github.downloadArtifact(repo, artifact.id, { maxBytes: MAX_ARTIFACT_ZIP_BYTES }));
    } catch (err) {
      // Q6: GitHub answers an expired artifact's download with 410.
      if (githubStatus(err) === 410) return { kind: 'skip', reason: 'artifact_expired' };
      throw err;
    }
    if (zip === null) return { kind: 'skip', reason: 'artifact_too_large' };

    const read = readResultArtifact(zip, this.deps.zip);
    if (!read.ok) return { kind: 'skip', reason: read.reason };
    const facts = { head_sha: run.head_sha, repository_id: run.repository_id, path: run.path };
    if (!verifyArtifact(read.artifact, facts, workflowPath)) return { kind: 'skip', reason: 'artifact_mismatch' };

    const a = read.artifact;
    return {
      kind: 'store',
      run: {
        ...this.baseRun(workspaceId, installation, run),
        prNumber: a.pr_number ?? run.pr_numbers[0] ?? null,
        manifestVersion: a.manifest_version ?? installation.manifest_version ?? null,
        status: a.findings_count > 0 ? 'succeeded' : 'no_findings',
        model: a.model ?? null,
        costUsd: a.cost_usd,
        durationMs: a.duration_ms ?? null,
        findingsCount: a.findings_count,
        blockers: a.blockers ?? 0,
        error: null,
      },
    };
  }

  /** A completed run without a result artifact: the runner failed hard (FR21). */
  private failedRun(workspaceId: string, installation: CiInstallation, run: WorkflowRunSummary): NewCiRun {
    return {
      ...this.baseRun(workspaceId, installation, run),
      prNumber: run.pr_numbers[0] ?? null,
      manifestVersion: installation.manifest_version ?? null,
      status: 'failed',
      model: null,
      costUsd: null,
      durationMs: null,
      findingsCount: 0,
      blockers: 0,
      error: 'The CI run produced no result artifact',
    };
  }

  private baseRun(
    workspaceId: string,
    installation: CiInstallation,
    run: WorkflowRunSummary,
  ): Pick<NewCiRun, 'workspaceId' | 'installationId' | 'agentId' | 'githubRunId' | 'runAttempt' | 'headSha' | 'githubUrl' | 'ranAt'> {
    const created = new Date(run.created_at);
    return {
      workspaceId,
      installationId: installation.id,
      agentId: installation.agent_id,
      githubRunId: run.id,
      runAttempt: run.run_attempt,
      headSha: run.head_sha,
      githubUrl: run.html_url,
      ranAt: Number.isNaN(created.getTime()) ? new Date(this.now()) : created,
    };
  }
}

/** The newest artifact with this name (A3). */
function newestNamed(artifacts: RunArtifactSummary[], name: string): RunArtifactSummary | undefined {
  let best: RunArtifactSummary | undefined;
  for (const a of artifacts) {
    if (a.name !== name) continue;
    if (!best || Date.parse(a.created_at) > Date.parse(best.created_at)) best = a;
  }
  return best;
}
