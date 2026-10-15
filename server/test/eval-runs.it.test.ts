import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AgentEvalCase, EvalRunSummary } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import {
  ScriptedLLM,
  buildEvalApp,
  finding,
  gate,
  insertAgent,
  insertCases,
  waitForRun,
} from './helpers/eval-fixtures.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const hit = () => [finding('Hardcoded key')];

/** Eval run routes end to end on a real Postgres (specs/eval-pipeline.md AC6, 7, 9-11, 14, 15, 21, 23, 35-38, 40). */
d('eval runs API (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
    await pg?.stop();
  });

  async function appWith(llm: ScriptedLLM, env: Record<string, string> = {}) {
    const app = await buildEvalApp(pg.handle.db, llm, env);
    apps.push(app);
    return app;
  }
  const start = (app: FastifyInstance, agentId: string) =>
    app.inject({ method: 'POST', url: `/agents/${agentId}/eval-runs` });

  it('AC9 + AC11 + AC35 + AC38: 8 cases -> 202 running at once, completes with 8 results; fixed inputs; one start/end log; summed cost', async () => {
    const llm = new ScriptedLLM(hit, 0.01);
    const app = await appWith(llm);
    const logged: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    app.addHook('onRequest', async (req) => {
      (req as { log: unknown }).log = {
        info: (obj: Record<string, unknown>, msg: string) => logged.push({ obj, msg }),
        error: (obj: Record<string, unknown>, msg: string) => logged.push({ obj, msg }),
        warn: () => undefined,
        debug: () => undefined,
      };
    });
    const agent = await insertAgent(pg.handle.db, workspaceId, { strategy: 'single-pass' });
    const [skill] = await pg.handle.db
      .insert(t.skills)
      .values({ workspaceId, name: `eval-skill-${agent.id.slice(0, 8)}`, description: 'Flag keys.', type: 'custom', source: 'manual', body: 'Skill body marker.' })
      .returning();
    await pg.handle.db.insert(t.agentSkills).values({ agentId: agent.id, skillId: skill!.id, order: 0 });
    await insertCases(pg.handle.db, workspaceId, agent.id, 8);

    const began = Date.now();
    const res = await start(app, agent.id);
    expect(Date.now() - began).toBeLessThan(500);
    expect(res.statusCode, res.body).toBe(202);
    const started = res.json() as EvalRunSummary;
    expect(started).toMatchObject({ status: 'running', cases_total: 8, agent_id: agent.id, model: 'gpt-4o' });

    const done = await waitForRun(app, started.id);
    expect(done.run).toMatchObject({
      status: 'completed',
      cases_total: 8,
      cases_finished: 8,
      cases_passed: 8,
      cases_errored: 0,
      recall: 1,
      precision: 1,
      citation_accuracy: 1,
      cost_usd: 0.08,
    });
    expect(done.results).toHaveLength(8);
    expect(done.results[0]).toMatchObject({ status: 'passed', cost_usd: 0.01, dropped_count: 0 });
    expect(done.results[0]!.findings[0]).toMatchObject({ file: 'src/config.ts', start_line: 11, match: 'hit' });

    // AC11: only the case diff, PR title/description, the snapshot prompt/model/skills, temperature 0.
    expect(llm.calls).toHaveLength(8);
    for (const call of llm.calls) {
      const user = call.messages[1]!.content;
      expect(call.temperature).toBe(0);
      expect(call.model).toBe('gpt-4o');
      expect(call.messages[0]!.content).toContain('You are the eval reviewer.');
      expect(user).toContain('Skill body marker.');
      expect(user).toContain('PR body');
      expect(user).toContain('Add rate limiting');
      expect(user).toContain('stripeKey');
      for (const live of ['Repository map', 'Project context', 'Callers of changed symbols', 'Author intent']) {
        expect(user).not.toContain(live);
      }
    }

    // AC35: one start and one end line, no prompt or diff text.
    const lines = logged.filter((l) => l.msg.startsWith('eval run'));
    expect(lines.map((l) => l.msg)).toEqual(['eval run started', 'eval run finished']);
    expect(lines[0]!.obj).toMatchObject({ runId: started.id, agentId: agent.id, cases: 8 });
    expect(lines[1]!.obj).toMatchObject({ runId: started.id, status: 'completed', costUsd: 0.08 });
    const logText = JSON.stringify(lines);
    expect(logText).not.toContain('You are the eval reviewer.');
    expect(logText).not.toContain('stripeKey');
  });

  it('AC7: each case carries its last_result from the finished run; a case added later has none', async () => {
    const app = await appWith(new ScriptedLLM(hit));
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 2);
    const run = (await start(app, agent.id)).json() as EvalRunSummary;
    await waitForRun(app, run.id);
    await insertCases(pg.handle.db, workspaceId, agent.id, 1, 2);

    const cases = ((await app.inject({ method: 'GET', url: `/agents/${agent.id}/eval-cases` })).json() as { cases: AgentEvalCase[] }).cases;
    expect(cases).toHaveLength(3);
    const byName = Object.fromEntries(cases.map((c) => [c.name, c.last_result]));
    expect(byName['case-0']).toMatchObject({ run_id: run.id, status: 'passed' });
    expect(byName['case-1']).toMatchObject({ run_id: run.id, status: 'passed' });
    expect(byName['case-2']).toBeNull();
  });

  it('AC10: a prompt edit during a run does not change it; the next run snapshots the new prompt and version', async () => {
    const hold = gate();
    const llm = new ScriptedLLM(async () => {
      await hold.opened;
      return hit();
    });
    const app = await appWith(llm);
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 2);
    const first = (await start(app, agent.id)).json() as EvalRunSummary;

    const edit = await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}`,
      payload: { system_prompt: 'A brand new prompt.' },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    hold.open();
    await waitForRun(app, first.id);

    const second = (await start(app, agent.id)).json() as EvalRunSummary;
    await waitForRun(app, second.id);
    const [r1] = await pg.handle.db.select().from(t.evalSuiteRuns).where(eq(t.evalSuiteRuns.id, first.id));
    const [r2] = await pg.handle.db.select().from(t.evalSuiteRuns).where(eq(t.evalSuiteRuns.id, second.id));
    expect(r1!.config.system_prompt).toBe('You are the eval reviewer.');
    expect(r2!.config.system_prompt).toBe('A brand new prompt.');
    expect(r2!.agentVersion).toBeGreaterThan(r1!.agentVersion);
  });

  it('AC14 + AC23: a second start while running -> 409 eval_run_active; no cases -> 422 no_eval_cases; a disabled agent may run', async () => {
    const hold = gate();
    const app = await appWith(
      new ScriptedLLM(async () => {
        await hold.opened;
        return hit();
      }),
    );
    const agent = await insertAgent(pg.handle.db, workspaceId, { enabled: false });
    await insertCases(pg.handle.db, workspaceId, agent.id, 1);
    const first = await start(app, agent.id);
    expect(first.statusCode).toBe(202);

    const again = await start(app, agent.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('eval_run_active');

    const empty = await insertAgent(pg.handle.db, workspaceId);
    const none = await start(app, empty.id);
    expect(none.statusCode).toBe(422);
    expect(none.json().error.code).toBe('no_eval_cases');

    expect((await start(app, '00000000-0000-4000-8000-0000000000aa')).statusCode).toBe(404);
    hold.open();
    await waitForRun(app, (first.json() as EvalRunSummary).id);
  });

  it('AC15: one failing case is an error, the run completes on the rest; all failing -> run failed', async () => {
    const app = await appWith(
      new ScriptedLLM(({ index }) => {
        if (index === 3) throw new Error('model exploded');
        return hit();
      }),
    );
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 8);
    const run = await waitForRun(app, ((await start(app, agent.id)).json() as EvalRunSummary).id);
    expect(run.run).toMatchObject({ status: 'completed', cases_errored: 1, cases_passed: 7, cases_finished: 8, recall: 1 });
    const errored = run.results.filter((r) => r.status === 'error');
    expect(errored).toHaveLength(1);
    expect(errored[0]!.error).toContain('model exploded');

    const failing = await appWith(
      new ScriptedLLM(() => {
        throw new Error('provider down');
      }),
    );
    const agent2 = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent2.id, 3);
    const failed = await waitForRun(failing, ((await start(failing, agent2.id)).json() as EvalRunSummary).id);
    expect(failed.run).toMatchObject({ status: 'failed', cases_errored: 3, recall: null });
    expect(failed.run.error).toContain('provider down');
  });

  it('AC36: at most 3 cases run at once', async () => {
    const llm = new ScriptedLLM(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return hit();
    });
    const app = await appWith(llm);
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 8);
    const run = await waitForRun(app, ((await start(app, agent.id)).json() as EvalRunSummary).id);
    expect(run.run.cases_finished).toBe(8);
    expect(llm.maxActive).toBe(3);
  });

  it('AC38: an unpriced model gives null cost on every case and the run', async () => {
    const app = await appWith(new ScriptedLLM(hit, null));
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 2);
    const run = await waitForRun(app, ((await start(app, agent.id)).json() as EvalRunSummary).id);
    expect(run.run.cost_usd).toBeNull();
    expect(run.results.every((r) => r.cost_usd === null)).toBe(true);
  });

  it('AC40: a case deleted before it starts -> 7 results and cases_total 7', async () => {
    const hold = gate();
    const app = await appWith(
      new ScriptedLLM(async () => {
        await hold.opened;
        return hit();
      }),
    );
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const cases = await insertCases(pg.handle.db, workspaceId, agent.id, 8);
    const run = (await start(app, agent.id)).json() as EvalRunSummary;
    // Cases 0-2 are held in the LLM; the last one has not been picked up yet.
    const del = await app.inject({ method: 'DELETE', url: `/eval-cases/${cases[7]!.id}` });
    expect(del.statusCode).toBe(204);
    hold.open();

    const done = await waitForRun(app, run.id);
    expect(done.results).toHaveLength(7);
    expect(done.run).toMatchObject({ status: 'completed', cases_total: 7, cases_finished: 7 });
  });

  it('AC21: a run left running at boot is failed as interrupted', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const [orphan] = await pg.handle.db
      .insert(t.evalSuiteRuns)
      .values({
        workspaceId,
        agentId: agent.id,
        agentVersion: 1,
        config: { provider: 'openai', model: 'gpt-4o', system_prompt: 'p', strategy: 'single-pass', skills: [] },
        caseIds: [],
      })
      .returning();
    expect(orphan!.status).toBe('running');

    const app = await appWith(new ScriptedLLM(hit));
    const res = await app.inject({ method: 'GET', url: `/eval-runs/${orphan!.id}` });
    expect(res.json().run).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(res.json().run.finished_at).not.toBeNull();
  });

  it('AC6: a case whose source review is deleted is still listed and scored', async () => {
    const db = pg.handle.db;
    const app = await appWith(new ScriptedLLM(hit));
    const agent = await insertAgent(db, workspaceId);
    const [repo] = await db.insert(t.repos).values({ workspaceId, owner: 'acme', name: 'del-src', fullName: 'acme/del-src' }).returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({ workspaceId, repoId: repo!.id, number: 901, title: 'T', author: 'dev', branch: 'f', base: 'main', headSha: 'abc' })
      .returning();
    await db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
    });
    const [review] = await db.insert(t.reviews).values({ workspaceId, prId: pr!.id, agentId: agent.id, kind: 'review' }).returning();
    const [f] = await db
      .insert(t.findings)
      .values({ reviewId: review!.id, file: 'src/config.ts', startLine: 11, endLine: 11, severity: 'CRITICAL', category: 'security', title: 'Hardcoded key', rationale: 'r', confidence: 0.9, acceptedAt: new Date() })
      .returning();
    const created = await app.inject({ method: 'POST', url: `/findings/${f!.id}/eval-case` });
    expect(created.statusCode, created.body).toBe(201);
    await db.delete(t.reviews).where(eq(t.reviews.id, review!.id));

    const cases = ((await app.inject({ method: 'GET', url: `/agents/${agent.id}/eval-cases` })).json() as { cases: AgentEvalCase[] }).cases;
    expect(cases).toHaveLength(1);
    const run = await waitForRun(app, ((await start(app, agent.id)).json() as EvalRunSummary).id);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.status).toBe('passed');
  });

  it('AC37: the 11th run start within a minute is rate limited (429)', async () => {
    const hold = gate();
    const app = await appWith(
      new ScriptedLLM(async () => {
        await hold.opened;
        return hit();
      }),
      { NODE_ENV: 'development' },
    );
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 1);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await start(app, agent.id)).statusCode);
    expect(codes[0]).toBe(202);
    expect(codes.slice(1, 10).every((c) => c === 409)).toBe(true);
    expect(codes[10]).toBe(429);
    hold.open();
    const [running] = await pg.handle.db.select().from(t.evalSuiteRuns).where(eq(t.evalSuiteRuns.agentId, agent.id));
    await waitForRun(app, running!.id);
  });
});
