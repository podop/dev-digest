import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AgentEvalCase, AuthProvider } from '@devdigest/shared';
import { EVAL_CASES_PER_AGENT_MAX, EVAL_INPUT_DIFF_MAX_CHARS } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const PATCH = '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';

/** Eval case routes end to end on a real Postgres (specs/eval-pipeline.md AC1–AC8, EC4, EC5, limits). */
d('eval cases API (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let otherApp: Awaited<ReturnType<typeof buildApp>>;
  let seq = 0;

  const make = (auth?: AuthProvider) =>
    buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient({ pulls: [] }), ...(auth ? { auth } : {}) },
    });

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    const [other] = await pg.handle.db.insert(t.workspaces).values({ name: 'other-tenant' }).returning();
    otherWorkspaceId = other!.id;
    app = await make();
    otherApp = await make({
      currentUser: async () => ({ id: '00000000-0000-4000-8000-000000000001', email: 'o@x', name: 'Other' }),
      currentWorkspace: async () => ({ id: otherWorkspaceId, name: 'other-tenant' }),
    });
  });
  afterAll(async () => {
    await app?.close();
    await otherApp?.close();
    await pg?.stop();
  });

  /** An agent, a PR with one stored patch, a review of that agent and one finding on line 11. */
  async function scenario(opts: { decision?: 'accepted' | 'dismissed' | null; patch?: string | null; withAgent?: boolean } = {}) {
    const db = pg.handle.db;
    const n = ++seq;
    const [agent] = await db
      .insert(t.agents)
      .values({ workspaceId, name: `eval-agent-${n}`, provider: 'openai', model: 'gpt-4o', systemPrompt: 'review' })
      .returning();
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: `api-${n}`, fullName: `acme/api-${n}` })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 100 + n,
        title: 'Add rate limiting',
        author: 'dev',
        branch: 'feat',
        base: 'main',
        headSha: 'abc123',
        body: 'PR body',
      })
      .returning();
    await db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      patch: opts.patch === undefined ? PATCH : opts.patch,
    });
    const [review] = await db
      .insert(t.reviews)
      .values({ workspaceId, prId: pr!.id, agentId: opts.withAgent === false ? null : agent!.id, kind: 'review' })
      .returning();
    const decision = opts.decision === undefined ? 'accepted' : opts.decision;
    const [finding] = await db
      .insert(t.findings)
      .values({
        reviewId: review!.id,
        file: 'src/config.ts',
        startLine: 11,
        endLine: 11,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe key',
        rationale: 'r',
        confidence: 0.9,
        acceptedAt: decision === 'accepted' ? new Date() : null,
        dismissedAt: decision === 'dismissed' ? new Date() : null,
      })
      .returning();
    return { agent: agent!, repo: repo!, pr: pr!, review: review!, finding: finding! };
  }

  const create = (findingId: string, on = app) =>
    on.inject({ method: 'POST', url: `/findings/${findingId}/eval-case` });
  const list = (agentId: string, on = app) => on.inject({ method: 'GET', url: `/agents/${agentId}/eval-cases` });
  const caseOf = async (agentId: string) => ((await list(agentId)).json() as { cases: AgentEvalCase[] }).cases;

  it('AC1: accepted finding -> 201 must_find with a one-file diff containing the lines and the meta snapshot', async () => {
    const s = await scenario();
    const res = await create(s.finding.id);
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({
      agent_id: s.agent.id,
      name: 'Hardcoded Stripe key',
      notes: null,
      source_finding_id: s.finding.id,
      source_pr_id: s.pr.id,
      last_result: null,
      expectation: { kind: 'must_find', file: 'src/config.ts', start_line: 11, end_line: 11, severity: 'CRITICAL', category: 'security', title: 'Hardcoded Stripe key' },
      input_meta: { pr_title: 'Add rate limiting', pr_description: 'PR body', repo: s.repo.fullName, pr_number: s.pr.number, head_sha: 'abc123' },
    });
    const diff = parseUnifiedDiff(c.input_diff);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.path).toBe('src/config.ts');
    expect(diff.files[0]?.hunks[0]?.newLineNumbers).toContain(11);
  });

  it('AC2: dismissed finding -> must_not_flag', async () => {
    const s = await scenario({ decision: 'dismissed' });
    const res = await create(s.finding.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().expectation.kind).toBe('must_not_flag');
  });

  it('AC3 + EC4: POST again and two concurrent POSTs -> 409 eval_case_exists with the case id, one case', async () => {
    const s = await scenario();
    const first = await create(s.finding.id);
    expect(first.statusCode).toBe(201);
    const again = await create(s.finding.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'eval_case_exists', details: { case_id: first.json().id } });
    expect(await caseOf(s.agent.id)).toHaveLength(1);

    const racer = await scenario();
    await pg.handle.db.select().from(t.evalCases).limit(1); // warm the pool so both requests really overlap
    const [r1, r2] = await Promise.all([create(racer.finding.id), create(racer.finding.id)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    const winner = r1.statusCode === 201 ? r1 : r2;
    expect(loser.json().error.details.case_id).toBe(winner.json().id);
    expect(await caseOf(racer.agent.id)).toHaveLength(1);
  });

  it('AC4: undecided / no agent / empty patch / too large -> 422 with the spec code; unknown finding -> 404', async () => {
    const undecided = await scenario({ decision: null });
    expect((await create(undecided.finding.id)).json().error.code).toBe('finding_undecided');
    expect((await create(undecided.finding.id)).statusCode).toBe(422);

    const noAgent = await scenario({ withAgent: false });
    expect((await create(noAgent.finding.id)).json().error.code).toBe('finding_no_agent');

    const empty = await scenario({ patch: '' });
    expect((await create(empty.finding.id)).json().error.code).toBe('patch_unavailable');
    const nullPatch = await scenario({ patch: null });
    expect((await create(nullPatch.finding.id)).json().error.code).toBe('patch_unavailable');

    const tooBig = `@@ -1 +1 @@\n+${'x'.repeat(EVAL_INPUT_DIFF_MAX_CHARS)}`.slice(0, EVAL_INPUT_DIFF_MAX_CHARS + 1);
    expect(tooBig).toHaveLength(EVAL_INPUT_DIFF_MAX_CHARS + 1);
    const big = await scenario({ patch: tooBig });
    expect((await create(big.finding.id)).json().error.code).toBe('patch_too_large');

    const missing = await create('00000000-0000-4000-8000-0000000000ff');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    expect((await create('not-a-uuid')).statusCode).toBe(422);
  });

  it('AC5: a decision flipped after creation keeps the case kind', async () => {
    const s = await scenario();
    expect((await create(s.finding.id)).statusCode).toBe(201);
    await pg.handle.db
      .update(t.findings)
      .set({ acceptedAt: null, dismissedAt: new Date() })
      .where(eq(t.findings.id, s.finding.id));
    const cases = await caseOf(s.agent.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.expectation.kind).toBe('must_find');
  });

  it('AC6 (listing part): the case stays listed after its review is deleted', async () => {
    const s = await scenario();
    expect((await create(s.finding.id)).statusCode).toBe(201);
    await pg.handle.db.delete(t.reviews).where(eq(t.reviews.id, s.review.id));
    const cases = await caseOf(s.agent.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.source_finding_id).toBe(s.finding.id);
  });

  it('lists newest first and last_result is the latest FINISHED run containing the case (AC7)', async () => {
    const s = await scenario();
    const s2 = await scenario();
    // second finding of the same agent: another review on the second PR, attributed to agent 1
    const [review2] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: s2.pr.id, agentId: s.agent.id, kind: 'review' })
      .returning();
    const [finding2] = await pg.handle.db
      .insert(t.findings)
      .values({ reviewId: review2!.id, file: 'src/config.ts', startLine: 11, endLine: 11, severity: 'WARNING', category: 'bug', title: 'Second', rationale: 'r', confidence: 0.5, acceptedAt: new Date() })
      .returning();
    const c1 = (await create(s.finding.id)).json();
    const c2 = (await create(finding2!.id)).json();
    expect((await caseOf(s.agent.id)).map((c) => c.id)).toEqual([c2.id, c1.id]);

    const run = (status: 'running' | 'completed' | 'failed', startedAt: string, finishedAt: string | null) =>
      pg.handle.db
        .insert(t.evalSuiteRuns)
        .values({
          workspaceId,
          agentId: s.agent.id,
          agentVersion: 1,
          config: { provider: 'openai', model: 'gpt-4o', system_prompt: 'p', strategy: 'single-pass', skills: [] },
          caseIds: [c1.id],
          status,
          startedAt: new Date(startedAt),
          finishedAt: finishedAt ? new Date(finishedAt) : null,
        })
        .returning();
    const [older] = await run('completed', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z');
    const [newer] = await run('failed', '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z');
    const [active] = await run('running', '2026-01-03T00:00:00Z', null);
    const result = (runId: string, status: 'passed' | 'failed' | 'error') =>
      pg.handle.db.insert(t.evalRuns).values({ caseId: c1.id, runId, status, pass: status === 'passed' });
    await result(older!.id, 'passed');
    await result(newer!.id, 'error');
    await result(active!.id, 'failed');

    const cases = await caseOf(s.agent.id);
    const withResult = cases.find((c) => c.id === c1.id)!;
    expect(withResult.last_result).toMatchObject({ run_id: newer!.id, status: 'error' });
    expect(cases.find((c) => c.id === c2.id)!.last_result).toBeNull();
  });

  it('GET cases of an unknown agent or another workspace -> 404', async () => {
    const s = await scenario();
    expect((await list('00000000-0000-4000-8000-0000000000ff')).statusCode).toBe(404);
    expect((await list(s.agent.id, otherApp)).statusCode).toBe(404);
  });

  it('a finding of another workspace -> 404 and no case', async () => {
    const s = await scenario();
    expect((await create(s.finding.id, otherApp)).statusCode).toBe(404);
    expect(await caseOf(s.agent.id)).toHaveLength(0);
  });

  it('AC8 + EC16: PATCH name / notes / lines; end < start -> 400; bad shape -> 422; DELETE -> 204 then 404', async () => {
    const s = await scenario();
    const c = (await create(s.finding.id)).json();
    const patch = (payload: unknown, on = app) => on.inject({ method: 'PATCH', url: `/eval-cases/${c.id}`, payload: payload as object });

    const ok = await patch({ name: 'Renamed', notes: 'why', start_line: 9, end_line: 14 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'Renamed', notes: 'why', expectation: { start_line: 9, end_line: 14, kind: 'must_find', file: 'src/config.ts' } });

    // end_line below the STORED start (9), only one bound sent
    const low = await patch({ end_line: 8 });
    expect(low.statusCode).toBe(400);
    expect(low.json().error.code).toBe('validation_error');
    const high = await patch({ start_line: 20 });
    expect(high.statusCode).toBe(400);

    expect((await patch({ name: '' })).statusCode).toBe(422);
    expect((await patch({ start_line: 0 })).statusCode).toBe(422);
    expect((await patch({ name: 'x'.repeat(121) })).statusCode).toBe(422);

    const empty = await patch({});
    expect(empty.statusCode).toBe(200);
    expect(empty.json().name).toBe('Renamed');
    const cleared = await patch({ notes: null });
    expect(cleared.json().notes).toBeNull();

    expect((await patch({ name: 'hijack' }, otherApp)).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/eval-cases/${c.id}` })).statusCode).toBe(204);
    expect(await caseOf(s.agent.id)).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: `/eval-cases/${c.id}` })).statusCode).toBe(404);
    expect((await patch({ name: 'gone' })).statusCode).toBe(404);
  });

  it('another workspace cannot delete a case', async () => {
    const s = await scenario();
    const c = (await create(s.finding.id)).json();
    expect((await otherApp.inject({ method: 'DELETE', url: `/eval-cases/${c.id}` })).statusCode).toBe(404);
    expect(await caseOf(s.agent.id)).toHaveLength(1);
  });

  it('422 eval_case_limit at 200 cases per agent', async () => {
    const s = await scenario();
    await pg.handle.db.insert(t.evalCases).values(
      Array.from({ length: EVAL_CASES_PER_AGENT_MAX }, (_, i) => ({
        workspaceId,
        ownerKind: 'agent' as const,
        ownerId: s.agent.id,
        name: `bulk-${i}`,
        inputDiff: 'd',
        inputMeta: { pr_title: 't', pr_description: null, repo: 'a/b', pr_number: 1, head_sha: null },
        expectedOutput: { kind: 'must_find', file: 'f.ts', start_line: 1, end_line: 1, severity: null, category: null, title: null },
      })),
    );
    const res = await create(s.finding.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('eval_case_limit');
  });
});
