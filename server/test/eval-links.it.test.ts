import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const PATCH = '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';

/** Finding → eval case link on the PR screen payload (AC22) and agent delete cascade (AC20). */
d('eval links + agent delete (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let seq = 0;

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    app = await buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient({ pulls: [] }) },
    });
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  /** An agent, a PR with one patch, a review of that agent and `lines.length` accepted findings. */
  async function scenario(lines: number[] = [11]) {
    const db = pg.handle.db;
    const n = ++seq;
    const [agent] = await db
      .insert(t.agents)
      .values({ workspaceId, name: `link-agent-${n}`, provider: 'openai', model: 'gpt-4o', systemPrompt: 'review' })
      .returning();
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: `links-${n}`, fullName: `acme/links-${n}` })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({ workspaceId, repoId: repo!.id, number: 300 + n, title: 'PR', author: 'dev', branch: 'f', base: 'main', headSha: 'abc' })
      .returning();
    await db.insert(t.prFiles).values({ prId: pr!.id, path: 'src/config.ts', patch: PATCH });
    const [review] = await db
      .insert(t.reviews)
      .values({ workspaceId, prId: pr!.id, agentId: agent!.id, kind: 'review' })
      .returning();
    const findings = await db
      .insert(t.findings)
      .values(
        lines.map((line) => ({
          reviewId: review!.id,
          file: 'src/config.ts',
          startLine: line,
          endLine: line,
          severity: 'CRITICAL',
          category: 'security',
          title: `Finding ${line}`,
          rationale: 'r',
          confidence: 0.9,
          acceptedAt: new Date(),
        })),
      )
      .returning();
    return { agent: agent!, pr: pr!, findings };
  }

  const reviewsOf = async (prId: string) =>
    (await app.inject({ method: 'GET', url: `/pulls/${prId}/reviews` })).json() as Array<{
      findings: Array<{ id: string; eval_case_id?: string | null }>;
    }>;

  it('AC22: a finding with a case carries its id, the others null', async () => {
    const s = await scenario([11, 12]);
    const created = await app.inject({ method: 'POST', url: `/findings/${s.findings[0]!.id}/eval-case` });
    expect(created.statusCode, created.body).toBe(201);

    const [review] = await reviewsOf(s.pr.id);
    const byId = new Map(review!.findings.map((f) => [f.id, f.eval_case_id]));
    expect(byId.get(s.findings[0]!.id)).toBe(created.json().id);
    expect(byId.get(s.findings[1]!.id)).toBeNull();
  });

  it('AC22: accepting / dismissing a finding keeps its eval_case_id in the response', async () => {
    const s = await scenario([11]);
    const created = await app.inject({ method: 'POST', url: `/findings/${s.findings[0]!.id}/eval-case` });
    const res = await app.inject({ method: 'POST', url: `/findings/${s.findings[0]!.id}/dismiss` });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.stringify(res.json())).toContain(created.json().id);
  });

  it('AC20: deleting the agent removes its cases and runs, and nobody else\'s', async () => {
    const mine = await scenario([11]);
    const other = await scenario([11]);
    const c1 = await app.inject({ method: 'POST', url: `/findings/${mine.findings[0]!.id}/eval-case` });
    const c2 = await app.inject({ method: 'POST', url: `/findings/${other.findings[0]!.id}/eval-case` });
    const db = pg.handle.db;
    const [run] = await db
      .insert(t.evalSuiteRuns)
      .values({
        workspaceId,
        agentId: mine.agent.id,
        agentVersion: 1,
        config: { provider: 'openai', model: 'gpt-4o', system_prompt: 'p', strategy: 'auto', skills: [] },
        caseIds: [c1.json().id],
        status: 'completed',
        casesTotal: 1,
      })
      .returning();
    await db.insert(t.evalRuns).values({ caseId: c1.json().id, runId: run!.id, status: 'passed' });

    const del = await app.inject({ method: 'DELETE', url: `/agents/${mine.agent.id}` });
    expect(del.statusCode, del.body).toBeLessThan(300);

    expect(await db.select().from(t.evalCases).where(eq(t.evalCases.id, c1.json().id))).toEqual([]);
    expect(await db.select().from(t.evalSuiteRuns).where(eq(t.evalSuiteRuns.id, run!.id))).toEqual([]);
    expect(await db.select().from(t.evalRuns).where(eq(t.evalRuns.runId, run!.id))).toEqual([]);
    const remaining = await db.select().from(t.evalCases).where(inArray(t.evalCases.id, [c2.json().id]));
    expect(remaining).toHaveLength(1);
  });
});
