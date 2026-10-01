import {
  PROJECT_CONTEXT_BUDGET_TOKENS,
  PROJECT_CONTEXT_MAX_DOCS,
  PROJECT_CONTEXT_MAX_DOC_BYTES,
  type ContextAttachments,
  type ContextAttachmentsInput,
  type ContextDocPreview,
  type ContextList,
  type ContextUsedByAgent,
} from '@devdigest/shared';
import type { TransactionRunner } from '../../../application/transaction.js';
import {
  InvalidInputError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../../platform/errors.js';
import { docNameOf, docTypeOf, checkPath, isListablePath, validateAttachmentPaths } from '../domain/paths.js';
import {
  applyBudget,
  buildRunDocList,
  projectContextLogLine,
  readFailure,
  toRunDoc,
} from '../domain/run-context.js';
import type { ReadOutcome, RunDocRef, SkillAttachmentSet } from '../domain/types.js';
import type {
  CloneDocs,
  ContextRepoRef,
  ContextStore,
  ResolveForRunInput,
  RunContextResult,
  RunGit,
  UsageRow,
} from './ports.js';

/** Same estimate as the whole product: ceil(chars / 4). */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

export interface ProjectContextDeps {
  store: ContextStore;
  /** Writes run on a transaction handle (replace = delete + insert). */
  tx: TransactionRunner<{ store: ContextStore }>;
  docs: CloneDocs;
  /** Base commit + file reads for runs (resolved per call: test overrides keep working). */
  git: RunGit;
  /** Listable-document globs (server config). */
  globs: readonly string[];
}

/** Documents read at once during a run (NFR1): bounded, git runs one process per read. */
const RUN_READ_CONCURRENCY = 8;

/** `fn` over `items` with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Agents using each path in a repo: one entry per agent, a direct attachment beating a skill one. */
function usedByPath(rows: readonly UsageRow[]): Map<string, ContextUsedByAgent[]> {
  const byPath = new Map<string, Map<string, ContextUsedByAgent>>();
  for (const r of rows) {
    const agents = byPath.get(r.path) ?? new Map<string, ContextUsedByAgent>();
    byPath.set(r.path, agents);
    const have = agents.get(r.agentId);
    if (have && (have.via === 'direct' || r.via === 'skill')) continue;
    agents.set(
      r.agentId,
      r.via === 'direct'
        ? { id: r.agentId, name: r.agentName, via: 'direct' }
        : { id: r.agentId, name: r.agentName, via: 'skill', ...(r.skillName ? { skill_name: r.skillName } : {}) },
    );
  }
  const byName = (a: ContextUsedByAgent, b: ContextUsedByAgent) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return new Map([...byPath].map(([path, agents]) => [path, [...agents.values()].sort(byName)]));
}

export class ProjectContextService {
  constructor(private readonly deps: ProjectContextDeps) {}

  /** GET /repos/:id/context — documents of the clone that the globs accept. */
  async listDocs(workspaceId: string, repoId: string): Promise<ContextList> {
    const repo = await this.requireRepo(workspaceId, repoId);
    const globs = [...this.deps.globs];
    const listed = repo.clonePath
      ? await this.deps.docs.list(repo.clonePath, this.deps.globs, PROJECT_CONTEXT_MAX_DOCS)
      : null;
    if (!listed) return { clone_status: 'not_cloned', globs, docs: [], tokens_total: 0 };

    const used = usedByPath(await this.deps.store.listUsage(repoId));
    const docs = listed.docs.map((d) => ({
      path: d.path,
      name: docNameOf(d.path),
      doc_type: docTypeOf(d.path),
      size_bytes: d.sizeBytes,
      tokens: tokensOf(d.chars),
      updated_at: d.updatedAt.toISOString(),
      used_by: used.get(d.path)?.length ?? 0,
    }));
    return {
      clone_status: 'ready',
      globs,
      docs,
      tokens_total: docs.reduce((sum, d) => sum + d.tokens, 0),
      ...(listed.truncated ? { truncated: true } : {}),
    };
  }

  /** GET /repos/:id/context/doc?path= — one listable document with who uses it. */
  async previewDoc(workspaceId: string, repoId: string, path: string): Promise<ContextDocPreview> {
    const repo = await this.requireRepo(workspaceId, repoId);
    // Shape, excluded directories and globs are all checked before any filesystem access (NFR3).
    if (!isListablePath(path, this.deps.globs)) {
      throw new InvalidInputError('Not a listable document path', undefined, 'invalid_path');
    }
    const read = repo.clonePath ? await this.deps.docs.read(repo.clonePath, path) : null;
    if (!read || read.status === 'not_found') throw new NotFoundError('Document not found', undefined, 'doc_not_found');
    if (read.status === 'too_large') {
      throw new PayloadTooLargeError('Document is too large to preview', undefined, 'doc_too_large');
    }
    const usedBy = usedByPath(await this.deps.store.listUsage(repoId)).get(path) ?? [];
    return {
      path,
      name: docNameOf(path),
      doc_type: docTypeOf(path),
      content: read.content,
      tokens: tokensOf(read.content.length),
      size_bytes: read.sizeBytes,
      used_by: usedBy.length,
      used_by_agents: usedBy,
    };
  }

  /** GET /agents/:id/context?repoId= — the agent's ordered paths in one repo. */
  async getAgentContext(workspaceId: string, agentId: string, repoId: string): Promise<ContextAttachments> {
    await this.requireAgent(workspaceId, agentId);
    await this.requireRepo(workspaceId, repoId);
    return { repo_id: repoId, paths: await this.deps.store.getAgentPaths(agentId, repoId) };
  }

  /** PUT /agents/:id/context — replace the whole list; no agent version bump. */
  async putAgentContext(
    workspaceId: string,
    agentId: string,
    input: ContextAttachmentsInput,
  ): Promise<ContextAttachments> {
    await this.requireAgent(workspaceId, agentId);
    await this.requireRepo(workspaceId, input.repo_id);
    this.validatePaths(input.paths);
    await this.deps.tx.run(({ store }) => store.replaceAgentPaths(agentId, input.repo_id, input.paths));
    return { repo_id: input.repo_id, paths: [...input.paths] };
  }

  /** GET /skills/:id/context?repoId= */
  async getSkillContext(workspaceId: string, skillId: string, repoId: string): Promise<ContextAttachments> {
    await this.requireSkill(workspaceId, skillId);
    await this.requireRepo(workspaceId, repoId);
    return { repo_id: repoId, paths: await this.deps.store.getSkillPaths(skillId, repoId) };
  }

  /** PUT /skills/:id/context — replace the whole list; no skill version bump. */
  async putSkillContext(
    workspaceId: string,
    skillId: string,
    input: ContextAttachmentsInput,
  ): Promise<ContextAttachments> {
    await this.requireSkill(workspaceId, skillId);
    await this.requireRepo(workspaceId, input.repo_id);
    this.validatePaths(input.paths);
    await this.deps.tx.run(({ store }) => store.replaceSkillPaths(skillId, input.repo_id, input.paths));
    return { repo_id: input.repo_id, paths: [...input.paths] };
  }

  /**
   * The documents of one run: the agent's attachments, then each enabled
   * skill's, read at the PR base commit (never the working tree, so an
   * unreviewed head cannot rewrite the rules it is judged by). Never throws:
   * any failure degrades to "no documents" and is reported through `onWarn`.
   * Workspace ownership was already checked by the review that calls this.
   */
  async resolveForRun(input: ResolveForRunInput): Promise<RunContextResult> {
    const none: RunContextResult = {
      docs: [],
      included: [],
      tokensTotal: 0,
      budgetTokens: PROJECT_CONTEXT_BUDGET_TOKENS,
      logLine: '',
    };
    try {
      const agentPaths = await this.deps.store.getAgentPaths(input.agentId, input.repoId);
      const sets: SkillAttachmentSet[] = [];
      for (const s of input.skills) {
        const paths = s.enabled ? await this.deps.store.getSkillPaths(s.id, input.repoId) : [];
        sets.push({ skillId: s.id, skillName: s.name, enabled: s.enabled, paths });
      }
      const refs = buildRunDocList(agentPaths, sets);
      if (refs.length === 0) return none;

      const sha = await this.deps.git.resolveBaseCommit(input.repo, input.base, input.headSha);
      // No base commit: a repo that was never cloned has none of its documents ("missing");
      // a clone whose base commit cannot be resolved cannot be read ("unreadable").
      const missingClone =
        sha === null && (await this.deps.store.findRepo(input.workspaceId, input.repoId))?.clonePath == null;
      const read = await mapLimit(refs, RUN_READ_CONCURRENCY, async (ref) =>
        toRunDoc(ref, await this.readAtBase(input, sha, missingClone, ref)),
      );
      const { docs, tokensTotal } = applyBudget(read);
      return {
        docs,
        included: docs.flatMap((d) => (d.status === 'included' && d.text !== undefined ? [{ path: d.path, text: d.text }] : [])),
        tokensTotal,
        budgetTokens: PROJECT_CONTEXT_BUDGET_TOKENS,
        logLine: projectContextLogLine(docs, tokensTotal),
      };
    } catch (err) {
      input.onWarn?.(err instanceof Error ? err.message : 'unknown error');
      return none;
    }
  }

  /** One document at the base commit; the path shape is checked again before any read. */
  private async readAtBase(
    input: ResolveForRunInput,
    sha: string | null,
    missingClone: boolean,
    ref: RunDocRef,
  ): Promise<ReadOutcome> {
    if (!checkPath(ref.path)) return { status: 'unreadable' };
    if (sha === null) return { status: missingClone ? 'missing' : 'unreadable' };
    try {
      const file = await this.deps.git.readFileAt(input.repo, sha, ref.path, {
        maxBytes: PROJECT_CONTEXT_MAX_DOC_BYTES,
      });
      return { status: 'ok', text: file.content };
    } catch (err) {
      return readFailure(err);
    }
  }

  private validatePaths(paths: readonly string[]): void {
    const verdict = validateAttachmentPaths(paths, this.deps.globs);
    if (verdict.ok) return;
    const message = {
      invalid_path: 'A path is not a listable document path',
      duplicate_path: 'A path is attached more than once',
      too_many_paths: 'Too many paths',
    }[verdict.code];
    throw new ValidationError(message, undefined, verdict.code);
  }

  private async requireRepo(workspaceId: string, repoId: string): Promise<ContextRepoRef> {
    const repo = await this.deps.store.findRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repository not found', undefined, 'repo_not_found');
    return repo;
  }

  private async requireAgent(workspaceId: string, agentId: string): Promise<void> {
    if (!(await this.deps.store.agentExists(workspaceId, agentId))) {
      throw new NotFoundError('Agent not found', undefined, 'agent_not_found');
    }
  }

  private async requireSkill(workspaceId: string, skillId: string): Promise<void> {
    if (!(await this.deps.store.skillExists(workspaceId, skillId))) {
      throw new NotFoundError('Skill not found', undefined, 'skill_not_found');
    }
  }
}
