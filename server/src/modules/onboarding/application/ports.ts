/**
 * Ports of the onboarding use cases. Infrastructure implements the store, the
 * model and the file reader; the composition root adapts repo-intel (the index
 * read facade), settings + LLM and git onto the rest.
 */
import type { ChatMessage, OnboardingTour, Provider } from '@devdigest/shared';
import type { OnboardingLlmOutput } from '../domain/prompt.js';

/** A repo of the workspace, with what the prompt and the git reads need. */
export interface OnboardingRepo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface OnboardingStore {
  /** Workspace-scoped: a repo of another workspace is `null` (→ 404). */
  findRepo(workspaceId: string, repoId: string): Promise<OnboardingRepo | null>;
  /** The stored tour, or `null` when none exists or the stored JSON no longer matches the contract. */
  getTour(repoId: string): Promise<OnboardingTour | null>;
  /** Insert or replace the repo's tour. */
  upsertTour(repoId: string, tour: OnboardingTour): Promise<void>;
}

/** The slice of the repo-intel facade a tour is built from (structural: `RepoIntel` satisfies it). */
export interface RepoIndex {
  getIndexState(repoId: string): Promise<{ filesIndexed: number; lastIndexedSha: string }>;
  getRepoMap(repoId: string): Promise<{ text: string }>;
  /** Rank DESC, tests/configs filtered. */
  getTopFilesByRank(repoId: string, n: number): Promise<string[]>;
  getCriticalPaths(repoId: string): Promise<string[][]>;
  /** Every indexed file path — the set the model's paths are verified against. */
  listIndexedFiles(repoId: string): Promise<string[]>;
}

/** Files of the repo at a commit. Never throws: missing, oversize or unreadable → `null`. */
export interface RepoFiles {
  /** Texts in the order of `paths`; reads run with bounded concurrency and stop early on `signal`. */
  readMany(
    repo: { owner: string; name: string },
    sha: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<(string | null)[]>;
}

export interface ResolvedModel {
  provider: Provider;
  model: string;
}

export interface GenerateResult {
  data: OnboardingLlmOutput;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/** The workspace's `onboarding` feature model. */
export interface OnboardingModel {
  /** Cheap — no LLM call. */
  resolve(workspaceId: string): Promise<ResolvedModel>;
  /**
   * One structured call. Throws `ValidationError('provider_not_configured')` when the
   * provider has no key and `ExternalServiceError('generation_failed')` for any other failure.
   */
  generate(resolved: ResolvedModel, messages: ChatMessage[], signal: AbortSignal): Promise<GenerateResult>;
}

/** Request-scoped logger (fastify's `req.log` satisfies it). */
export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** Wall clock (injectable for tests). */
export type Clock = () => Date;
