/**
 * Export use cases (specs/export-to-ci.md FR5, FR6, FR13, FR15): generate the CI files of an agent
 * and, for `open_pr`, commit them to `devdigest/ci` and open (or reuse) the PR. Every check runs
 * before the first GitHub call; the LLM is never involved (NFR9).
 */
import type { CiExport, CiExportInput, CiFile, CiInstallation } from '@devdigest/shared';
import {
  ConflictError,
  ExternalServiceError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../../../platform/errors.js';
import {
  CI_BRANCH,
  CI_COMMIT_MESSAGE,
  CI_PR_TITLE,
  MEMORY_FILE_PATH,
  RUNNER_ENTRY_PATH,
  SKILL_SLUG_FALLBACK,
  manifestPathFor,
  skillPathFor,
  workflowPathFor,
} from '../domain/constants.js';
import { githubStatus } from '../domain/ingest.js';
import { buildManifest } from '../domain/manifest.js';
import { slugify } from '../domain/slug.js';
import { buildPrBody, buildWorkflow, normalizeTriggers } from '../domain/workflow.js';
import type {
  AgentDirectory,
  CiLogger,
  CiStore,
  GitHubProvider,
  RepoDirectory,
  RunnerBundle,
  YamlCodec,
} from './ports.js';
import { checkWorkflow } from './workflow-check.js';

const NO_LOG: CiLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const PERMISSION_MESSAGE =
  'GitHub refused the write. The studio token needs the classic scopes `repo` + `workflow`, or the ' +
  'fine-grained permissions Contents:write, Workflows:write and Pull requests:write.';

export interface CiExportDeps {
  agents: AgentDirectory;
  repos: RepoDirectory;
  store: CiStore;
  bundle: RunnerBundle;
  github: GitHubProvider;
  yaml: YamlCodec;
}

export class CiExportService {
  constructor(private readonly deps: CiExportDeps) {}

  /** `action: "files"` returns the files without any GitHub call or DB write; `open_pr` also publishes. */
  async export(
    workspaceId: string,
    agentId: string,
    input: CiExportInput,
    log: CiLogger = NO_LOG,
  ): Promise<CiExport> {
    const agent = await this.deps.agents.get(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found', undefined, 'agent_not_found');
    if (input.target !== 'gha') {
      throw new ValidationError('Only GitHub Actions can be exported', undefined, 'unsupported_target');
    }
    if (agent.provider !== 'openrouter') {
      throw new ValidationError('Only agents on the openrouter provider can be exported to CI', undefined, 'unsupported_provider');
    }
    const triggers = normalizeTriggers(input.triggers);
    if (!triggers) {
      throw new ValidationError('Select at least one valid pull_request trigger', undefined, 'invalid_triggers');
    }
    const repo = await this.deps.repos.findByFullName(workspaceId, input.repo);
    if (!repo) throw new NotFoundError('Repository is not imported in this workspace', undefined, 'repo_not_found');

    const existing = await this.deps.store.findInstallation(workspaceId, agent.id, repo.fullName);
    const slug = existing?.slug ?? slugify(agent.name);
    const owner = await this.deps.store.slugOwner(repo.fullName, slug);
    if (owner && owner !== agent.id) {
      throw new ConflictError(`Another agent already uses the CI name "${slug}" in this repository`, undefined, 'ci_slug_conflict');
    }

    const skills = agent.skills.map((s) => ({ slug: slugify(s.name, SKILL_SLUG_FALLBACK), body: s.body }));
    if (new Set(skills.map((s) => s.slug)).size !== skills.length) {
      throw new ValidationError('Two attached skills have the same file name', undefined, 'skill_slug_conflict');
    }

    const workflow = input.workflow ?? buildWorkflow({ slug, triggers, postAs: input.post_as });
    const check = checkWorkflow(workflow, this.deps.yaml);
    if (!check.ok) {
      throw new ValidationError('The workflow breaks a security rule', { rule: check.rule }, 'workflow_insecure');
    }

    const runner = await this.deps.bundle.read();
    if (runner === null) {
      throw new InternalError('The runner bundle is missing: build agent-runner (cd agent-runner && pnpm build)', undefined, 'runner_bundle_missing');
    }

    const files: CiFile[] = [
      { path: manifestPathFor(slug), contents: this.deps.yaml.stringify(buildManifest(agent, skills.map((s) => s.slug))), editable: false },
      ...skills.map((s) => ({ path: skillPathFor(s.slug), contents: s.body, editable: false })),
      { path: MEMORY_FILE_PATH, contents: '', editable: false },
      { path: RUNNER_ENTRY_PATH, contents: runner, editable: false },
      { path: workflowPathFor(slug), contents: workflow, editable: true },
    ];
    if (input.action === 'files') return { installation: null, files, pr_url: null };

    const prUrl = await this.publish(repo, slug, files, log);
    const saved = await this.deps.store.upsertInstallation({
      agentId: agent.id,
      repo: repo.fullName,
      slug,
      manifestVersion: agent.version,
    });
    if (saved.kind === 'slug_taken') {
      throw new ConflictError(`Another agent already uses the CI name "${slug}" in this repository`, undefined, 'ci_slug_conflict');
    }
    const installation = await this.deps.store.findInstallation(workspaceId, agent.id, repo.fullName);
    if (!installation) throw new InternalError('The CI installation was not saved');
    return { installation, files, pr_url: prUrl };
  }

  /** The agent's installations, newest export first, each with its last CI run. */
  async listInstallations(workspaceId: string, agentId: string): Promise<CiInstallation[]> {
    if (!(await this.deps.agents.exists(workspaceId, agentId))) {
      throw new NotFoundError('Agent not found', undefined, 'agent_not_found');
    }
    return this.deps.store.listInstallations(workspaceId, { agentId });
  }

  /** One commit on `devdigest/ci`, then the open PR of that branch (reused) or a new one. Returns its URL. */
  private async publish(
    repo: { owner: string; name: string; fullName: string; defaultBranch: string },
    slug: string,
    files: CiFile[],
    log: CiLogger,
  ): Promise<string> {
    const github = await this.deps.github();
    const ref = { owner: repo.owner, name: repo.name };
    try {
      await github.commitFiles(ref, {
        branch: CI_BRANCH,
        base: repo.defaultBranch,
        message: CI_COMMIT_MESSAGE,
        files: files.map((f) => ({ path: f.path, contents: f.contents })),
      });
      const open = await github.findOpenPr(ref, CI_BRANCH);
      if (open) return open.url;
      const pr = await github.openPullRequest(ref, {
        title: CI_PR_TITLE,
        head: CI_BRANCH,
        base: repo.defaultBranch,
        body: buildPrBody({ slug, paths: files.map((f) => f.path) }),
      });
      return pr.url;
    } catch (err) {
      const status = githubStatus(err);
      // Status only: never the error text (it can echo request details).
      log.error({ repo: repo.fullName, status }, 'ci export: GitHub write failed');
      if (status === 403 || status === 404) {
        throw new ValidationError(PERMISSION_MESSAGE, undefined, 'github_permission_denied');
      }
      throw new ExternalServiceError('GitHub is unavailable, try again later', undefined, 'github_unavailable');
    }
  }
}
