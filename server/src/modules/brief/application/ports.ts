/**
 * Ports of the PR Brief use cases. Infrastructure implements the store, the model
 * and the issue source; the composition root adapts the sibling modules (intent,
 * blast, project context) onto the rest — never their internals.
 */
import type { BlastRadius, ChatMessage, Intent, PrBrief, Provider, Severity } from '@devdigest/shared';
import type { BriefLlmOutput } from '../domain/prompt.js';

/** A PR of the workspace with what the generation and the stale check need. */
export interface BriefPull {
  id: string;
  repoId: string;
  repo: { owner: string; name: string };
  title: string;
  body: string | null;
  base: string;
  headSha: string;
}

/** A stored changed file; `patch` is read only to take hunk-header ranges from it. */
export interface BriefFileRow {
  path: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface BriefFindingRow {
  severity: Severity;
  file: string;
  startLine: number;
  endLine: number;
  title: string;
}

/** The newest `kind='review'` row of one agent, with its findings. */
export interface CurrentReview {
  agentId: string | null;
  createdAt: Date;
  findings: BriefFindingRow[];
}

export interface BriefStore {
  /** Workspace-scoped: a PR of another workspace is `null` (→ 404). */
  findPull(workspaceId: string, prId: string): Promise<BriefPull | null>;
  listFiles(prId: string): Promise<BriefFileRow[]>;
  /** One review per agent (the newest), newest review first. `[]` with no review. */
  currentReviews(prId: string): Promise<CurrentReview[]>;
  /** The agent's linked, ENABLED skills in link order. */
  enabledSkills(agentId: string): Promise<{ id: string; name: string }[]>;
  /** The stored brief, or `null` when none exists or the stored JSON no longer matches the contract. */
  getBrief(prId: string): Promise<PrBrief | null>;
  /** Insert or replace the PR's brief. */
  upsertBrief(prId: string, brief: PrBrief): Promise<void>;
}

/** The stored intent as the brief snapshots it; `null` = never derived. */
export interface IntentSource {
  get(workspaceId: string, prId: string): Promise<Intent | null>;
}

/** The blast radius of a PR (computed per read, no model call). May throw — the service treats that as degraded. */
export interface BlastSource {
  getBlast(workspaceId: string, prId: string, log: Logger): Promise<BlastRadius>;
}

/** One attached document as the run-context resolution reports it (structural subset of the project-context result). */
export interface SpecDocResult {
  path: string;
  status: 'included' | 'missing' | 'too_large' | 'over_budget' | 'unreadable';
  text?: string;
}

export interface SpecsResolver {
  /** Never throws (project context degrades to no documents). Docs in prompt order. */
  resolveForRun(input: {
    workspaceId: string;
    repoId: string;
    repo: { owner: string; name: string };
    base: string;
    headSha: string;
    agentId: string;
    skills: { id: string; name: string; enabled: boolean }[];
  }): Promise<{ docs: SpecDocResult[] }>;
}

/** The linked issue; `null` when it could not be fetched in time. Never throws. */
export interface IssueSource {
  fetch(repo: { owner: string; name: string }, issueNumber: number): Promise<{ number: number; title: string; body: string | null } | null>;
}

export interface ResolvedModel {
  provider: Provider;
  model: string;
}

export interface ModelUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

export interface GenerateResult {
  data: BriefLlmOutput;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  /** Model requests made (1, or 2 after a schema re-ask). */
  attempts: number;
}

/** The workspace's `risk_brief` feature model. */
export interface BriefModel {
  /** Cheap — no LLM call. */
  resolve(workspaceId: string): Promise<ResolvedModel>;
  /**
   * One structured call. `onUsage` fires once per received response. Throws
   * `ValidationError('provider_not_configured')` when the provider has no key and
   * `ExternalServiceError('generation_failed')` for any other failure.
   */
  generate(
    resolved: ResolvedModel,
    messages: ChatMessage[],
    signal: AbortSignal,
    onUsage: (usage: ModelUsage) => void,
  ): Promise<GenerateResult>;
}

/** Request-scoped logger (fastify's `req.log` satisfies it). */
export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** Wall clock (injectable for tests). */
export type Clock = () => Date;
