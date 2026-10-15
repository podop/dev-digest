import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  EvalAgentDashboard,
  EvalCompare,
  EvalOverview,
  EvalRunAllResponse,
} from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { ScriptedLLM, buildEvalApp, finding, insertAgent, insertCases, waitForRun } from './helpers/eval-fixtures.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const CONFIG = { provider: 'openai', model: 'gpt-4o', system_prompt: 'Line one\nLine two\nLine three', strategy: 'single-pass', skills: [] };

/** Compare, dashboards and run-all on a real Postgres (specs/eval-pipeline.md AC17-AC19, EC12). */
d('eval compare, dashboards and run-all (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let app: FastifyInstance;
  let clock = Date.now() - 86_400_000;

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    app = await buildEvalApp(pg.handle.db, new ScriptedLLM(() => [finding('Hardcoded key')]));
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  /** A suite run row with explicit metrics; `startedAt` ticks up so the order is the insertion order. */
  async function insertRun(
    agentId: string,
    values: Partial<typeof t.evalSuiteRuns.$inferInsert> = {},
  ) {
    clock += 60_000;
    const [row] = await pg.handle.db
      .insert(t.evalSuiteRuns)
      .values({
        workspaceId,
        agentId,
        agentVersion: 1,
        config: CONFIG,
        caseIds: [],
        status: 'completed',
        startedAt: new Date(clock),
        finishedAt: new Date(clock + 1000),
        casesTotal: 2,
        casesFinished: 2,
        recall: 0.8,
        precision: 0.9,
        citationAccuracy: 1,
        ...values,
      })
      .returning();
    return row!;
  }

  const getJson = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json() as T;

  it('AC17: compare gives B - A deltas, flipped cases and a one-line prompt diff; other agents or unfinished runs are 422', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const [c1, c2] = await insertCases(pg.handle.db, workspaceId, agent.id, 2);
    const a = await insertRun(agent.id, { recall: 0.5, precision: 0.5, citationAccuracy: 1, costUsd: 0.1 });
    const b = await insertRun(agent.id, {
      recall: 1,
      precision: 0.75,
      citationAccuracy: 1,
      costUsd: 0.15,
      config: { ...CONFIG, system_prompt: 'Line one\nLine 2 changed\nLine three', model: 'gpt-4o-mini' },
    });
    await pg.handle.db.insert(t.evalRuns).values([
      { runId: a.id, caseId: c1!.id, status: 'failed', ranAt: new Date(clock - 3000) },
      { runId: a.id, caseId: c2!.id, status: 'passed', ranAt: new Date(clock - 2000) },
      { runId: b.id, caseId: c1!.id, status: 'passed', ranAt: new Date(clock - 1000) },
      { runId: b.id, caseId: c2!.id, status: 'passed', ranAt: new Date(clock - 500) },
    ]);

    const res = await app.inject({ method: 'GET', url: `/eval-runs/compare?a=${a.id}&b=${b.id}` });
    expect(res.statusCode, res.body).toBe(200);
    const cmp = res.json() as EvalCompare;
    expect(cmp.delta).toEqual({ recall: 0.5, precision: 0.25, citation_accuracy: 0, cost_usd: 0.05 });
    expect(cmp.cases).toEqual([
      { case_id: c1!.id, case_name: 'case-0', a: 'failed', b: 'passed', flipped: true },
      { case_id: c2!.id, case_name: 'case-1', a: 'passed', b: 'passed', flipped: false },
    ]);
    const ops = cmp.config_diff.system_prompt;
    expect(ops.filter((l) => l.op === 'add')).toEqual([{ op: 'add', line: 'Line 2 changed' }]);
    expect(ops.filter((l) => l.op === 'del')).toEqual([{ op: 'del', line: 'Line two' }]);
    expect(cmp.config_diff.model).toEqual({ a: 'gpt-4o', b: 'gpt-4o-mini' });
    expect(cmp.config_diff.strategy).toBeNull();

    const other = await insertAgent(pg.handle.db, workspaceId);
    const foreign = await insertRun(other.id);
    const cross = await app.inject({ method: 'GET', url: `/eval-runs/compare?a=${a.id}&b=${foreign.id}` });
    expect(cross.statusCode).toBe(422);
    expect(cross.json().error.code).toBe('runs_not_comparable');

    const running = await insertRun(agent.id, { status: 'running', finishedAt: null });
    const unfinished = await app.inject({ method: 'GET', url: `/eval-runs/compare?a=${a.id}&b=${running.id}` });
    expect(unfinished.statusCode).toBe(422);
    expect(unfinished.json().error.code).toBe('runs_not_comparable');

    const missing = await app.inject({ method: 'GET', url: `/eval-runs/compare?a=${a.id}&b=00000000-0000-4000-8000-0000000000aa` });
    expect(missing.statusCode).toBe(404);
  });

  it('AC18: the regression alert names exactly the metric that fell by >= 0.02; no drop -> null', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 2);
    await insertRun(agent.id, { recall: 0.7, precision: 0.9, citationAccuracy: 0.95 });
    const latest = await insertRun(agent.id, { recall: 0.8, precision: 0.85, citationAccuracy: 0.95 });

    const dash = await getJson<EvalAgentDashboard>(`/agents/${agent.id}/eval/dashboard`);
    expect(dash.alert).toEqual({ metrics: [{ metric: 'precision', delta: -0.05 }] });
    expect(dash.latest?.id).toBe(latest.id);
    expect(dash.previous).not.toBeNull();
    expect(dash.cases_total).toBe(2);
    expect(dash.trend.map((r) => r.id)).toEqual([dash.previous!.id, latest.id]);

    await insertRun(agent.id, { recall: 0.8, precision: 0.84, citationAccuracy: 0.96 });
    const calm = await getJson<EvalAgentDashboard>(`/agents/${agent.id}/eval/dashboard`);
    expect(calm.alert).toBeNull();

    const none = await insertAgent(pg.handle.db, workspaceId);
    expect(await getJson<EvalAgentDashboard>(`/agents/${none.id}/eval/dashboard`)).toMatchObject({
      latest: null,
      previous: null,
      trend: [],
      alert: null,
      cases_total: 0,
    });
    expect((await app.inject({ method: 'GET', url: '/agents/00000000-0000-4000-8000-0000000000aa/eval/dashboard' })).statusCode).toBe(404);
  });

  it('overview: agents with cases or runs only, latest + sparkline (<= 10), recent runs (<= 20) with the agent name', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId, { name: 'Overview Agent' });
    await insertCases(pg.handle.db, workspaceId, agent.id, 1);
    for (let i = 0; i < 12; i++) await insertRun(agent.id, { recall: i / 20 });
    const idle = await insertAgent(pg.handle.db, workspaceId, { name: 'Idle Agent' });

    const overview = await getJson<EvalOverview>('/eval/dashboard');
    const row = overview.agents.find((a) => a.agent_id === agent.id);
    expect(row).toMatchObject({ name: 'Overview Agent', model: 'gpt-4o', cases_total: 1 });
    expect(row!.sparkline).toHaveLength(10);
    expect(row!.latest?.recall).toBe(0.55);
    expect(row!.sparkline.at(-1)?.recall).toBe(0.55);
    expect(overview.agents.some((a) => a.agent_id === idle.id)).toBe(false);
    expect(overview.recent_runs.length).toBeLessThanOrEqual(20);
    expect(overview.recent_runs[0]).toMatchObject({ agent_name: 'Overview Agent' });
  });

  it('AC19: run-all starts agents with cases and no running run and reports the others skipped', async () => {
    const startable = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, startable.id, 1);
    const busy = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, busy.id, 1);
    await insertRun(busy.id, { status: 'running', finishedAt: null });
    const empty = await insertAgent(pg.handle.db, workspaceId);

    const res = await app.inject({ method: 'POST', url: '/eval-runs/run-all' });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as EvalRunAllResponse;
    // Agents left over from the earlier tests have cases too and start as well.
    const startedIds = body.started.map((r) => r.agent_id);
    expect(startedIds).toContain(startable.id);
    expect(startedIds).not.toContain(busy.id);
    expect(startedIds).not.toContain(empty.id);
    expect(body.started.every((r) => r.status === 'running')).toBe(true);
    expect(body.skipped).toContainEqual({ agent_id: busy.id, reason: 'run_active' });
    expect(body.skipped).toContainEqual({ agent_id: empty.id, reason: 'no_cases' });

    for (const run of body.started) expect((await waitForRun(app, run.id)).run.status).toBe('completed');
  });
});
