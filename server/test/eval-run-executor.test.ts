import { describe, it, expect } from 'vitest';
import PQueue from 'p-queue';
import type {
  ChatMessage,
  EvalRunDetail,
  EvalRunSummary,
  LLMProvider,
  Review,
  StructuredRequest,
  StructuredResult,
} from '@devdigest/shared';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';
import { EvalRunExecutor } from '../src/modules/evals/application/run-executor.js';
import { EvalRunsService } from '../src/modules/evals/application/eval-runs-service.js';
import type { EvalLogger, EvalRunsStore, InsertRunResult } from '../src/modules/evals/application/ports.js';
import { aggregateRun, scoreCase } from '../src/modules/evals/domain/scoring.js';
import type {
  CaseRecord,
  NewSuiteRun,
  RunFinal,
  RunJob,
  RunnableCase,
} from '../src/modules/evals/domain/types.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/platform/errors.js';

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

const CONFIG = {
  provider: 'openai',
  model: 'gpt-4o',
  system_prompt: 'SYSTEM-PROMPT-MARKER',
  strategy: 'auto',
  skills: [{ id: 's1', name: 'secrets', description: 'Flag secrets', body: 'SKILL-BODY-MARKER', version: 2 }],
};

function finding(line: number): Review['findings'][number] {
  return {
    id: `f${line}`,
    severity: 'CRITICAL',
    category: 'security',
    title: 'Hardcoded key',
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

const review = (findings: Review['findings']): Review => ({ verdict: 'request_changes', summary: 's', score: 50, findings });

interface Calls {
  messages: ChatMessage[][];
  temperatures: Array<number | null | undefined>;
  inFlight: number;
  maxInFlight: number;
}

/** Scripted LLM: `respond(user)` returns a review, throws, or never settles; reports `cost` per call. */
class FakeLLM implements LLMProvider {
  readonly id = 'openai' as const;
  readonly calls: Calls = { messages: [], temperatures: [], inFlight: 0, maxInFlight: 0 };
  constructor(
    private readonly respond: (user: string) => Review | Promise<Review> | 'hang',
    private readonly cost: number | null = 0.5,
    private readonly delayMs = 0,
  ) {}

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.messages.push(req.messages);
    this.calls.temperatures.push((req as { temperature?: number | null }).temperature);
    this.calls.inFlight++;
    this.calls.maxInFlight = Math.max(this.calls.maxInFlight, this.calls.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      const usage = { tokensIn: 10, tokensOut: 5, costUsd: this.cost };
      req.onUsage?.(usage);
      const out = this.respond(req.messages[1]!.content);
      if (out === 'hang') return await new Promise<never>(() => undefined);
      const data = await out;
      return { data: req.schema.parse(data), model: req.model, ...usage, raw: JSON.stringify(data), attempts: 1 };
    } finally {
      this.calls.inFlight--;
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

const summary = (id: string, over: Partial<EvalRunSummary> = {}): EvalRunSummary => ({
  id,
  agent_id: 'a1',
  agent_version: 3,
  model: 'gpt-4o',
  status: 'running',
  started_at: new Date(0).toISOString(),
  finished_at: null,
  cases_total: 0,
  cases_finished: 0,
  cases_passed: 0,
  cases_errored: 0,
  recall: null,
  precision: null,
  citation_accuracy: null,
  unlabeled_findings: 0,
  cost_usd: null,
  duration_ms: null,
  error: null,
  ...over,
});

/** In-memory EvalRunsStore. `gone` = case ids deleted before they load; `goneOnRecord` = deleted while running. */
class FakeStore implements EvalRunsStore {
  cases = new Map<string, RunnableCase>();
  records: CaseRecord[] = [];
  dropped = 0;
  final: RunFinal | undefined;
  inserted: NewSuiteRun[] = [];
  goneOnRecord = new Set<string>();
  active = false;
  reapedWith: string | undefined;

  addCase(id: string, kind: 'must_find' | 'must_not_flag' = 'must_find', line = 11): RunnableCase {
    const c: RunnableCase = {
      id,
      expectation: { kind, file: 'src/config.ts', start_line: line, end_line: line, severity: null, category: null, title: null },
      inputDiff: DIFF,
      inputMeta: { pr_title: `PR title ${id}`, pr_description: `PR body ${id}`, repo: 'acme/api', pr_number: 7, head_sha: 'abc' },
    };
    this.cases.set(id, c);
    return c;
  }

  async caseIds() {
    return [...this.cases.keys()];
  }
  async listRuns() {
    return [];
  }
  async getRun(): Promise<EvalRunDetail | undefined> {
    return undefined;
  }
  // Compare and the dashboards are covered by eval-dashboard.it.test.ts.
  async compareSide() {
    return undefined;
  }
  async finishedRuns() {
    return [];
  }
  async finishedRunsByAgent() {
    return new Map<string, EvalRunSummary[]>();
  }
  async agentsWithEvals() {
    return [];
  }
  async recentRuns() {
    return [];
  }
  async insertRun(values: NewSuiteRun): Promise<InsertRunResult> {
    this.inserted.push(values);
    return this.active ? { kind: 'active' } : { kind: 'created', run: summary('run-1', { cases_total: values.caseIds.length }) };
  }
  async reapRunning(error: string) {
    this.reapedWith = error;
    return 2;
  }
  async loadCase(_ws: string, id: string) {
    return this.cases.get(id);
  }
  async recordCase(_run: string, record: CaseRecord) {
    if (this.goneOnRecord.has(record.caseId)) return 'case_gone' as const;
    this.records.push(record);
    return 'recorded' as const;
  }
  async dropCase() {
    this.dropped++;
  }
  async finish(_run: string, final: RunFinal) {
    this.final = final;
  }
}

class RecordingLog implements EvalLogger {
  lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  info(obj: object, msg: string) {
    this.lines.push({ obj: obj as Record<string, unknown>, msg });
  }
  error(obj: object, msg: string) {
    this.lines.push({ obj: obj as Record<string, unknown>, msg });
  }
}

const job = (store: FakeStore, over: Partial<RunJob> = {}): RunJob => ({
  runId: 'run-1',
  workspaceId: 'w1',
  ownerKind: 'agent',
  skillId: null,
  skillVersion: null,
  agentId: 'a1',
  agentVersion: 3,
  agentName: 'Reviewer',
  config: CONFIG,
  caseIds: [...store.cases.keys()],
  ...over,
});

function setup(llm: LLMProvider, opts: { caseTimeoutMs?: number } = {}) {
  const store = new FakeStore();
  const executor = new EvalRunExecutor({
    runs: store,
    llm: async () => llm,
    parseDiff: parseUnifiedDiff,
    runBounded: (tasks) => new PQueue({ concurrency: 3 }).addAll(tasks),
    ...opts,
  });
  return { store, executor };
}

/** Launch a job and wait until it wrote its terminal state (the executor is fire-and-forget). */
async function runToEnd(executor: EvalRunExecutor, store: FakeStore, j: RunJob, log: EvalLogger = new RecordingLog()) {
  executor.launch(j, log);
  await waitFor(() => store.final !== undefined);
}

describe('eval run executor (fakes, no DB)', () => {
  it('AC11 + FR7: a case runs with the fixed inputs only, temperature 0', async () => {
    const llm = new FakeLLM(() => review([finding(11)]));
    const { store, executor } = setup(llm);
    store.addCase('c1');

    const log = new RecordingLog();
    executor.launch(job(store), log);
    await waitFor(() => store.final !== undefined);

    expect(llm.calls.messages).toHaveLength(1);
    const [system, user] = llm.calls.messages[0]!;
    expect(system!.content).toContain('SYSTEM-PROMPT-MARKER');
    expect(user!.content).toContain('SKILL-BODY-MARKER');
    expect(user!.content).toContain('PR title c1'); // the task line carries the stored title
    expect(user!.content).toContain('PR body c1');
    expect(user!.content).toContain('stripeKey');
    for (const absent of ['## Memory', '## Project context', '## PR intent', '## Callers', '## Repo map']) {
      expect(user!.content).not.toContain(absent);
    }
    expect(llm.calls.temperatures).toEqual([0]);
  });

  it('AC9-style happy path: 8 cases -> 8 results, completed, metrics, cost summed (AC38)', async () => {
    const llm = new FakeLLM(() => review([finding(11)]), 0.25);
    const { store, executor } = setup(llm);
    for (let i = 1; i <= 8; i++) store.addCase(`c${i}`);

    await runToEnd(executor, store, job(store));

    expect(store.records).toHaveLength(8);
    expect(store.records.every((r) => r.status === 'passed' && r.hitCount === 1 && r.costUsd === 0.25)).toBe(true);
    expect(store.final).toMatchObject({ status: 'completed', error: null });
    expect(store.final!.metrics).toMatchObject({ recall: 1, precision: 1, citation_accuracy: 1, cases_passed: 8, cost_usd: 2 });
  });

  it('AC38: an unpriced model gives null cost per case and for the run', async () => {
    const llm = new FakeLLM(() => review([]), null);
    const { store, executor } = setup(llm);
    store.addCase('c1', 'must_not_flag');
    await runToEnd(executor, store, job(store));
    expect(store.records[0]!.costUsd).toBeNull();
    expect(store.final!.metrics.cost_usd).toBeNull();
  });

  it('AC15 + EC10: one case throws -> error with a message, run completed, metrics from the rest', async () => {
    const llm = new FakeLLM((user) => {
      if (user.includes('PR body c3')) throw new Error('provider exploded');
      return review([finding(11)]);
    });
    const { store, executor } = setup(llm);
    for (let i = 1; i <= 8; i++) store.addCase(`c${i}`);

    await runToEnd(executor, store, job(store));

    const errored = store.records.filter((r) => r.status === 'error');
    expect(errored).toHaveLength(1);
    expect(errored[0]).toMatchObject({ caseId: 'c3', error: 'provider exploded', findings: [] });
    // The failed call still reported its spend.
    expect(errored[0]!.costUsd).toBe(0.5);
    expect(store.final).toMatchObject({ status: 'completed' });
    expect(store.final!.metrics).toMatchObject({ cases_errored: 1, cases_passed: 7, recall: 1 });
  });

  it('AC15: every case throws -> run failed with the first error', async () => {
    const llm = new FakeLLM(() => {
      throw new Error('no key');
    });
    const { store, executor } = setup(llm);
    for (let i = 1; i <= 3; i++) store.addCase(`c${i}`);
    await runToEnd(executor, store, job(store));
    expect(store.final).toMatchObject({ status: 'failed', error: 'no key' });
    expect(store.final!.metrics.cases_errored).toBe(3);
  });

  it('AC36: at most 3 cases of a run execute at once', async () => {
    const llm = new FakeLLM(() => review([]), 0.1, 20);
    const { store, executor } = setup(llm);
    for (let i = 1; i <= 8; i++) store.addCase(`c${i}`, 'must_not_flag');
    await runToEnd(executor, store, job(store));
    expect(store.records).toHaveLength(8);
    expect(llm.calls.maxInFlight).toBe(3);
  });

  it('AC36: a call that never answers marks its case error after the budget; the others finish', async () => {
    const llm = new FakeLLM((user) => (user.includes('PR body c2') ? 'hang' : review([])));
    const { store, executor } = setup(llm, { caseTimeoutMs: 40 });
    for (let i = 1; i <= 3; i++) store.addCase(`c${i}`, 'must_not_flag');
    await runToEnd(executor, store, job(store));
    const c2 = store.records.find((r) => r.caseId === 'c2')!;
    expect(c2.status).toBe('error');
    expect(c2.error).toMatch(/timed out/i);
    expect(store.records.filter((r) => r.status === 'passed')).toHaveLength(2);
    expect(store.final!.status).toBe('completed');
  });

  it('AC40 + EC9: a case deleted before it starts, or while running, is excluded from the results', async () => {
    const llm = new FakeLLM(() => review([]));
    const { store, executor } = setup(llm);
    for (let i = 1; i <= 8; i++) store.addCase(`c${i}`, 'must_not_flag');
    const j = job(store);
    store.cases.delete('c4'); // gone before its execution starts
    store.goneOnRecord.add('c6'); // deleted while its result is being stored

    await runToEnd(executor, store, j);

    expect(store.records.map((r) => r.caseId).sort()).toEqual(['c1', 'c2', 'c3', 'c5', 'c7', 'c8']);
    expect(store.dropped).toBe(2);
    expect(store.final!.metrics.cases_passed).toBe(6);
  });

  it('NFR6 + AC35: one start and one end line; no prompt, diff or finding text in them', async () => {
    const llm = new FakeLLM(() => review([finding(11)]));
    const { store, executor } = setup(llm);
    store.addCase('c1');
    const log = new RecordingLog();
    await runToEnd(executor, store, job(store), log);

    expect(log.lines.map((l) => l.msg)).toEqual(['eval run started', 'eval run finished']);
    expect(log.lines[0]!.obj).toEqual({
      runId: 'run-1',
      ownerKind: 'agent',
      skillId: null,
      skillVersion: null,
      agentId: 'a1',
      agentVersion: 3,
      cases: 1,
    });
    expect(log.lines[1]!.obj).toMatchObject({ runId: 'run-1', status: 'completed', casesPassed: 1, costUsd: 0.5 });
    const text = JSON.stringify(log.lines);
    for (const secret of ['SYSTEM-PROMPT-MARKER', 'SKILL-BODY-MARKER', 'stripeKey', 'Hardcoded key', 'PR body']) {
      expect(text).not.toContain(secret);
    }
  });

  it('shutdown aborts in-flight cases: the run ends failed "interrupted" and the aborted case is not a result', async () => {
    const llm = new FakeLLM(() => 'hang');
    const { store, executor } = setup(llm);
    store.addCase('c1');
    store.addCase('c2');
    executor.launch(job(store), new RecordingLog());
    await waitFor(() => llm.calls.inFlight === 2);

    expect(await executor.shutdown(2_000)).toBe(true);
    expect(store.records).toEqual([]);
    expect(store.final).toMatchObject({ status: 'failed', error: 'interrupted' });
  });

  it('a run launched after shutdown starts no case and ends failed "interrupted"', async () => {
    const llm = new FakeLLM(() => review([]));
    const { store, executor } = setup(llm);
    store.addCase('c1', 'must_not_flag');
    await executor.shutdown(1_000);
    await runToEnd(executor, store, job(store));
    expect(llm.calls.messages).toHaveLength(0);
    expect(store.final).toMatchObject({ status: 'failed', error: 'interrupted' });
  });

  it('a failing store (DB down) fails the run instead of crashing the process', async () => {
    const llm = new FakeLLM(() => review([]));
    const { store, executor } = setup(llm);
    store.addCase('c1', 'must_not_flag');
    store.recordCase = async () => {
      throw new Error('db down');
    };
    await runToEnd(executor, store, job(store));
    expect(store.final).toMatchObject({ status: 'failed', error: 'db down' });
  });
});

describe('scoring makes no LLM call (AC13, NFR1)', () => {
  it('scoreCase + aggregateRun over completed results never touch the LLM double', () => {
    const llm = new FakeLLM(() => {
      throw new Error('LLM must not be called while scoring');
    });
    const expectation = { kind: 'must_find' as const, file: 'src/config.ts', start_line: 11, end_line: 11, severity: null, category: null, title: null };
    const score = scoreCase(expectation, [{ file: 'src/config.ts', start_line: 11, end_line: 11, severity: null, category: null, title: null }]);
    const metrics = aggregateRun([
      { kind: 'must_find', status: score.status, hit_count: score.hit_count, violation_count: 0, unlabeled_count: 0, dropped_count: 0, cost_usd: null, error: null },
    ]);
    expect(metrics.recall).toBe(1);
    expect(llm.calls.messages).toHaveLength(0);
  });
});

const SKILL = { id: 's1', name: 'sql-injection', description: 'Flag raw SQL.', body: 'Skill body.', version: 4 };

describe('EvalRunsService', () => {
  function service(store = new FakeStore(), snapshot: 'agent' | 'none' = 'agent') {
    const launched: Array<{ job: RunJob }> = [];
    const svc = new EvalRunsService({
      runs: store,
      agents: {
        exists: async () => snapshot === 'agent',
        listIds: async () => (snapshot === 'agent' ? ['a1', 'a2'] : []),
        snapshot: async () => (snapshot === 'agent' ? { version: 3, name: 'Reviewer', config: CONFIG } : undefined),
      },
      skills: { get: async (_ws, id) => (id === 's1' ? SKILL : undefined) },
      executor: { launch: (j) => void launched.push({ job: j }), shutdown: async () => true },
    });
    return { svc, store, launched };
  }

  it('start: persists the snapshot, returns the running run and launches the background job (FR6)', async () => {
    const { svc, store, launched } = service();
    store.addCase('c1');
    store.addCase('c2');
    const run = await svc.start('w1', 'a1');
    expect(run).toMatchObject({ id: 'run-1', status: 'running', cases_total: 2 });
    expect(store.inserted[0]).toEqual({
      workspaceId: 'w1',
      ownerKind: 'agent',
      skillId: null,
      skillVersion: null,
      agentId: 'a1',
      agentVersion: 3,
      agentName: 'Reviewer',
      config: CONFIG,
      caseIds: ['c1', 'c2'],
    });
    expect(launched).toHaveLength(1);
    expect(launched[0]!.job).toMatchObject({ runId: 'run-1', agentVersion: 3, caseIds: ['c1', 'c2'] });
  });

  it('AC14: a running run -> 409 eval_run_active (nothing launched); no cases -> 422 no_eval_cases', async () => {
    const { svc, store, launched } = service();
    store.addCase('c1');
    store.active = true;
    await expect(svc.start('w1', 'a1')).rejects.toMatchObject({ code: 'eval_run_active' });
    await expect(svc.start('w1', 'a1')).rejects.toBeInstanceOf(ConflictError);
    expect(launched).toHaveLength(0);

    const empty = service();
    await expect(empty.svc.start('w1', 'a1')).rejects.toMatchObject({ code: 'no_eval_cases' });
    await expect(empty.svc.start('w1', 'a1')).rejects.toBeInstanceOf(ValidationError);
  });

  it('FR16: run-all reports an agent without cases or with a running run as skipped, never as an error', async () => {
    const { svc, store, launched } = service();
    // a1 and a2 share the fake store: the first start takes the case set, the second is blocked.
    store.addCase('c1');
    let first = true;
    const insert = store.insertRun.bind(store);
    store.insertRun = async (values) => {
      if (first) {
        first = false;
        return insert(values);
      }
      return { kind: 'active' };
    };
    const res = await svc.runAll('w1');
    expect(res.started.map((r) => r.id)).toEqual(['run-1']);
    expect(res.skipped).toEqual([{ agent_id: 'a2', reason: 'run_active' }]);
    expect(launched).toHaveLength(1);

    const empty = service();
    expect(await empty.svc.runAll('w1')).toEqual({
      started: [],
      skipped: [
        { agent_id: 'a1', reason: 'no_cases' },
        { agent_id: 'a2', reason: 'no_cases' },
      ],
    });
  });

  it('startSkill: freezes the host config with ONLY the skill, records the skill version and host name (FR18)', async () => {
    const { svc, store, launched } = service();
    store.addCase('c1');
    const run = await svc.startSkill('w1', 's1', 'a1');
    expect(run.id).toBe('run-1');
    expect(store.inserted[0]).toMatchObject({
      ownerKind: 'skill',
      skillId: 's1',
      skillVersion: 4,
      agentId: 'a1',
      agentVersion: 3,
      agentName: 'Reviewer',
      caseIds: ['c1'],
      config: { ...CONFIG, skills: [SKILL] },
    });
    expect(launched[0]!.job).toMatchObject({ runId: 'run-1', ownerKind: 'skill', skillId: 's1' });
  });

  it('startSkill: unknown skill -> 404; unknown host -> host_agent_not_found; no cases -> no_eval_cases; active -> 409', async () => {
    const { svc, store } = service();
    store.addCase('c1');
    await expect(svc.startSkill('w1', 'nope', 'a1')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service(new FakeStore(), 'none').svc.startSkill('w1', 's1', 'a1')).rejects.toMatchObject({
      code: 'host_agent_not_found',
    });
    await expect(service().svc.startSkill('w1', 's1', 'a1')).rejects.toMatchObject({ code: 'no_eval_cases' });
    store.active = true;
    await expect(svc.startSkill('w1', 's1', 'a1')).rejects.toMatchObject({ code: 'eval_run_active' });
    await expect(svc.listSkillRuns('w1', 'nope', 20)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('an unknown / foreign agent or run is a 404', async () => {
    const { svc } = service(new FakeStore(), 'none');
    await expect(svc.start('w1', 'nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.list('w1', 'nope', 20)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.get('w1', 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('FR18: reapInterrupted fails the leftover runs with "interrupted"', async () => {
    const { svc, store } = service();
    expect(await svc.reapInterrupted()).toBe(2);
    expect(store.reapedWith).toBe('interrupted');
  });
});

/** Poll until `cond` holds (real timers; the executor is fire-and-forget). */
async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
