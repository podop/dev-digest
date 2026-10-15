/** ci_installations / ci_runs rows → contract DTOs (infrastructure: they know the row shapes). */
import type { CiInstallation, CiRun } from '@devdigest/shared';
import { workflowPathFor } from '../domain/constants.js';

/** A `ci_runs` row joined with its `agent_runs` row, the agent name and the installation repo. */
export interface CiRunRow {
  id: string;
  installationId: string | null;
  agentId: string | null;
  agentName: string | null;
  repo: string | null;
  prNumber: number | null;
  ranAt: Date | null;
  status: string | null;
  findingsCount: number | null;
  costUsd: number | null;
  githubUrl: string | null;
  durationMs: number | null;
  blockers: number | null;
  headSha: string | null;
  manifestVersion: number | null;
}

export interface CiInstallationRow {
  id: string;
  agentId: string;
  repo: string;
  targetType: CiInstallation['target_type'];
  installedAt: Date;
  slug: string | null;
  manifestVersion: number | null;
}

/** `https://github.com/<owner>/<name>/actions/runs/<id>` → `owner/name` (the installation may be gone). */
function repoFromRunUrl(url: string | null): string | null {
  const match = url ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(url) : null;
  return match?.[1] ?? null;
}

export function toCiRun(row: CiRunRow): CiRun {
  const failed = row.status === 'failed';
  return {
    id: row.id,
    ci_installation_id: row.installationId,
    agent_id: row.agentId,
    agent: row.agentName,
    repo: row.repo ?? repoFromRunUrl(row.githubUrl),
    pr_number: row.prNumber,
    ran_at: row.ranAt?.toISOString() ?? null,
    status: row.status,
    // A run without a result has no verdict; otherwise blockers decide (FR23).
    verdict: failed ? null : (row.blockers ?? 0) > 0 ? 'blocked' : 'passed',
    findings_count: row.findingsCount,
    blockers: row.blockers,
    cost_usd: row.costUsd,
    duration_s: row.durationMs === null ? null : row.durationMs / 1000,
    github_url: row.githubUrl,
    head_sha: row.headSha,
    manifest_version: row.manifestVersion,
    source: 'gha',
  };
}

export function toCiInstallation(row: CiInstallationRow, lastRun: CiRun | null): CiInstallation {
  return {
    id: row.id,
    agent_id: row.agentId,
    repo: row.repo,
    target_type: row.targetType,
    installed_at: row.installedAt.toISOString(),
    slug: row.slug,
    workflow_path: row.slug ? workflowPathFor(row.slug) : null,
    manifest_version: row.manifestVersion,
    last_run: lastRun,
  };
}
