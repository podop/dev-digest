import { CiResultArtifact } from '@devdigest/shared';

export type ArtifactReadResult =
  | { ok: true; artifact: CiResultArtifact }
  | { ok: false; reason: 'artifact_too_large' | 'artifact_invalid' };

/**
 * Parse the bytes of `devdigest-result.json` (FR20, NFR5): strict UTF-8, JSON, then the shared
 * `CiResultArtifact` schema. The size limits are enforced before this — by the use case (zip
 * length) and the zip reader (entry size) — so nothing oversized reaches the parser.
 */
export function parseResultArtifact(bytes: Uint8Array): ArtifactReadResult {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: 'artifact_invalid' };
  }
  const parsed = CiResultArtifact.safeParse(json);
  return parsed.success ? { ok: true, artifact: parsed.data } : { ok: false, reason: 'artifact_invalid' };
}

/** The GitHub run facts an artifact is verified against. */
export interface RunFacts {
  head_sha: string;
  repository_id: number;
  /** Workflow file path as GitHub reports it (may carry an `@ref` suffix). */
  path: string;
}

/**
 * NFR4: the artifact's own claims must match what GitHub says about the run —
 * `commit_sha` = head sha, `repository_id` = repository id — and the run must
 * come from the installation's workflow file. Ingest requires both claims.
 */
export function verifyArtifact(
  artifact: CiResultArtifact,
  run: RunFacts,
  workflowPath: string,
): boolean {
  if (artifact.commit_sha == null || artifact.repository_id == null) return false;
  return (
    artifact.commit_sha === run.head_sha &&
    artifact.repository_id === run.repository_id &&
    run.path.split('@')[0] === workflowPath
  );
}

export type GithubErrorCode =
  | 'github_permission_denied'
  | 'github_rate_limited'
  | 'github_unavailable';

/** HTTP status carried by an Octokit / adapter error, if any. */
export function githubStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Map a GitHub failure to the refresh error code (EC8). Never includes message text. */
export function githubErrorCode(err: unknown): GithubErrorCode {
  const status = githubStatus(err);
  if (status === 429) return 'github_rate_limited';
  if (status === 401 || status === 403) {
    const remaining = (err as { response?: { headers?: Record<string, unknown> } } | null)?.response
      ?.headers?.['x-ratelimit-remaining'];
    return remaining === '0' || remaining === 0 ? 'github_rate_limited' : 'github_permission_denied';
  }
  return 'github_unavailable';
}
