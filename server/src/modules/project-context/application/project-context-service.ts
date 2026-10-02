import {
  PROJECT_CONTEXT_BUDGET_TOKENS,
  PROJECT_CONTEXT_MAX_DOCS,
  PROJECT_CONTEXT_MAX_DOC_BYTES,
  type ContextAttachments,
  type ContextAttachmentsInput,
  type ContextDoc,
  type ContextDocPreview,
  type ContextList,
} from '@devdigest/shared';
import type { TransactionRunner } from '../../../application/transaction.js';
import {
  InvalidInputError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../../platform/errors.js';
import { docNameOf, docTypeOf, checkPath, isListablePath, validateAttachmentPaths } from '../domain/paths.js';
import { checkStorePath } from '../domain/store-files.js';
import {
  applyBudget,
  buildRunDocList,
  projectContextLogLine,
  readFailure,
  toRunDoc,
} from '../domain/run-context.js';
import type { ReadOutcome, RunDocRef, SkillAttachmentSet } from '../domain/types.js';
import { storeDocPreview, tokensOf, usedByPath } from './doc-helpers.js';
import type {
  CloneDocs,
  ContextRepoRef,
  ContextStore,
  ResolveForRunInput,
  RunContextResult,
  RunGit,
} from './ports.js';

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

export class ProjectContextService {
  constructor(private readonly deps: ProjectContextDeps) {}

  /** GET /repos/:id/context — store files first, then the documents of the clone that the globs accept. */
  async listDocs(workspaceId: string, repoId: string): Promise<ContextList> {
    const repo = await this.requireRepo(workspaceId, repoId);
    const globs = [...this.deps.globs];
    const [stored, usage] = await Promise.all([this.deps.store.listFiles(repoId), this.deps.store.listUsage(repoId)]);
    const used = usedByPath(usage);
    const storeDocs: ContextDoc[] = stored.map((f) => ({
      path: f.path,
      name: docNameOf(f.path),
      doc_type: 'specs',
      size_bytes: f.sizeBytes,
      tokens: tokensOf(f.chars),
      updated_at: f.updatedAt.toISOString(),
      used_by: used.get(f.path)?.length ?? 0,
      source: 'store',
      editable: true,
      version: f.version,
    }));
    const listed = repo.clonePath
      ? await this.deps.docs.list(repo.clonePath, this.deps.globs, PROJECT_CONTEXT_MAX_DOCS)
      : null;
    // A store file wins over a clone file at the same path (the clone gained it later).
    const inStore = new Set(stored.map((f) => f.path));
    const repoDocs: ContextDoc[] = (listed?.docs ?? [])
      .filter((d) => !inStore.has(d.path))
      .map((d) => ({
        path: d.path,
        name: docNameOf(d.path),
        doc_type: docTypeOf(d.path),
        size_bytes: d.sizeBytes,
        tokens: tokensOf(d.chars),
        updated_at: d.updatedAt.toISOString(),
        used_by: used.get(d.path)?.length ?? 0,
        source: 'repo',
        editable: false,
      }));
    const docs = [...storeDocs, ...repoDocs];
    return {
      clone_status: listed ? 'ready' : 'not_cloned',
      globs,
      docs,
      tokens_total: docs.reduce((sum, d) => sum + d.tokens, 0),
      ...(listed?.truncated ? { truncated: true } : {}),
    };
  }

  /** GET /repos/:id/context/doc?path= — one store file or listable repo document, with who uses it. */
  async previewDoc(workspaceId: string, repoId: string, path: string): Promise<ContextDocPreview> {
    const repo = await this.requireRepo(workspaceId, repoId);
    const usage = usedByPath(await this.deps.store.listUsage(repoId));
    const stored = await this.deps.store.findFile(repoId, path);
    if (stored) return storeDocPreview(stored, usage.get(path) ?? []);
    // Shape, excluded directories and globs are all checked before any filesystem access (NFR3).
    // A store-shaped path passes too, so a deleted store file is a 404, not a 400.
    if (!isListablePath(path, this.deps.globs) && !checkStorePath(path)) {
      throw new InvalidInputError('Not a listable document path', undefined, 'invalid_path');
    }
    const read = repo.clonePath ? await this.deps.docs.read(repo.clonePath, path) : null;
    if (!read || read.status === 'not_found') throw new NotFoundError('Document not found', undefined, 'doc_not_found');
    if (read.status === 'too_large') {
      throw new PayloadTooLargeError('Document is too large to preview', undefined, 'doc_too_large');
    }
    const usedBy = usage.get(path) ?? [];
    return {
      path,
      name: docNameOf(path),
      doc_type: docTypeOf(path),
      content: read.content,
      tokens: tokensOf(read.content.length),
      size_bytes: read.sizeBytes,
      used_by: usedBy.length,
      used_by_agents: usedBy,
      source: 'repo',
      editable: false,
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
   * unreviewed head cannot rewrite the rules it is judged by). A DevDigest
   * store file is the exception: its latest saved text comes from the database
   * (trace `source: 'store'`), even when the base commit cannot be resolved. Never throws:
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

      // Store files are read from the database (the latest save), never from git.
      const stored = new Map(
        (
          await this.deps.store.findFiles(
            input.repoId,
            refs.map((r) => r.path).filter(checkStorePath),
          )
        ).map((f) => [f.path, f.content]),
      );
      const sha = await this.deps.git.resolveBaseCommit(input.repo, input.base, input.headSha);
      // No base commit: a repo that was never cloned has none of its documents ("missing");
      // a clone whose base commit cannot be resolved cannot be read ("unreadable").
      const missingClone =
        sha === null && (await this.deps.store.findRepo(input.workspaceId, input.repoId))?.clonePath == null;
      const read = await mapLimit(refs, RUN_READ_CONCURRENCY, async (ref) => {
        const text = stored.get(ref.path);
        if (text !== undefined) return toRunDoc(ref, { status: 'ok', text }, 'store');
        return toRunDoc(ref, await this.readAtBase(input, sha, missingClone, ref));
      });
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
