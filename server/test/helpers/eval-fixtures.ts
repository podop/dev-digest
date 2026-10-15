/** Shared fixtures of the eval pipeline integration tests (LLM double, case/agent rows, polling). */
import type { FastifyInstance } from 'fastify';
import type {
  ChatMessage,
  EvalRunDetail,
  LLMProvider,
  Review,
  StructuredRequest,
  StructuredResult,
} from '@devdigest/shared';
import type { Db } from '../../src/db/client.js';
import * as t from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/platform/config.js';
import { MockGitClient, MockGitHubClient } from '../../src/adapters/mocks.js';

export type ReviewFinding = Review['findings'][number];

/** One-file diff whose added line 11 is unique per `n` (so a case can be told apart in a prompt). */
export const caseDiff = (n: number) =>
  `diff --git a/src/config.ts b/src/config.ts\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey${n}: "sk_live_xxx",\n   redisUrl: x,`;

/** A finding citing line 11 of src/config.ts (grounded against `caseDiff`) or, with `line`, another line. */
export function finding(title: string, line = 11): ReviewFinding {
  return {
    id: `f-${title}`,
    severity: 'CRITICAL',
    category: 'security',
    title,
    file: 'src/config.ts',
    start_line: line,
    end_line: line,
    rationale: 'A live key is committed.',
    suggestion: 'Use an env var.',
    confidence: 0.9,
    kind: 'finding',
    skill: null,
  };
}

export interface LlmCall {
  messages: ChatMessage[];
  temperature: number | undefined;
  model: string;
}

/** Deterministic LLM double: records inputs, tracks concurrency, reports a cost per call, answers via `script`. */
export class ScriptedLLM implements LLMProvider {
  readonly id = 'openai' as const;
  readonly calls: LlmCall[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    private readonly script: (call: { user: string; index: number }) => Promise<ReviewFinding[]> | ReviewFinding[] = () => [],
    private readonly costUsd: number | null = 0.01,
  ) {}

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const index = this.calls.length;
    this.calls.push({ messages: req.messages, temperature: req.temperature, model: req.model });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const findings = await this.script({ user: req.messages[1]!.content, index });
      const usage = { tokensIn: 10, tokensOut: 5, costUsd: this.costUsd };
      req.onUsage?.(usage);
      const review = { verdict: 'comment', summary: 's', score: 80, findings };
      return { data: req.schema.parse(review), model: req.model, ...usage, raw: JSON.stringify(review), attempts: 1 };
    } finally {
      this.active--;
    }
  }
  async listModels() {
    return [];
  }
  async complete(): Promise<never> {
    throw new Error('not used');
  }
  async embed() {
    return [];
  }
}

/** A promise settled from outside — holds LLM calls until the test releases them. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

export function buildEvalApp(
  db: Db,
  llm: LLMProvider,
  env: Record<string, string> = {},
): Promise<FastifyInstance> {
  return buildApp({
    config: loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      REVIEW_INTENT_ENABLED: 'false',
      ...env,
    } as NodeJS.ProcessEnv),
    db,
    // Every provider id is injected: an agent on a provider without an override would make a real call.
    overrides: {
      git: new MockGitClient(),
      github: new MockGitHubClient({ pulls: [] }),
      llm: { openai: llm, anthropic: llm, openrouter: llm },
    },
  });
}

let seq = 0;

export async function insertAgent(
  db: Db,
  workspaceId: string,
  overrides: Partial<typeof t.agents.$inferInsert> = {},
) {
  const [agent] = await db
    .insert(t.agents)
    .values({
      workspaceId,
      name: `eval-run-agent-${++seq}`,
      provider: 'openai',
      model: 'gpt-4o',
      systemPrompt: 'You are the eval reviewer.',
      ...overrides,
    })
    .returning();
  return agent!;
}

/** `n` must_find cases of the agent, created one second apart (the run order). */
export async function insertCases(db: Db, workspaceId: string, agentId: string, n: number, from = 0) {
  const base = Date.now() - 3_600_000;
  const rows = await db
    .insert(t.evalCases)
    .values(
      Array.from({ length: n }, (_, i) => ({
        workspaceId,
        ownerKind: 'agent' as const,
        ownerId: agentId,
        name: `case-${from + i}`,
        inputDiff: caseDiff(from + i),
        inputMeta: { pr_title: 'Add rate limiting', pr_description: 'PR body', repo: 'acme/api', pr_number: 7, head_sha: 'abc' },
        expectedOutput: {
          kind: 'must_find',
          file: 'src/config.ts',
          start_line: 11,
          end_line: 11,
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded key',
        },
        createdAt: new Date(base + (from + i) * 1000),
      })),
    )
    .returning();
  return rows;
}

/** Poll the run until it leaves `running` (or fail after `timeoutMs`). */
export async function waitForRun(app: FastifyInstance, runId: string, timeoutMs = 15_000): Promise<EvalRunDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/eval-runs/${runId}` });
    const body = res.json() as EvalRunDetail;
    if (res.statusCode === 200 && body.run.status !== 'running') return body;
    if (Date.now() > deadline) throw new Error(`run ${runId} still running after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
