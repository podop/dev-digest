/**
 * Ports of the ci use cases (specs/export-to-ci.md). Infrastructure implements the store and the
 * runner bundle; the composition root wires the agents, repos and GitHub ports.
 */
import type { CiInstallation, CiRun, GitHubClient } from '@devdigest/shared';
import type { ManifestSource } from '../domain/manifest.js';

/** Request-scoped pino-compatible logger (the Container exposes none): `(obj, msg)`. */
export interface CiLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** An agent as export sees it: the manifest source plus its linked AND enabled skills, in link order. */
export interface ExportAgent extends ManifestSource {
  id: string;
  skills: { name: string; body: string }[];
}

export interface AgentDirectory {
  /** undefined = not an agent of the workspace. */
  get(workspaceId: string, agentId: string): Promise<ExportAgent | undefined>;
  exists(workspaceId: string, agentId: string): Promise<boolean>;
}

/** A repository imported into the workspace. */
export interface ImportedRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface RepoDirectory {
  findByFullName(workspaceId: string, fullName: string): Promise<ImportedRepo | undefined>;
}

/** The built agent-runner bundle (`dist/index.js`) as text; null when it is not built. */
export interface RunnerBundle {
  read(): Promise<string | null>;
}

export interface NewInstallation {
  agentId: string;
  repo: string;
  slug: string;
  manifestVersion: number;
}

export type UpsertInstallationResult =
  | { kind: 'saved' }
  /** (repo, slug) belongs to another agent — a lost race against the pre-check. */
  | { kind: 'slug_taken' };

/** One workflow run ready to be stored (already verified by the use case). */
export interface NewCiRun {
  workspaceId: string;
  installationId: string;
  agentId: string;
  githubRunId: number;
  runAttempt: number;
  headSha: string;
  githubUrl: string;
  ranAt: Date;
  prNumber: number | null;
  manifestVersion: number | null;
  status: 'succeeded' | 'no_findings' | 'failed';
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  findingsCount: number;
  blockers: number;
  /** Failure reason of a `failed` run. */
  error: string | null;
}

export interface CiStore {
  /** Workspace installations of target `gha`, newest export first, each with its last run; optionally of one agent. */
  listInstallations(workspaceId: string, filter?: { agentId?: string }): Promise<CiInstallation[]>;
  /** The agent's installation in `repo`, with its last run. */
  findInstallation(workspaceId: string, agentId: string, repo: string): Promise<CiInstallation | undefined>;
  /** Agent that owns `slug` in `repo`, if any. */
  slugOwner(repo: string, slug: string): Promise<string | undefined>;
  upsertInstallation(values: NewInstallation): Promise<UpsertInstallationResult>;
  /** Which of these GitHub run ids + attempts are already stored (keys `${id}:${attempt}`). */
  storedRunKeys(runs: { id: number; attempt: number }[]): Promise<Set<string>>;
  /** One transaction: `agent_runs` + `ci_runs`. A duplicate (id, attempt) writes nothing and returns false. */
  recordRun(run: NewCiRun): Promise<boolean>;
  /** Newest first, scoped by the agent run's workspace. */
  listRuns(workspaceId: string, filter: { agentId?: string; limit: number }): Promise<CiRun[]>;
}

export type GitHubProvider = () => Promise<GitHubClient>;

/** YAML text <-> plain values; the domain only ever sees the parsed values. */
export interface YamlCodec {
  /** Throws on malformed YAML. */
  parse(text: string): unknown;
  stringify(value: unknown): string;
}

export type ZipEntryResult =
  | { kind: 'entry'; bytes: Uint8Array }
  /** The entry is declared or inflates larger than the limit (nothing was parsed). */
  | { kind: 'too_large' }
  | { kind: 'missing' }
  /** Not a readable ZIP. */
  | { kind: 'invalid' };

/** Reads one named entry out of a ZIP, enforcing the entry size limit before inflating it. */
export interface ZipEntryReader {
  read(zip: Uint8Array, entryName: string, maxEntryBytes: number): ZipEntryResult;
}
