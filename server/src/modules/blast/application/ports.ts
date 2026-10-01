/**
 * Ports of the blast use case. Infrastructure implements `BlastSource`
 * (infrastructure/repository.ts); the composition root adapts the repo-intel
 * facade to `BlastIndexReader`; tests pass in-memory fakes.
 */
import type { MergedPrSummary } from '@devdigest/shared';
import type { BlastResult } from '../domain/types.js';

/** A PR with what the blast read needs. */
export interface BlastPull {
  repoId: string;
  number: number;
  owner: string;
  name: string;
  /** Paths changed by the PR (persisted `pr_files`); [] for a never-opened PR. */
  files: string[];
}

export interface BlastSource {
  /** Workspace-scoped lookup — a PR from another workspace is `null` (→ 404). */
  findPull(workspaceId: string, prId: string): Promise<BlastPull | null>;
}

/** The index read (repo-intel's `getBlastRadius`, reached only from composition). */
export interface BlastIndexReader {
  getBlastRadius(repoId: string, changedFiles: string[]): Promise<BlastResult>;
}

/** Merged PRs of a repo with their changed paths (GitHub, via the container's github adapter in composition). */
export interface PriorPrSource {
  listMergedPullRequests(repo: { owner: string; name: string }, opts: { limit: number }): Promise<MergedPrSummary[]>;
}

/** Request-scoped logger (fastify's `req.log` satisfies it). */
export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}
