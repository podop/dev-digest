import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  AgentEvalCase,
  EvalAgentDashboard,
  EvalOverview,
  EvalRunAllResponse,
  EvalRunSummary,
} from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import {
  ScriptedLLM,
  buildEvalApp,
  finding,
  gate,
  insertAgent,
  insertCases,
  insertSkill,
  recordLogs,
  waitForRun,
} from './helpers/eval-fixtures.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const hit = () => [finding('Hardcoded key')];

/** Skill-owned runs end to end on a real Postgres (specs/2026-10-15-eval-case-editor.md AC25-AC31). */
d('eval skill runs API (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let otherWorkspaceId: string;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    const [other] = await pg.handle.db.insert(t.workspaces).values({ name: 'other-tenant' }).returning();
    otherWorkspaceId = other!.id;
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
  const startSkill = (app: FastifyInstance, skillId: string, agentId: string) =>
    app.inject({ method: 'POST', url: `/skills/${skillId}/eval-runs`, payload: { agent_id: agentId } });
  const startAgent = (app: FastifyInstance, agentId: string) =>
    app.inject({ method: 'POST', url: `/agents/${agentId}/eval-runs` });
  const getJson = async <T>(app: FastifyInstance, url: string) => (await app.inject({ method: 'GET', url })).json() as T;

  /** A skill with `n` cases and a host agent that links two other skills. */
  async function fixture(n = 3) {
    const db = pg.handle.db;
    const skill = await insertSkill(db, workspaceId, { body: 'EVALUATED-SKILL-BODY' });
    const host = await insertAgent(db, workspaceId, { systemPrompt: 'You are the HOST reviewer.', model: 'gpt-4o-mini' });
    const linked = [await insertSkill(db, workspaceId), await insertSkill(db, workspaceId)];
    await db.insert(t.agentSkills).values(linked.map((s, order) => ({ agentId: host.id, skillId: s.id, order })));
    await insertCases(db, workspaceId, skill.id, n, 0, 'skill');
    return { skill, host, linked };
  }

  it('AC25: 202 within 500 ms, completes with every case; each call carries the host prompt/model and exactly the evaluated skill', async () => {
    const llm = new ScriptedLLM(hit);
    const app = await appWith(llm);
    const { skill, host, linked } = await fixture(3);

    await getJson(app, `/skills/${skill.id}/eval-runs`); // warm the pool and routes: the budget is for the start itself
    const began = Date.now();
    const res = await startSkill(app, skill.id, host.id);
    expect(Date.now() - began).toBeLessThan(500);
    expect(res.statusCode, res.body).toBe(202);
    const started = res.json() as EvalRunSummary;
    expect(started).toMatchObject({
      status: 'running',
      owner_kind: 'skill',
      skill_id: skill.id,
      skill_version: skill.version,
      agent_id: host.id,
      agent_name: host.name,
      model: 'gpt-4o-mini',
      cases_total: 3,
    });

    const done = await waitForRun(app, started.id);
    expect(done.run.status).toBe('completed');
    expect(done.results).toHaveLength(3);
    expect(llm.calls).toHaveLength(3);
    for (const call of llm.calls) {
      expect(call.model).toBe('gpt-4o-mini');
      expect(call.messages[0]!.content).toContain('You are the HOST reviewer.');
      const user = call.messages[1]!.content;
      expect(user.split(`### ${skill.name}`)).toHaveLength(2);
      expect(user).toContain('EVALUATED-SKILL-BODY');
      for (const other of linked) expect(user).not.toContain(other.name);
    }
  });

  it('AC26: the run keeps the skill body/version it started with; the next run records the new version; disabled skill + host still start', async () => {
    const db = pg.handle.db;
    const hold = gate();
    const seen: string[] = [];
    const llm = new ScriptedLLM(async ({ user }) => {
      seen.push(user);
      await hold.opened;
      return hit();
    });
    const app = await appWith(llm);
    const { skill, host } = await fixture(1);
    await db.update(t.skills).set({ enabled: false }).where(eq(t.skills.id, skill.id));
    await db.update(t.agents).set({ enabled: false }).where(eq(t.agents.id, host.id));

    const first = await startSkill(app, skill.id, host.id);
    expect(first.statusCode, first.body).toBe(202);
    const run1 = first.json() as EvalRunSummary;
    await db.update(t.skills).set({ body: 'CHANGED-BODY', version: skill.version + 1 }).where(eq(t.skills.id, skill.id));
    hold.open();
    await waitForRun(app, run1.id);
    expect(seen[0]).toContain('EVALUATED-SKILL-BODY');
    expect(seen[0]).not.toContain('CHANGED-BODY');
    expect(run1.skill_version).toBe(skill.version);

    const second = (await startSkill(app, skill.id, host.id)).json() as EvalRunSummary;
    expect(second.skill_version).toBe(skill.version + 1);
    await waitForRun(app, second.id);
    expect(seen[1]).toContain('CHANGED-BODY');
  });

  it('AC27: no cases -> 422 no_eval_cases; running -> 409; foreign / unknown host -> 422 host_agent_not_found; unknown skill -> 404', async () => {
    const db = pg.handle.db;
    const hold = gate();
    const app = await appWith(
      new ScriptedLLM(async () => {
        await hold.opened;
        return hit();
      }),
    );
    const empty = await insertSkill(db, workspaceId);
    const { skill, host } = await fixture(1);

    const noCases = await startSkill(app, empty.id, host.id);
    expect(noCases.statusCode).toBe(422);
    expect(noCases.json().error.code).toBe('no_eval_cases');

    const [foreignAgent] = await db
      .insert(t.agents)
      .values({ workspaceId: otherWorkspaceId, name: 'foreign', provider: 'openai', model: 'gpt-4o', systemPrompt: 'p' })
      .returning();
    for (const agentId of [foreignAgent!.id, '00000000-0000-4000-8000-0000000000aa']) {
      const res = await startSkill(app, skill.id, agentId);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('host_agent_not_found');
    }

    expect((await startSkill(app, '00000000-0000-4000-8000-0000000000bb', host.id)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/skills/00000000-0000-4000-8000-0000000000bb/eval-runs' })).statusCode).toBe(404);

    const running = await startSkill(app, skill.id, host.id);
    expect(running.statusCode, running.body).toBe(202);
    const conflict = await startSkill(app, skill.id, host.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('eval_run_active');
    hold.open();
    await waitForRun(app, (running.json() as EvalRunSummary).id);
  });

  it('AC28: the skill runs list is newest first and each case shows its result from the newer run', async () => {
    const app = await appWith(new ScriptedLLM(hit));
    const { skill, host } = await fixture(2);
    const r1 = (await startSkill(app, skill.id, host.id)).json() as EvalRunSummary;
    await waitForRun(app, r1.id);
    const r2 = (await startSkill(app, skill.id, host.id)).json() as EvalRunSummary;
    await waitForRun(app, r2.id);

    const list = await getJson<{ runs: EvalRunSummary[] }>(app, `/skills/${skill.id}/eval-runs?limit=5`);
    expect(list.runs.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(list.runs.every((r) => r.owner_kind === 'skill' && r.skill_id === skill.id)).toBe(true);
    const cases = await getJson<{ cases: AgentEvalCase[] }>(app, `/skills/${skill.id}/eval-cases`);
    expect(cases.cases).toHaveLength(2);
    for (const c of cases.cases) expect(c.last_result).toMatchObject({ run_id: r2.id, status: 'passed' });
  });

  it('AC29: agent reads, run-all and compare ignore skill runs; the host can start its own run meanwhile', async () => {
    const db = pg.handle.db;
    const hold = gate();
    const app = await appWith(
      new ScriptedLLM(async () => {
        await hold.opened;
        return hit();
      }),
    );
    const { skill, host } = await fixture(1);
    await insertCases(db, workspaceId, host.id, 1);
    // A finished skill run of the host (hosted by it), then a running one.
    const finishedSkillRun = (
      await db
        .insert(t.evalSuiteRuns)
        .values({
          workspaceId,
          agentId: host.id,
          agentVersion: 1,
          agentName: host.name,
          ownerKind: 'skill',
          skillId: skill.id,
          skillVersion: 1,
          config: { provider: 'openai', model: 'gpt-4o', system_prompt: 'p', strategy: 'single-pass', skills: [] },
          caseIds: [],
          status: 'completed',
          finishedAt: new Date(),
          recall: 0.5,
        })
        .returning()
    )[0]!;
    const running = (await startSkill(app, skill.id, host.id)).json() as EvalRunSummary;

    // The host's own run starts while its skill run is running.
    const own = await startAgent(app, host.id);
    expect(own.statusCode, own.body).toBe(202);
    const ownRun = own.json() as EvalRunSummary;
    expect(ownRun.owner_kind).toBe('agent');

    // Compare of the skill run with the agent run -> 422.
    hold.open();
    await waitForRun(app, ownRun.id);
    await waitForRun(app, running.id);
    const cmp = await app.inject({ method: 'GET', url: `/eval-runs/compare?a=${finishedSkillRun.id}&b=${ownRun.id}` });
    expect(cmp.statusCode).toBe(422);
    expect(cmp.json().error.code).toBe('runs_not_comparable');

    const runs = await getJson<{ runs: EvalRunSummary[] }>(app, `/agents/${host.id}/eval-runs`);
    expect(runs.runs.map((r) => r.id)).toEqual([ownRun.id]);
    const dash = await getJson<EvalAgentDashboard>(app, `/agents/${host.id}/eval/dashboard`);
    expect(dash.latest?.id).toBe(ownRun.id);
    expect(dash.trend.map((p) => p.id)).toEqual([ownRun.id]);
    expect(dash.cases_total).toBe(1);
    const overview = await getJson<EvalOverview>(app, '/eval/dashboard');
    expect(overview.recent_runs.map((r) => r.id)).not.toContain(running.id);
    expect(overview.recent_runs.map((r) => r.id)).not.toContain(finishedSkillRun.id);
    expect(overview.agents.find((a) => a.agent_id === host.id)?.latest?.id).toBe(ownRun.id);

    // Run-all: a host with only a skill run and no agent cases is skipped for lack of cases.
    const skillHost = await insertAgent(db, workspaceId);
    const { skill: s2 } = await fixture(1);
    await db.insert(t.evalSuiteRuns).values({
      workspaceId,
      agentId: skillHost.id,
      agentVersion: 1,
      agentName: skillHost.name,
      ownerKind: 'skill',
      skillId: s2.id,
      skillVersion: 1,
      config: { provider: 'openai', model: 'gpt-4o', system_prompt: 'p', strategy: 'single-pass', skills: [] },
      caseIds: [],
      status: 'running',
    });
    const all = await app.inject({ method: 'POST', url: '/eval-runs/run-all' });
    expect(all.statusCode, all.body).toBe(202);
    const body = all.json() as EvalRunAllResponse;
    expect(body.skipped).toContainEqual({ agent_id: skillHost.id, reason: 'no_cases' });
    expect(body.started.some((r) => r.owner_kind !== 'agent')).toBe(false);
    for (const r of body.started) await waitForRun(app, r.id);
  });

  it('AC30: deleting the skill removes its cases and runs; deleting the host removes the skill runs it hosted but keeps the cases; a running skill run is reaped at boot', async () => {
    const db = pg.handle.db;
    const app = await appWith(new ScriptedLLM(hit));

    const a = await fixture(2);
    const runA = (await startSkill(app, a.skill.id, a.host.id)).json() as EvalRunSummary;
    await waitForRun(app, runA.id);
    expect((await app.inject({ method: 'DELETE', url: `/skills/${a.skill.id}` })).statusCode).toBe(200);
    expect(await db.select().from(t.evalSuiteRuns).where(eq(t.evalSuiteRuns.id, runA.id))).toHaveLength(0);
    expect(await db.select().from(t.evalCases).where(eq(t.evalCases.ownerId, a.skill.id))).toHaveLength(0);

    const b = await fixture(2);
    const runB = (await startSkill(app, b.skill.id, b.host.id)).json() as EvalRunSummary;
    await waitForRun(app, runB.id);
    expect((await app.inject({ method: 'DELETE', url: `/agents/${b.host.id}` })).statusCode).toBeLessThan(300);
    expect(await db.select().from(t.evalSuiteRuns).where(eq(t.evalSuiteRuns.id, runB.id))).toHaveLength(0);
    expect(await db.select().from(t.evalCases).where(eq(t.evalCases.ownerId, b.skill.id))).toHaveLength(2);

    const c = await fixture(1);
    const [orphan] = await db
      .insert(t.evalSuiteRuns)
      .values({
        workspaceId,
        agentId: c.host.id,
        agentVersion: 1,
        agentName: c.host.name,
        ownerKind: 'skill',
        skillId: c.skill.id,
        skillVersion: 1,
        config: { provider: 'openai', model: 'gpt-4o', system_prompt: 'p', strategy: 'single-pass', skills: [] },
        caseIds: [],
      })
      .returning();
    const rebooted = await appWith(new ScriptedLLM(hit));
    const res = await getJson<{ run: EvalRunSummary }>(rebooted, `/eval-runs/${orphan!.id}`);
    expect(res.run).toMatchObject({ status: 'failed', error: 'interrupted' });
  });

  it('AC31: agent and skill starts share one 10/min/workspace limit (429); the run logs carry the owner ids and no body or diff', async () => {
    const hold = gate();
    const app = await appWith(
      new ScriptedLLM(async () => {
        await hold.opened;
        return hit();
      }),
      { NODE_ENV: 'development' },
    );
    const logged = recordLogs(app);
    const { skill, host } = await fixture(1);
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 1);

    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await startAgent(app, agent.id)).statusCode);
    expect(codes[0]).toBe(202);
    expect(codes.slice(1).every((c) => c === 409)).toBe(true);
    const limited = await startSkill(app, skill.id, host.id);
    expect(limited.statusCode).toBe(429);

    hold.open();
    const [running] = await pg.handle.db.select().from(t.evalSuiteRuns).where(eq(t.evalSuiteRuns.agentId, agent.id));
    await waitForRun(app, running!.id);
    logged.length = 0;

    // A fresh app (fresh limiter): the skill run's own log lines.
    const app2 = await appWith(new ScriptedLLM(hit), { NODE_ENV: 'development' });
    const logged2 = recordLogs(app2);
    const run = (await startSkill(app2, skill.id, host.id)).json() as EvalRunSummary;
    await waitForRun(app2, run.id);
    const lines = logged2.filter((l) => l.msg.startsWith('eval run'));
    expect(lines.map((l) => l.msg)).toEqual(['eval run started', 'eval run finished']);
    expect(lines[0]!.obj).toMatchObject({
      runId: run.id,
      ownerKind: 'skill',
      skillId: skill.id,
      skillVersion: skill.version,
      agentId: host.id,
    });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('EVALUATED-SKILL-BODY');
    expect(text).not.toContain('stripeKey');
  });
});
