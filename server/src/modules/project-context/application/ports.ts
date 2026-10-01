/**
 * Ports of the project-context use cases. Infrastructure implements
 * `ContextStore` (infrastructure/repository.ts, Drizzle) and `CloneDocs`
 * (infrastructure/clone-docs.ts, local fs); tests pass in-memory fakes.
 */

import type { GitClient, ProjectContextTraceDoc } from '@devdigest/shared';

/** A repo of the workspace, with where its clone lives (null until cloned). */
export interface ContextRepoRef {
  id: string;
  owner: string;
  name: string;
  clonePath: string | null;
}

/** One "agent X uses document P in this repo" fact (direct or via a linked skill). */
export interface UsageRow {
  path: string;
  agentId: string;
  agentName: string;
  via: 'direct' | 'skill';
  /** Set when `via` is `skill`. */
  skillName: string | null;
}

export interface ContextStore {
  /** Workspace-scoped: a repo of another workspace is `null` (→ 404). */
  findRepo(workspaceId: string, repoId: string): Promise<ContextRepoRef | null>;
  /** Workspace-scoped existence checks (→ 404 when false). */
  agentExists(workspaceId: string, agentId: string): Promise<boolean>;
  skillExists(workspaceId: string, skillId: string): Promise<boolean>;
  /** Every attachment of the repo, joined to the agents that use it. Ordered by agent name. */
  listUsage(repoId: string): Promise<UsageRow[]>;
  /** The owner's attached paths in this repo, in order. */
  getAgentPaths(agentId: string, repoId: string): Promise<string[]>;
  getSkillPaths(skillId: string, repoId: string): Promise<string[]>;
  /** Replace the whole list (order = array order). Serialised per owner. */
  replaceAgentPaths(agentId: string, repoId: string, paths: readonly string[]): Promise<void>;
  replaceSkillPaths(skillId: string, repoId: string, paths: readonly string[]): Promise<void>;
}

/** A document found in a clone. `chars` is the text length (the byte size when too large to read). */
export interface ClonedDocInfo {
  path: string;
  sizeBytes: number;
  chars: number;
  updatedAt: Date;
}

export interface ClonedDocList {
  docs: ClonedDocInfo[];
  /** More documents matched than `limit`; `docs` holds the first `limit` by path. */
  truncated: boolean;
}

export type ClonedDocRead =
  | { status: 'ok'; content: string; sizeBytes: number }
  | { status: 'not_found' }
  | { status: 'too_large' };

export interface CloneDocs {
  /** Matching `.md` files of a clone, by path, at most `limit`. `null` when the clone directory is unreadable. */
  list(root: string, globs: readonly string[], limit: number): Promise<ClonedDocList | null>;
  /** Read one document. The caller has already run the path gates (shape, exclusions, globs). */
  read(root: string, path: string): Promise<ClonedDocRead>;
}

/** Git reads a run needs: the base commit and files at it (never the clone working tree). */
export type RunGit = Pick<GitClient, 'resolveBaseCommit' | 'readFileAt'>;

/** A skill linked to the running agent, in prompt order. */
export interface RunSkillRef {
  id: string;
  name: string;
  /** A disabled skill contributes no documents (EC10). */
  enabled: boolean;
}

export interface ResolveForRunInput {
  workspaceId: string;
  repoId: string;
  /** Addresses the clone for git reads. */
  repo: { owner: string; name: string };
  /** The PR's base branch name and head commit. */
  base: string;
  headSha: string;
  agentId: string;
  skills: readonly RunSkillRef[];
  /** Called once with a content-free reason when the resolution failed (the run goes on without documents). */
  onWarn?: (reason: string) => void;
}

export interface RunContextResult {
  /** Every attached document with its status, in prompt order (the trace record). */
  docs: ProjectContextTraceDoc[];
  /** The included documents, ready for the prompt. */
  included: { path: string; text: string }[];
  tokensTotal: number;
  budgetTokens: number;
  /** `project context: N included, M skipped · ~T tokens`; empty when there are no documents. */
  logLine: string;
}
