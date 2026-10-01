import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Agent, BlastRadius, Convention, ConventionsState, FindingRecord, PrMeta, Repo, ReviewRecord, RunSummary } from '@devdigest/shared';
import type { DevDigestApi } from '../src/api.js';
import { createServer } from '../src/server.js';
import { abortableSleep, type ToolDeps } from '../src/tools/shared.js';

export const REPO: Repo = {
  id: '00000000-0000-4000-8000-000000000001',
  workspace_id: 'ws',
  owner: 'podop',
  name: 'dev-digest',
  full_name: 'podop/dev-digest',
  default_branch: 'main',
  clone_path: null,
  last_polled_at: null,
  created_by: null,
};

export const PR: PrMeta = {
  id: '00000000-0000-4000-8000-000000000003',
  number: 3,
  title: 'Feat/audit improvements',
  author: 'podop',
  branch: 'feat/audit',
  base: 'main',
  head_sha: 'abc',
  additions: 10,
  deletions: 2,
  files_count: 1,
  status: 'open',
};

export function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    name: 'Security Reviewer',
    description: 'Finds security issues',
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    system_prompt: 'SECRET PROMPT TEXT',
    enabled: true,
    version: 1,
    strategy: 'single-pass',
    ci_fail_on: 'critical',
    repo_intel: true,
    ...over,
  };
}

export function finding(over: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: 'f1',
    severity: 'CRITICAL',
    category: 'security',
    title: 'SQL injection',
    file: 'src/db.ts',
    start_line: 10,
    end_line: 12,
    rationale: 'User input reaches the query unescaped.',
    suggestion: 'Use a parameterized query.',
    confidence: 0.9,
    review_id: 'r1',
    accepted_at: null,
    dismissed_at: null,
    ...over,
  };
}

export function review(over: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: 'r1',
    pr_id: PR.id!,
    agent_id: agent().id,
    run_id: 'run-1',
    agent_name: 'Security Reviewer',
    kind: 'review',
    verdict: 'request_changes',
    score: 40,
    summary: 'One injection.',
    model: 'm',
    created_at: '2026-09-30T10:00:00.000Z',
    findings: [finding()],
    ...over,
  };
}

export function convention(over: Partial<Convention> = {}): Convention {
  return {
    id: 'c1',
    repo_id: REPO.id!,
    scan_id: 's1',
    category: 'naming',
    rule: 'Use camelCase for variables.',
    evidence: [{ path: 'src/index.ts', start_line: 1, end_line: 2, snippet: 'const fooBar = 1;' }],
    confidence: 0.8,
    status: 'accepted',
    edited: false,
    skill_id: null,
    created_at: '2026-09-30T10:00:00.000Z',
    updated_at: '2026-09-30T10:00:00.000Z',
    ...over,
  };
}

export function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'run-1',
    agent_id: agent().id,
    agent_name: 'Security Reviewer',
    provider: 'openrouter',
    model: 'm',
    status: 'done',
    error: null,
    duration_ms: 1234,
    tokens_in: 1,
    tokens_out: 1,
    cost_usd: 0.01,
    findings_count: 1,
    grounding: null,
    ran_at: null,
    score: 40,
    blockers: 1,
    ...over,
  };
}

export function blast(over: Partial<BlastRadius> = {}): BlastRadius {
  return {
    changed_symbols: [{ file: 'src/rate-limit.ts', name: 'rateLimit', kind: 'function' }],
    downstream: [
      {
        symbol: 'rateLimit',
        callers: [
          { name: 'publicRouter', file: 'src/router.ts', line: 23 },
          { name: 'webhookRoute', file: 'src/webhooks.ts', line: 8 },
          { name: 'sweep', file: 'src/cron.ts', line: 5 },
        ],
        endpoints_affected: ['GET /public', 'POST /webhooks'],
        crons_affected: ['nightly-sweep'],
      },
    ],
    summary: '1 changed symbol · 3 callers · 2 endpoints · 1 cron',
    ...over,
  };
}

/** A scriptable fake of the API; override any method per test. */
export function fakeApi(over: Partial<DevDigestApi> = {}): DevDigestApi {
  const conventions: ConventionsState = { scan: null, conventions: [] };
  return {
    listAgents: async () => [agent()],
    listRepos: async () => [REPO],
    listPulls: async () => [PR],
    startReview: async () => ({ pr_id: PR.id!, runs: [{ run_id: 'run-1', agent_id: agent().id, agent_name: 'Security Reviewer' }], reviews: [] }),
    listRuns: async () => [runSummary()],
    cancelRun: async () => undefined,
    listReviews: async () => [review()],
    getConventions: async () => conventions,
    getBlastRadius: async () => blast(),
    ...over,
  };
}

export async function connect(api: DevDigestApi, over: Partial<Omit<ToolDeps, 'api'>> = {}): Promise<Client> {
  const server = createServer({ api, pollIntervalMs: 1, runWaitMs: 120_000, now: Date.now, sleep: abortableSleep, ...over });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

/** A deterministic clock for run-wait tests: `sleep` resolves without a real timer, advancing `now` by `ms`. */
export function fakeClock(start = 0): Pick<ToolDeps, 'now' | 'sleep'> {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      current += ms;
    },
  };
}

export function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? '').join('\n');
}
