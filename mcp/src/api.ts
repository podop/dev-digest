import type {
  Agent,
  ConventionsState,
  PrMeta,
  Repo,
  ReviewRecord,
  ReviewRunResponse,
  RunSummary,
} from '@devdigest/shared';
import { ToolError } from './errors.js';

/**
 * The ONLY way this server reaches DevDigest: a closed set of calls to the
 * local HTTP API. There is no generic `request(path)` on purpose — the tools
 * can read agents / repos / PRs / runs / reviews / conventions, start a review
 * and cancel a run they started, and nothing else (no deletes, no finding
 * actions, no settings, no secrets). Workspace scoping and input validation
 * stay in the API's domain code.
 */
export interface DevDigestApi {
  listAgents(signal?: AbortSignal): Promise<Agent[]>;
  listRepos(signal?: AbortSignal): Promise<Repo[]>;
  listPulls(repoId: string, signal?: AbortSignal): Promise<PrMeta[]>;
  startReview(prId: string, agentId: string, signal?: AbortSignal): Promise<ReviewRunResponse>;
  listRuns(prId: string, signal?: AbortSignal): Promise<RunSummary[]>;
  cancelRun(runId: string): Promise<void>;
  listReviews(prId: string, signal?: AbortSignal): Promise<ReviewRecord[]>;
  getConventions(repoId: string, signal?: AbortSignal): Promise<ConventionsState>;
}

export interface HttpApiOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  fetch?: typeof fetch;
}

const START_API_HINT = 'Start the DevDigest API (./scripts/dev.sh, or `cd server && pnpm dev`) and call the tool again.';

export function createHttpApi(opts: HttpApiOptions): DevDigestApi {
  const doFetch = opts.fetch ?? fetch;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(opts.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeout.aborted) {
        throw new ToolError(
          'api_timeout',
          `DevDigest API did not answer ${method} ${path} within ${opts.requestTimeoutMs} ms.`,
          'Check that the API is healthy (GET /health/ready), then call the tool again.',
        );
      }
      throw new ToolError('api_unreachable', `DevDigest API is not reachable at ${opts.baseUrl}.`, START_API_HINT);
    }
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) throw httpError(res.status, method, path, payload);
    return payload;
  }

  return {
    listAgents: async (signal) => list<Agent>('agents', AGENT_KEYS, await call('GET', '/agents', undefined, signal)),
    listRepos: async (signal) => list<Repo>('repos', REPO_KEYS, await call('GET', '/repos', undefined, signal)),
    listPulls: async (repoId, signal) =>
      list<PrMeta>('pull requests', PULL_KEYS, await call('GET', `/repos/${enc(repoId)}/pulls`, undefined, signal)),
    startReview: async (prId, agentId, signal) =>
      object<ReviewRunResponse>('review start', RUN_START_KEYS, await call('POST', `/pulls/${enc(prId)}/review`, { agentId }, signal)),
    listRuns: async (prId, signal) => list<RunSummary>('runs', RUN_KEYS, await call('GET', `/pulls/${enc(prId)}/runs`, undefined, signal)),
    cancelRun: async (runId) => {
      await call('POST', `/runs/${enc(runId)}/cancel`);
    },
    listReviews: async (prId, signal) =>
      list<ReviewRecord>('reviews', REVIEW_KEYS, await call('GET', `/pulls/${enc(prId)}/reviews`, undefined, signal)),
    getConventions: async (repoId, signal) =>
      object<ConventionsState>('conventions', CONVENTIONS_KEYS, await call('GET', `/repos/${enc(repoId)}/conventions`, undefined, signal)),
  };
}

/*
 * Response contract check. The types come from @devdigest/shared, imported
 * type-only (its zod schemas belong to the server's zod instance), so there is
 * no runtime schema to parse with. Each call checks the fields the tools read
 * and turns a mismatch into `api_contract` with a next step instead of a
 * TypeError deep inside a tool; the cast after the check is deliberate.
 */
const AGENT_KEYS = ['id', 'name', 'description', 'provider', 'model', 'enabled', 'ci_fail_on'] as const;
const REPO_KEYS = ['id', 'full_name'] as const;
const PULL_KEYS = ['number', 'title'] as const;
const RUN_START_KEYS = ['runs'] as const;
const RUN_KEYS = ['run_id', 'status'] as const;
const REVIEW_KEYS = ['run_id', 'agent_id', 'kind', 'findings', 'created_at'] as const;
const CONVENTIONS_KEYS = ['scan', 'conventions'] as const;

function hasKeys(value: unknown, keys: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && keys.every((k) => k in value);
}

function contractError(what: string): ToolError {
  return new ToolError(
    'api_contract',
    `DevDigest API returned an unexpected ${what} response (fields devdigest-mcp reads are missing).`,
    'The API and devdigest-mcp are out of sync: run both from the same checkout (git pull, restart the API), then retry.',
  );
}

function list<T>(what: string, keys: readonly string[], value: unknown): T[] {
  if (!Array.isArray(value) || !value.every((item) => hasKeys(item, keys))) throw contractError(what);
  return value as T[];
}

function object<T>(what: string, keys: readonly string[], value: unknown): T {
  if (!hasKeys(value, keys)) throw contractError(what);
  return value as T;
}

const enc = encodeURIComponent;

/** Map the API's `{ error: { code, message } }` envelope to a ToolError with a next step. */
function httpError(status: number, method: string, path: string, payload: unknown): ToolError {
  const envelope = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const apiCode = typeof envelope?.code === 'string' ? envelope.code : `http_${status}`;
  const message = typeof envelope?.message === 'string' ? envelope.message : `${method} ${path} failed with HTTP ${status}.`;
  if (status === 429) {
    return new ToolError('rate_limited', message, 'The API rate-limits reviews (10/min). Wait a minute, then call the tool again.');
  }
  if (status === 404) {
    return new ToolError(apiCode, message, 'Re-resolve the id: call list_agents, or check the repo / PR number.');
  }
  if (status >= 500) {
    return new ToolError(apiCode, message, 'This is a DevDigest server error; check the API log (dev.sh terminal). Retrying will likely fail the same way.');
  }
  return new ToolError(apiCode, message, 'Fix the arguments according to the message and call the tool again.');
}
