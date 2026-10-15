import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EvalAgentDashboard, EvalRunList } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { ScriptedLLM, buildEvalApp, finding, insertAgent } from './helpers/eval-fixtures.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const CONFIG = { provider: 'openai', model: 'gpt-4o', system_prompt: 'Line one', strategy: 'single-pass', skills: [] };
const DAY = 86_400_000;
const MINUTE = 60_000;

/** The `period` filter of the agent dashboard and the runs list on a real Postgres (specs/2026-10-15-eval-metric-trends.md AC1-AC5). */
d('eval period filter (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    app = await buildEvalApp(pg.handle.db, new ScriptedLLM(() => [finding('Hardcoded key')]));
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  /** A suite run started `ageMs` ago (explicit startedAt: the ORDER BY depends on it). */
  async function insertRun(
    agentId: string,
    ageMs: number,
    values: Partial<typeof t.evalSuiteRuns.$inferInsert> = {},
  ) {
    const startedAt = new Date(Date.now() - ageMs);
    const [row] = await pg.handle.db
      .insert(t.evalSuiteRuns)
      .values({
        workspaceId,
        agentId,
        agentVersion: 1,
        config: CONFIG,
        caseIds: [],
        status: 'completed',
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 1000),
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

  it('AC1: ?period=30d keeps the 25 finished runs inside 30 days (oldest first); without a period the trend has 20', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    for (let i = 0; i < 5; i++) await insertRun(agent.id, 40 * DAY + i * MINUTE);
    for (let i = 0; i < 25; i++) await insertRun(agent.id, DAY + i * MINUTE);

    const scoped = await getJson<EvalAgentDashboard>(`/agents/${agent.id}/eval/dashboard?period=30d`);
    expect(scoped.trend).toHaveLength(25);
    const starts = scoped.trend.map((r) => Date.parse(r.started_at));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts[0]).toBeGreaterThan(Date.now() - 30 * DAY);

    const plain = await getJson<EvalAgentDashboard>(`/agents/${agent.id}/eval/dashboard`);
    expect(plain.trend).toHaveLength(20);

    const all = await getJson<EvalAgentDashboard>(`/agents/${agent.id}/eval/dashboard?period=all`);
    expect(all.trend).toHaveLength(30);
  });

  it('AC2: 120 finished runs inside 7 days give the newest 100 (period=7d and period=all)', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    for (let i = 0; i < 120; i++) await insertRun(agent.id, DAY + i * MINUTE);
    const newest = await insertRun(agent.id, 1000);

    for (const period of ['7d', 'all']) {
      const dash = await getJson<EvalAgentDashboard>(`/agents/${agent.id}/eval/dashboard?period=${period}`);
      expect(dash.trend).toHaveLength(100);
      expect(dash.trend.at(-1)?.id).toBe(newest.id);
    }
  });

  it('AC3: latest, previous and alert do not depend on the period', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertRun(agent.id, 20 * DAY, { recall: 0.9 });
    await insertRun(agent.id, 10 * DAY, { recall: 0.5 });
    await insertRun(agent.id, 9 * DAY, { recall: 0.4 });

    const plain = await getJson<EvalAgentDashboard>(`/agents/${agent.id}/eval/dashboard`);
    const scoped = await getJson<EvalAgentDashboard>(`/agents/${agent.id}/eval/dashboard?period=7d`);
    expect(scoped.trend).toHaveLength(0);
    expect(scoped.latest).toEqual(plain.latest);
    expect(scoped.previous).toEqual(plain.previous);
    expect(scoped.alert).toEqual(plain.alert);
    expect(plain.alert?.metrics[0]?.metric).toBe('recall');
    expect(scoped.cases_total).toBe(plain.cases_total);
  });

  it('AC4: the runs list with ?period=30d returns runs of any status inside it, newest first', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertRun(agent.id, 60 * DAY);
    const older = await insertRun(agent.id, 5 * DAY);
    const running = await insertRun(agent.id, 1000, { status: 'running', finishedAt: null });

    const { runs } = await getJson<EvalRunList>(`/agents/${agent.id}/eval-runs?period=30d&limit=100`);
    expect(runs.map((r) => r.id)).toEqual([running.id, older.id]);

    const unscoped = await getJson<EvalRunList>(`/agents/${agent.id}/eval-runs?limit=100`);
    expect(unscoped.runs).toHaveLength(3);
  });

  it('AC5: an unknown period is 422 validation_error on both routes', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    for (const url of [`/agents/${agent.id}/eval/dashboard?period=14d`, `/agents/${agent.id}/eval-runs?period=14d`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(422);
      expect(res.json().error?.code ?? res.json().code).toBe('validation_error');
    }
  });
});
