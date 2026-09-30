/**
 * Runtime config from env. The API has no auth and is meant to listen on
 * loopback only, so this server refuses to talk to a non-local host: it can
 * never be pointed at somebody else's DevDigest.
 */
export interface McpConfig {
  apiUrl: string;
  /** Per-HTTP-request timeout. */
  requestTimeoutMs: number;
  /** How often run_agent_on_pr polls the run status. */
  pollIntervalMs: number;
}

const DEFAULT_API_URL = 'http://127.0.0.1:3001';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * How long run_agent_on_pr waits for a run to finish before returning
 * status "running", measured from the tool call, not from when the HTTP
 * calls happen to start. Not model-settable (the tool has no wait argument):
 * a longer wait risks the MCP client backgrounding or killing the call.
 */
export const RUN_WAIT_MS = 120_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const raw = env.DEVDIGEST_API_URL?.trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DEVDIGEST_API_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`DEVDIGEST_API_URL must be http(s): ${raw}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`DEVDIGEST_API_URL must point at a loopback host (127.0.0.1 / localhost / ::1), got ${url.hostname}`);
  }
  return {
    apiUrl: url.origin,
    requestTimeoutMs: positiveInt(env.DEVDIGEST_MCP_REQUEST_TIMEOUT_MS, 30_000),
    pollIntervalMs: positiveInt(env.DEVDIGEST_MCP_POLL_INTERVAL_MS, 2_000),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
