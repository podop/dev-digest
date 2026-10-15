import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AgentEvalCase, AuthProvider, EvalRunSummary } from '@devdigest/shared';
import { EVAL_CASES_PER_AGENT_MAX, EVAL_INPUT_DIFF_MAX_CHARS } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import {
  ScriptedLLM,
  buildEvalApp,
  finding,
  gate,
  insertAgent,
  insertCases,
  insertSkill,
  manualCaseBody,
  recordLogs,
  waitForRun,
} from './helpers/eval-fixtures.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const HUNK = '@@ -10,3 +10,3 @@\n   port: 3000,\n-  old: 1,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';
const FINDING_HUNK = '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';

/** Manual cases, editing and skill owners end to end on a real Postgres (specs/2026-10-15-eval-case-editor.md AC1-AC13, AC24). */
d('eval case editor API (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let app: FastifyInstance;
  let otherApp: FastifyInstance;
  const llm = new ScriptedLLM(() => [finding('Hardcoded key')]);
  const extra: FastifyInstance[] = [];

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    const [other] = await pg.handle.db.insert(t.workspaces).values({ name: 'other-tenant' }).returning();
    otherWorkspaceId = other!.id;
    app = await buildEvalApp(pg.handle.db, llm);
    const auth: AuthProvider = {
      currentUser: async () => ({ id: '00000000-0000-4000-8000-000000000001', email: 'o@x', name: 'Other' }),
      currentWorkspace: async () => ({ id: otherWorkspaceId, name: 'other-tenant' }),
    };
    otherApp = await buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient({ pulls: [] }), auth },
    });
  });
  afterAll(async () => {
    for (const a of [app, otherApp, ...extra]) await a?.close();
    await pg?.stop();
  });

  const post = (kind: 'agents' | 'skills', id: string, payload: unknown, on = app) =>
    on.inject({ method: 'POST', url: `/${kind}/${id}/eval-cases`, payload: payload as object });
  const patch = (id: string, payload: unknown, on = app) =>
    on.inject({ method: 'PATCH', url: `/eval-cases/${id}`, payload: payload as object });
  const list = async (kind: 'agents' | 'skills', id: string) =>
    ((await app.inject({ method: 'GET', url: `/${kind}/${id}/eval-cases` })).json() as { cases: AgentEvalCase[] }).cases;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: unknown } }).error;

  it('AC1: header-less hunk -> 201 manual case with null source ids / repo / PR number and a one-file diff', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const res = await post('agents', agent.id, manualCaseBody({ notes: 'from incident' }));
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json() as AgentEvalCase;
    expect(c).toMatchObject({
      owner_kind: 'agent',
      owner_id: agent.id,
      agent_id: agent.id,
      origin: 'manual',
      name: 'Manual case',
      notes: 'from incident',
      source_finding_id: null,
      source_pr_id: null,
      last_result: null,
      content_edited_at: null,
      expectation: { kind: 'must_find', file: 'src/a.ts', start_line: 11, end_line: 11, severity: null, category: null, title: null },
      input_meta: { pr_title: 'Manual case', pr_description: null, repo: null, pr_number: null, head_sha: null },
    });
    const diff = parseUnifiedDiff(c.input_diff);
    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(diff.files[0]?.hunks[0]?.newLineNumbers).toContain(11);
    const [row] = await pg.handle.db.select().from(t.evalCases).where(eq(t.evalCases.id, c.id));
    expect(row).toMatchObject({ sourceFindingId: null, sourceReviewId: null, sourcePrId: null });
  });

  it('AC2: a two-file CRLF git diff keeps both files, stores LF, expectation on the second file', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const two = [
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n' + HUNK,
      'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,2 @@\n x\n+y',
    ]
      .join('\n')
      .replace(/\n/g, '\r\n');
    const res = await post('agents', agent.id, manualCaseBody({ input_diff: two, expectation: { kind: 'must_not_flag', file: 'src/b.ts', start_line: 2, end_line: 2 } }));
    expect(res.statusCode, res.body).toBe(201);
    const stored = (res.json() as AgentEvalCase).input_diff;
    expect(stored).not.toContain('\r');
    expect(parseUnifiedDiff(stored).files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('AC3: each invalid diff / expectation answers its 422 code (+ details)', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const tooBig = await post('agents', agent.id, manualCaseBody({ input_diff: `@@ -1,1 +1,1 @@\n+${'x'.repeat(EVAL_INPUT_DIFF_MAX_CHARS - 17)}` }));
    expect(tooBig.statusCode).toBe(422);
    expect(errorOf(tooBig).code).toBe('patch_too_large');

    const plain = await post('agents', agent.id, manualCaseBody({ input_diff: 'const a = 1;' }));
    expect(plain.statusCode).toBe(422);
    expect(errorOf(plain).code).toBe('diff_invalid');

    const deleted = await post('agents', agent.id, manualCaseBody({ input_diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a' }));
    expect(errorOf(deleted).code).toBe('diff_invalid');

    const withHeader = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${HUNK}`;
    const badFile = await post('agents', agent.id, manualCaseBody({ input_diff: withHeader, expectation: { kind: 'must_find', file: 'b/src/a.ts', start_line: 11, end_line: 11 } }));
    expect(badFile.statusCode).toBe(422);
    expect(errorOf(badFile)).toMatchObject({ code: 'expectation_file_not_in_diff', details: { files: ['src/a.ts'] } });

    const onDeleted = await post('agents', agent.id, manualCaseBody({ input_diff: '@@ -1,3 +1,1 @@\n ctx\n-gone1\n-gone2', expectation: { kind: 'must_find', file: 'src/a.ts', start_line: 2, end_line: 3 } }));
    expect(onDeleted.statusCode).toBe(422);
    expect(errorOf(onDeleted)).toMatchObject({ code: 'expectation_lines_not_in_diff', details: { ranges: [{ start: 1, end: 1 }] } });
    expect(await list('agents', agent.id)).toHaveLength(0);
  });

  it('AC4: the 201st case of an agent -> 422 eval_case_limit, still 200 cases', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, EVAL_CASES_PER_AGENT_MAX);
    const res = await post('agents', agent.id, manualCaseBody());
    expect(res.statusCode).toBe(422);
    expect(errorOf(res).code).toBe('eval_case_limit');
    expect(await list('agents', agent.id)).toHaveLength(EVAL_CASES_PER_AGENT_MAX);
  });

  it('AC5: unknown / foreign agent or skill -> 404; blank name or end < start -> 422 validation_error', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const skill = await insertSkill(pg.handle.db, workspaceId);
    const missing = '00000000-0000-4000-8000-0000000000ff';
    expect((await post('agents', missing, manualCaseBody())).statusCode).toBe(404);
    expect((await post('skills', missing, manualCaseBody())).statusCode).toBe(404);
    const foreignAgent = await post('agents', agent.id, manualCaseBody(), otherApp);
    expect(foreignAgent.statusCode).toBe(404);
    expect(errorOf(foreignAgent).code).toBe('not_found');
    expect((await post('skills', skill.id, manualCaseBody(), otherApp)).statusCode).toBe(404);
    expect((await otherApp.inject({ method: 'GET', url: `/skills/${skill.id}/eval-cases` })).statusCode).toBe(404);

    const blank = await post('agents', agent.id, manualCaseBody({ name: '   ' }));
    expect(blank.statusCode).toBe(422);
    expect(errorOf(blank).code).toBe('validation_error');
    const inverted = await post('agents', agent.id, manualCaseBody({ expectation: { kind: 'must_find', file: 'src/a.ts', start_line: 12, end_line: 11 } }));
    expect(inverted.statusCode).toBe(422);
    expect(errorOf(inverted).code).toBe('validation_error');
    expect(await list('agents', agent.id)).toHaveLength(0);
  });

  /** A finding-derived case (POST /findings/:id/eval-case) whose stored diff holds new-side lines 10-12. */
  async function findingCase(agentId: string): Promise<AgentEvalCase> {
    const db = pg.handle.db;
    const tag = agentId.slice(0, 6);
    const [repo] = await db.insert(t.repos).values({ workspaceId, owner: 'acme', name: `fc-${tag}`, fullName: `acme/fc-${tag}` }).returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({ workspaceId, repoId: repo!.id, number: 9, title: 'Add rl', author: 'dev', branch: 'f', base: 'main', headSha: 'abc' })
      .returning();
    await db.insert(t.prFiles).values({ prId: pr!.id, path: 'src/config.ts', patch: FINDING_HUNK });
    const [review] = await db.insert(t.reviews).values({ workspaceId, prId: pr!.id, agentId, kind: 'review' }).returning();
    const [f] = await db
      .insert(t.findings)
      .values({ reviewId: review!.id, file: 'src/config.ts', startLine: 11, endLine: 11, severity: 'CRITICAL', category: 'security', title: 'Key', rationale: 'r', confidence: 0.9, acceptedAt: new Date() })
      .returning();
    const res = await app.inject({ method: 'POST', url: `/findings/${f!.id}/eval-case` });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as AgentEvalCase;
  }

  it('AC7: PATCH diff + file + lines together; file not in the stored diff; blank pr_title -> name', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const created = (await post('agents', agent.id, manualCaseBody())).json() as AgentEvalCase;

    const full = await patch(created.id, {
      input_diff: '@@ -1,2 +20,2 @@\n ctx\n+added',
      file: 'src/new.ts',
      start_line: 21,
      end_line: 21,
    });
    expect(full.statusCode, full.body).toBe(200);
    const updated = full.json() as AgentEvalCase;
    expect(updated.expectation).toMatchObject({ file: 'src/new.ts', start_line: 21, end_line: 21 });
    expect(parseUnifiedDiff(updated.input_diff).files.map((f) => f.path)).toEqual(['src/new.ts']);

    const wrongFile = await patch(created.id, { file: 'src/other.ts' });
    expect(wrongFile.statusCode).toBe(422);
    expect(errorOf(wrongFile)).toMatchObject({ code: 'expectation_file_not_in_diff', details: { files: ['src/new.ts'] } });

    const title = await patch(created.id, { name: 'Renamed', pr_title: '' });
    expect(title.statusCode).toBe(200);
    expect((title.json() as AgentEvalCase).input_meta.pr_title).toBe('Renamed');
    // Nothing from the rejected edit was persisted.
    expect((await list('agents', agent.id))[0]?.expectation.file).toBe('src/new.ts');
  });

  it('AC8: kind change on a finding-derived case keeps source ids and stamps content_edited_at once; name does not; line-only miss -> 422', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const c = await findingCase(agent.id);
    expect(c).toMatchObject({ origin: 'finding', content_edited_at: null });

    const nameOnly = await patch(c.id, { name: 'Just a rename', notes: 'n' });
    expect((nameOnly.json() as AgentEvalCase).content_edited_at).toBeNull();

    const kind = await patch(c.id, { kind: 'must_not_flag' });
    expect(kind.statusCode, kind.body).toBe(200);
    const first = kind.json() as AgentEvalCase;
    expect(first).toMatchObject({ origin: 'finding', source_finding_id: c.source_finding_id, expectation: { kind: 'must_not_flag' } });
    expect(first.content_edited_at).not.toBeNull();

    await new Promise((r) => setTimeout(r, 15));
    const again = await patch(c.id, { title: 'Another title', name: 'x' });
    expect((again.json() as AgentEvalCase).content_edited_at).toBe(first.content_edited_at);
    const unchanged = await patch(c.id, { kind: 'must_not_flag' });
    expect((unchanged.json() as AgentEvalCase).content_edited_at).toBe(first.content_edited_at);

    const miss = await patch(c.id, { start_line: 50, end_line: 60 });
    expect(miss.statusCode).toBe(422);
    expect(errorOf(miss)).toMatchObject({ code: 'expectation_lines_not_in_diff', details: { ranges: [{ start: 10, end: 12 }] } });
    expect((await list('agents', agent.id))[0]?.expectation).toMatchObject({ start_line: 11, end_line: 11 });
  });

  it('AC9: the list marks the finding-derived case `finding` and the manual one `manual`', async () => {
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const fromFinding = await findingCase(agent.id);
    const manual = (await post('agents', agent.id, manualCaseBody())).json() as AgentEvalCase;
    const origins = Object.fromEntries((await list('agents', agent.id)).map((c) => [c.id, c.origin]));
    expect(origins).toEqual({ [fromFinding.id]: 'finding', [manual.id]: 'manual' });
  });

  it('AC10 + AC11: manual cases run with the finding ones; the task line has no PR number, no "null", no description block', async () => {
    const recorder = new ScriptedLLM(() => [finding('Hardcoded key')]);
    const runApp = await buildEvalApp(pg.handle.db, recorder);
    extra.push(runApp);
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 2);
    // Two manual cases on the file the double cites: line 11 is in the diff, line 41 is not.
    const manualBody = (name: string, hunk: string, line: number) =>
      manualCaseBody({ name, input_diff: hunk, expectation: { kind: 'must_find', file: 'src/config.ts', start_line: line, end_line: line } });
    const hitCase = await post('agents', agent.id, manualBody('Manual hit', '@@ -10,2 +10,2 @@\n ctx\n+stripeManualHit', 11), runApp);
    expect(hitCase.statusCode, hitCase.body).toBe(201);
    const miss = await post('agents', agent.id, manualBody('Manual miss', '@@ -40,2 +40,2 @@\n ctx\n+stripeManualMiss', 41), runApp);
    expect(miss.statusCode, miss.body).toBe(201);

    const res = await runApp.inject({ method: 'POST', url: `/agents/${agent.id}/eval-runs` });
    expect(res.statusCode, res.body).toBe(202);
    const started = res.json() as EvalRunSummary;
    expect(started.cases_total).toBe(4);
    const done = await waitForRun(runApp, started.id);
    expect(done.run.cases_total).toBe(4);
    expect(done.results).toHaveLength(4);
    const byName = Object.fromEntries(done.results.map((r) => [r.case_name, r.status]));
    expect(byName['Manual hit']).toBe('passed');
    expect(byName['Manual miss']).toBe('failed');

    const manualPrompts = recorder.calls.map((c) => c.messages[1]!.content).filter((u) => u.includes('stripeManual'));
    expect(manualPrompts).toHaveLength(2);
    for (const user of manualPrompts) {
      expect(user).toContain('Review pull request "Manual ');
      expect(user).not.toContain('pull request #');
      expect(user).not.toMatch(/\bnull\b/);
      expect(user).not.toContain('PR body');
    }
  });

  it('AC12: a case created while a run is running is not in it; editing a ran case keeps its last_result', async () => {
    const hold = gate();
    const slow = new ScriptedLLM(async () => {
      await hold.opened;
      return [finding('Hardcoded key')];
    });
    const runApp = await buildEvalApp(pg.handle.db, slow);
    extra.push(runApp);
    const agent = await insertAgent(pg.handle.db, workspaceId);
    await insertCases(pg.handle.db, workspaceId, agent.id, 2);
    const started = (await runApp.inject({ method: 'POST', url: `/agents/${agent.id}/eval-runs` })).json() as EvalRunSummary;
    expect(started.cases_total).toBe(2);

    const during = await post('agents', agent.id, manualCaseBody(), runApp);
    expect(during.statusCode, during.body).toBe(201);
    hold.open();
    const done = await waitForRun(runApp, started.id);
    expect(done.run.cases_total).toBe(2);
    expect(done.results.map((r) => r.case_id)).not.toContain((during.json() as AgentEvalCase).id);

    const ran = ((await runApp.inject({ method: 'GET', url: `/agents/${agent.id}/eval-cases` })).json() as { cases: AgentEvalCase[] }).cases.find((c) => c.last_result);
    expect(ran?.last_result?.run_id).toBe(started.id);
    const edited = await patch(ran!.id, { kind: 'must_not_flag', start_line: 11, end_line: 11 }, runApp);
    expect(edited.statusCode, edited.body).toBe(200);
    expect((edited.json() as AgentEvalCase).last_result).toEqual(ran!.last_result);
  });

  it('AC13: create and edit make zero LLM calls; one info line per created case, no diff text', async () => {
    const throwing = new ScriptedLLM(() => {
      throw new Error('LLM must not be called');
    });
    const spyApp = await buildEvalApp(pg.handle.db, throwing);
    extra.push(spyApp);
    const lines = recordLogs(spyApp);
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const skill = await insertSkill(pg.handle.db, workspaceId);
    const a = await post('agents', agent.id, manualCaseBody({ input_diff: HUNK.replace('sk_live_xxx', 'SECRETDIFFTEXT') }), spyApp);
    const s = await post('skills', skill.id, manualCaseBody(), spyApp);
    expect(a.statusCode, a.body).toBe(201);
    expect(s.statusCode, s.body).toBe(201);
    expect((await patch((a.json() as AgentEvalCase).id, { kind: 'must_not_flag', input_diff: '@@ -1,1 +11,1 @@\n+z' }, spyApp)).statusCode).toBe(200);
    expect(throwing.calls).toHaveLength(0);

    const created = lines.filter((l) => l.msg === 'eval case created');
    expect(created).toHaveLength(2);
    expect(created[0]!.obj).toEqual({
      caseId: (a.json() as AgentEvalCase).id,
      ownerKind: 'agent',
      ownerId: agent.id,
      diffLength: (a.json() as AgentEvalCase).input_diff.length,
    });
    expect(created[1]!.obj).toMatchObject({ ownerKind: 'skill', ownerId: skill.id });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('SECRETDIFFTEXT');
    expect(text).not.toContain('stripeKey');
  });

  it('AC24: a skill case is created, listed with last_result null, and absent from the agent lists', async () => {
    const skill = await insertSkill(pg.handle.db, workspaceId);
    const agent = await insertAgent(pg.handle.db, workspaceId);
    const res = await post('skills', skill.id, manualCaseBody({ name: 'Skill case' }));
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json() as AgentEvalCase;
    expect(c).toMatchObject({ owner_kind: 'skill', owner_id: skill.id, agent_id: null, origin: 'manual', last_result: null });

    const cases = await list('skills', skill.id);
    expect(cases.map((x) => x.id)).toEqual([c.id]);
    expect(cases[0]?.last_result).toBeNull();
    expect(await list('agents', agent.id)).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/skills/00000000-0000-4000-8000-0000000000ff/eval-cases` })).statusCode).toBe(404);

    // A skill case is editable and deletable through the owner-agnostic routes.
    expect((await patch(c.id, { name: 'Renamed skill case' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/eval-cases/${c.id}` })).statusCode).toBe(204);
    expect(await list('skills', skill.id)).toEqual([]);
  });

  it('skill cases are capped at 200 like agent cases; deleting the skill deletes its cases', async () => {
    const skill = await insertSkill(pg.handle.db, workspaceId);
    await pg.handle.db.insert(t.evalCases).values(
      Array.from({ length: EVAL_CASES_PER_AGENT_MAX }, (_, i) => ({
        workspaceId,
        ownerKind: 'skill' as const,
        ownerId: skill.id,
        name: `bulk-${i}`,
        inputDiff: 'd',
        inputMeta: { pr_title: 't', pr_description: null, repo: null, pr_number: null, head_sha: null },
        expectedOutput: { kind: 'must_find', file: 'f.ts', start_line: 1, end_line: 1, severity: null, category: null, title: null },
      })),
    );
    const res = await post('skills', skill.id, manualCaseBody());
    expect(errorOf(res).code).toBe('eval_case_limit');
    expect((await app.inject({ method: 'DELETE', url: `/skills/${skill.id}` })).statusCode).toBeLessThan(300);
    expect(await pg.handle.db.select().from(t.evalCases).where(eq(t.evalCases.ownerId, skill.id))).toHaveLength(0);
  });
});
