import type { Agent, PrMeta, Repo } from '@devdigest/shared';
import type { DevDigestApi } from './api.js';
import { ToolError } from './errors.js';

/** A PR that has a DevDigest id (imported, so reviews can run on it). */
export type ResolvedPull = PrMeta & { id: string };

const LIST_LIMIT = 15;

/** "owner/name", "github.com/owner/name" or a full https URL (optionally ending in .git or /pull/N). */
export function parseRepoRef(ref: string): string | null {
  const m = ref
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^github\.com\//i, '')
    .match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export async function resolveRepo(api: DevDigestApi, ref: string, signal?: AbortSignal): Promise<Repo> {
  const wanted = parseRepoRef(ref);
  if (!wanted) {
    throw new ToolError('invalid_repo', `"${ref}" is not a repository reference.`, 'Pass the repo as "owner/name", e.g. "acme/payments-api".');
  }
  const repos = await api.listRepos(signal);
  const repo = repos.find((r) => r.full_name.toLowerCase() === wanted);
  if (!repo) {
    const known = repos.map((r) => r.full_name).slice(0, LIST_LIMIT);
    throw new ToolError(
      'repo_not_imported',
      `Repository ${wanted} is not imported in DevDigest. Imported: ${known.length ? known.join(', ') : 'none'}.`,
      'Use one of the imported repos, or add this one in the DevDigest UI (Repositories → Add). This MCP server does not import repositories.',
    );
  }
  return repo;
}

export async function resolvePull(
  api: DevDigestApi,
  repo: Repo,
  prNumber: number,
  signal?: AbortSignal,
): Promise<ResolvedPull> {
  const pulls = await api.listPulls(repo.id, signal);
  const pr = pulls.find((p) => p.number === prNumber);
  if (!pr?.id) {
    const known = pulls
      .map((p) => p.number)
      .sort((a, b) => b - a)
      .slice(0, LIST_LIMIT);
    throw new ToolError(
      'pr_not_found',
      `PR #${prNumber} is not imported for ${repo.full_name}. Known PRs: ${known.length ? known.map((n) => `#${n}`).join(', ') : 'none'}.`,
      'Check the number (e.g. `gh pr list`). If the PR is new, open the repo in DevDigest so it syncs PRs from GitHub (needs a GitHub token in Settings), then retry.',
    );
  }
  return { ...pr, id: pr.id };
}

/** Match by id, else by name (case-insensitive, exact first, then unique substring). */
export async function resolveAgent(api: DevDigestApi, ref: string, signal?: AbortSignal): Promise<Agent> {
  const agents = await api.listAgents(signal);
  const needle = ref.trim().toLowerCase();
  const byId = agents.find((a) => a.id === ref.trim());
  const exact = agents.filter((a) => a.name.toLowerCase() === needle);
  const partial = agents.filter((a) => a.name.toLowerCase().includes(needle));
  const candidates = byId ? [byId] : exact.length ? exact : partial;
  const names = agents.map((a) => a.name).join(', ');

  if (candidates.length === 0) {
    throw new ToolError('agent_not_found', `No DevDigest agent matches "${ref}". Agents: ${names || 'none'}.`, 'Call list_agents and pass an exact agent name or id.');
  }
  if (candidates.length > 1) {
    throw new ToolError(
      'agent_ambiguous',
      `"${ref}" matches several agents: ${candidates.map((a) => `${a.name} (${a.id})`).join(', ')}.`,
      'Pass the exact name or the id of one of them.',
    );
  }
  const agent = candidates[0]!;
  if (!agent.enabled) {
    throw new ToolError(
      'agent_disabled',
      `Agent "${agent.name}" is disabled in DevDigest.`,
      'Pick an enabled agent from list_agents, or ask the user to enable this one in DevDigest (Agents).',
    );
  }
  return agent;
}
