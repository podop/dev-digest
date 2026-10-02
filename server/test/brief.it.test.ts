/**
 * PR Brief HTTP surface (specs/2026-10-01-pr-brief.md): GET/POST /pulls/:id/brief over real
 * Postgres (Testcontainers). The LLM is a stub that honours `maxRetries` and counts every
 * model request (adapters/mocks.ts MockLLMProvider has no re-prompt loop); git, GitHub and the
 * repo-intel facade are doubles, so no model, network or clone is touched.
 * Covers AC1-AC4, AC6-AC8, AC11-AC14, AC16 and the GET half of AC17.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { PrBriefResponse } from '@devdigest/shared';
import type {
  CompletionRequest,
  CompletionResult,
  IssueMeta,
  LLMProvider,
  ModelInfo,
  RepoRef,
  StructuredRequest,
  StructuredResult,
} from '@devdigest/shared';
import { estimateTokens } from '@devdigest/reviewer-core';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { ConfigError } from '../src/platform/errors.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import type { RepoIntel } from '../src/modules/repo-intel/types.js';
import { PROMPT_VERSION } from '../src/modules/brief/domain/constants.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const DESCRIPTION_MARKER = 'DESCRIPTION_TEXT_MARKER';
const HUNK_MARKER = 'ZZ_HUNK_BODY_MARKER';
const HEAD = 'a1b2c3d4e5f6a7b8';

const LLM_BRIEF = {
  summary: 'Adds a limiter.',
  risks: [{ kind: 'security', title: 'Header trust', explanation: 'Spoofable.', severity: 'high', file_refs: ['src/a.ts:2'] }],
  review_focus: [{ file: 'src/a.ts', line: 2, reason: 'Start here.' }],
};

/** A repo-intel facade whose blast read is degraded (`no_data`). */
const degradedIntel = {
  getBlastRadius: async () => ({ changedSymbols: [], callers: [], impactedEndpoints: [], degraded: true, reason: 'no_data' }),
} as unknown as RepoIntel;

type Script = (request: number, req: StructuredRequest<unknown>) => unknown | Promise<unknown>;

/** Stub provider: every received response is one "model request", re-asked up to `maxRetries` like the real adapters. */
class StubLlm implements LLMProvider {
  readonly id = 'openai' as const;
  requests = 0;
  inputs: string[] = [];
  models: string[] = [];
  constructor(private readonly script: Script = () => LLM_BRIEF) {}

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
  async complete(_req: CompletionRequest): Promise<CompletionResult> {
    throw new Error('not used');
  }
  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.inputs.push(JSON.stringify(req.messages));
    this.models.push(req.model);
    const max = req.maxRetries ?? 2;
    let attempts = 0;
    while (attempts <= max) {
      attempts++;
      this.requests++;
      const raw = await this.script(this.requests, req as StructuredRequest<unknown>);
      req.onUsage?.({ tokensIn: 100, tokensOut: 20, costUsd: 0.01 });
      const parsed = req.schema.safeParse(raw);
      if (parsed.success) {
        return { data: parsed.data, model: req.model, tokensIn: 100 * attempts, tokensOut: 20 * attempts, costUsd: 0.01 * attempts, raw: JSON.stringify(raw), attempts };
      }
    }
    throw new Error('stub: invalid output');
  }
  async embed(): Promise<number[][]> {
    return [];
  }
}

class NoKeyLlm extends StubLlm {
  override async completeStructured<T>(_req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    throw new ConfigError('no api key');
  }
}

class FailingGitHub extends MockGitHubClient {
  override async getIssue(_repo: RepoRef, _n: number): Promise<IssueMeta> {
    throw new Error('github down');
  }
}

d('PR brief routes (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let seq = 0;
  const apps: FastifyInstance[] = [];
  /** Lines the routes wrote to `req.log` (the test logger is silent). */
  const logged: Record<string, unknown>[] = [];

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
  });
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await pg?.stop();
  });

  async function appWith(llm: LLMProvider, extra: { files?: Record<string, string>; github?: MockGitHubClient } = {}) {
    const app = await buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: {
        repoIntel: degradedIntel,
        git: new MockGitClient({ files: extra.files ?? {} }),
        github: extra.github ?? new MockGitHubClient(),
        llm: { openai: llm, anthropic: llm, openrouter: llm },
      },
    });
    const log = (obj: Record<string, unknown>) => void logged.push(obj);
    app.addHook('onRequest', async (req) => {
      (req as { log: unknown }).log = { info: log, warn: log, error: log, debug: log, trace: log, fatal: log, child: () => ({ info: log, warn: log }) };
    });
    apps.push(app);
    return app;
  }

  async function makePr(opts: { body?: string | null; files?: boolean; head?: string } = {}) {
    const name = `brief-${seq++}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}`, defaultBranch: 'main' })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 1,
        title: 'Add limiter',
        author: 'dev',
        branch: 'feat',
        base: 'main',
        headSha: opts.head ?? HEAD,
        body: opts.body === undefined ? DESCRIPTION_MARKER : opts.body,
      })
      .returning();
    if (opts.files !== false) {
      await pg.handle.db.insert(t.prFiles).values([
        { prId: pr!.id, path: 'src/a.ts', additions: 6, deletions: 1, patch: `@@ -1,3 +1,8 @@\n+${HUNK_MARKER}\n+more` },
        { prId: pr!.id, path: 'src/b.ts', additions: 2, deletions: 0, patch: '@@ -10,0 +11,2 @@\n+x' },
      ]);
    }
    return { repoId: repo!.id, prId: pr!.id };
  }

  async function makeAgentWithReview(prId: string, docs: string[], skillDocs: { repoId: string; paths: string[] } | null, repoId: string, review = true, createdAt = new Date()) {
    const [agent] = await pg.handle.db
      .insert(t.agents)
      .values({ workspaceId, name: `agent-${seq++}`, provider: 'openai', model: 'gpt-4o', systemPrompt: 'review' })
      .returning();
    if (docs.length > 0) {
      await pg.handle.db.insert(t.agentContextDocs).values(docs.map((path, position) => ({ agentId: agent!.id, repoId, path, position })));
    }
    if (skillDocs) {
      const [skill] = await pg.handle.db
        .insert(t.skills)
        .values({ workspaceId, name: `skill-${seq++}`, description: 'd', type: 'custom', source: 'manual', body: 'b' })
        .returning();
      await pg.handle.db.insert(t.agentSkills).values({ agentId: agent!.id, skillId: skill!.id, order: 0 });
      await pg.handle.db
        .insert(t.skillContextDocs)
        .values(skillDocs.paths.map((path, position) => ({ skillId: skill!.id, repoId: skillDocs.repoId, path, position })));
    }
    if (review) {
      await pg.handle.db.insert(t.reviews).values({ workspaceId, prId, agentId: agent!.id, kind: 'review', createdAt });
    }
    return agent!;
  }

  const get = (app: FastifyInstance, id: string) => app.inject({ method: 'GET', url: `/pulls/${id}/brief` });
  const post = (app: FastifyInstance, id: string) => app.inject({ method: 'POST', url: `/pulls/${id}/brief` });
  const storedRow = async (prId: string) => (await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId)))[0];

  it('POST stores a grounded brief; GET returns it with stale false and no model call; defaults list the missing inputs (AC1, AC7, AC11)', async () => {
    const llm = new StubLlm();
    const app = await appWith(llm);
    const { prId } = await makePr();
    expect(PrBriefResponse.parse((await get(app, prId)).json())).toEqual({ brief: null, stale: false });

    const res = await post(app, prId);
    expect(res.statusCode, res.body).toBe(200);
    const body = PrBriefResponse.parse(res.json());
    expect(body.stale).toBe(false);
    expect(body.brief).toMatchObject({
      summary: 'Adds a limiter.',
      head_sha: HEAD,
      prompt_version: PROMPT_VERSION,
      provider: 'openai',
      model: 'gpt-4.1',
      tokens_in: 100,
      cost_usd: 0.01,
      model_requests: 1,
      intent: null,
      blast: null,
      specs_used: [],
    });
    expect(body.brief?.risks.risks[0]?.file_refs).toEqual(['src/a.ts:2']);
    expect(body.brief?.review_focus).toEqual([{ file: 'src/a.ts', line: 2, reason: 'Start here.' }]);
    expect(body.brief?.missing_inputs).toEqual(
      expect.arrayContaining([
        { input: 'intent', reason: 'not_derived' },
        { input: 'blast', reason: 'degraded', detail: 'no_data' },
        { input: 'specs', reason: 'no_review_run' },
        { input: 'linked_issue', reason: 'not_linked' },
      ]),
    );
    expect(llm.requests).toBe(1);

    const again = await get(app, prId);
    expect(again.json()).toEqual(body);
    expect(llm.requests).toBe(1);

    // The PR's stored head moves → stale; the prompt version moves → stale.
    await pg.handle.db.update(t.pullRequests).set({ headSha: 'ffff0000' }).where(eq(t.pullRequests.id, prId));
    expect((await get(app, prId)).json()).toMatchObject({ stale: true });
    await pg.handle.db.update(t.pullRequests).set({ headSha: HEAD }).where(eq(t.pullRequests.id, prId));
    expect((await get(app, prId)).json()).toMatchObject({ stale: false });
    const row = await storedRow(prId);
    await pg.handle.db
      .update(t.prBrief)
      .set({ json: { ...(row!.json as object), prompt_version: 'v0' } })
      .where(eq(t.prBrief.prId, prId));
    expect((await get(app, prId)).json()).toMatchObject({ stale: true });
  });

  it('uses the workspace risk_brief model (AC3)', async () => {
    const llm = new StubLlm();
    const app = await appWith(llm);
    const { prId } = await makePr();
    const put = await app.inject({
      method: 'PUT',
      url: '/settings',
      payload: { feature_models: { risk_brief: { provider: 'openai', model: 'gpt-4o-mini' } } },
    });
    expect(put.statusCode).toBe(200);
    const res = await post(app, prId);
    expect(res.statusCode, res.body).toBe(200);
    expect(llm.models).toEqual(['gpt-4o-mini']);
    expect(res.json().brief.model).toBe('gpt-4o-mini');
    await app.inject({ method: 'PUT', url: '/settings', payload: { feature_models: { risk_brief: null } } });
  });

  it('invalid then valid → 2 requests and 2 request log lines + 1 generation line without PR text; invalid twice → 502, brief unchanged (AC2, AC16)', async () => {
    const llm = new StubLlm((n) => (n === 1 ? { nonsense: true } : LLM_BRIEF));
    const app = await appWith(llm);
    const { prId } = await makePr();
    logged.length = 0;
    const res = await post(app, prId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().brief.model_requests).toBe(2);
    expect(llm.requests).toBe(2);
    const requestLines = logged.filter((l) => l.evt === 'brief_model_request');
    expect(requestLines).toMatchObject([
      { feature: 'brief', prId, attempt: 1, outcome: 'invalid_output' },
      { feature: 'brief', prId, attempt: 2, outcome: 'ok' },
    ]);
    const generated = logged.filter((l) => l.evt === 'brief_generated');
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ prId, modelRequests: 2, tokensIn: 200, tokensOut: 40, costUsd: 0.02, dropped: { risks: 0, review_focus: 0, risk_refs: 0 } });
    expect(typeof generated[0]?.durationMs).toBe('number');
    expect(JSON.stringify(logged)).not.toContain(DESCRIPTION_MARKER);
    const before = await storedRow(prId);

    const bad = new StubLlm(() => ({ nonsense: true }));
    const badApp = await appWith(bad);
    const fail = await post(badApp, prId);
    expect(fail.statusCode).toBe(502);
    expect(fail.json().error?.code ?? fail.json().code).toBe('generation_failed');
    expect(bad.requests).toBe(2);
    expect(await storedRow(prId)).toEqual(before);
  });

  it('keeps hunk bodies and the 50 000-char description out of the input; ≤ 8 000 est. tokens; over_budget docs listed (AC4)', async () => {
    const files: Record<string, string> = {};
    const docPaths: string[] = [];
    for (let i = 0; i < 20; i++) {
      docPaths.push(`docs/d${String(i).padStart(2, '0')}.md`);
      files[docPaths[i]!] = `# doc ${i}\n${'word '.repeat(2_400)}`;
    }
    const llm = new StubLlm();
    const app = await appWith(llm, { files });
    const { prId, repoId } = await makePr({ body: `${DESCRIPTION_MARKER} ${'long '.repeat(10_000)}` });
    await makeAgentWithReview(prId, docPaths, null, repoId);
    const res = await post(app, prId);
    expect(res.statusCode, res.body).toBe(200);
    const sent = llm.inputs[0]!;
    expect(sent).not.toContain(HUNK_MARKER);
    expect(sent).toContain('changed lines 1-8');
    expect(sent).toContain('changed lines 11-12');
    expect(estimateTokens(sent)).toBeLessThanOrEqual(8_000);
    expect(res.json().brief.missing_inputs.some((m: { input: string; reason: string }) => m.input === 'specs' && m.reason === 'over_budget')).toBe(true);
    expect(res.json().brief.specs_used.length).toBeLessThan(20);
  });

  it("specs_used is the reviewed agent's doc then its skill's doc; an agent without a current review is ignored (AC6)", async () => {
    const files = { 'docs/a.md': '# a', 'docs/skill.md': '# s', 'docs/b.md': '# b' };
    const llm = new StubLlm();
    const app = await appWith(llm, { files });
    const { prId, repoId } = await makePr();
    await makeAgentWithReview(prId, ['docs/a.md'], { repoId, paths: ['docs/skill.md'] }, repoId);
    await makeAgentWithReview(prId, ['docs/b.md'], null, repoId, false);
    const res = await post(app, prId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().brief.specs_used).toEqual(['docs/a.md', 'docs/skill.md']);
    expect(res.json().brief.missing_inputs.some((m: { input: string }) => m.input === 'specs')).toBe(false);
  });

  it('an unreadable linked issue → linked_issue/fetch_failed, still 200 (AC8)', async () => {
    const app = await appWith(new StubLlm(), { github: new FailingGitHub() });
    const { prId } = await makePr({ body: 'Fixes #7' });
    const res = await post(app, prId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().brief.missing_inputs).toContainEqual({ input: 'linked_issue', reason: 'fetch_failed' });
  });

  it('a fetched linked issue is sent to the model and not reported missing', async () => {
    const llm = new StubLlm();
    const app = await appWith(llm);
    const { prId } = await makePr({ body: 'Fixes #7' });
    const res = await post(app, prId);
    expect(res.statusCode, res.body).toBe(200);
    expect(llm.inputs[0]).toContain('Issue #7');
    expect(res.json().brief.missing_inputs.some((m: { input: string }) => m.input === 'linked_issue')).toBe(false);
  });

  it('a stored document of the old shape reads as brief null; an unknown PR is 404 (AC12)', async () => {
    const app = await appWith(new StubLlm());
    const { prId } = await makePr();
    await pg.handle.db.insert(t.prBrief).values({ prId, json: { intent: {}, blast: {}, risks: { risks: [] } } });
    expect((await get(app, prId)).json()).toEqual({ brief: null, stale: false });
    const unknown = '00000000-0000-4000-8000-000000000000';
    const g = await get(app, unknown);
    expect(g.statusCode).toBe(404);
    expect(g.json().error?.code ?? g.json().code).toBe('not_found');
    expect((await post(app, unknown)).statusCode).toBe(404);
  });

  it('a second POST while one runs → 409 generation_in_progress and one model sequence (AC13)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const llm = new StubLlm(async () => {
      await gate;
      return LLM_BRIEF;
    });
    const app = await appWith(llm);
    const { prId } = await makePr();
    const first = post(app, prId);
    await expect.poll(() => llm.inputs.length).toBe(1);
    const second = await post(app, prId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error?.code ?? second.json().code).toBe('generation_in_progress');
    release();
    expect((await first).statusCode).toBe(200);
    expect(llm.requests).toBe(1);
  });

  it('no API key → 422 provider_not_configured; no stored files → 422 no_changed_files; no model request either way (AC14)', async () => {
    const noKey = new NoKeyLlm();
    const app = await appWith(noKey);
    const { prId } = await makePr();
    const res = await post(app, prId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error?.code ?? res.json().code).toBe('provider_not_configured');
    expect(noKey.requests).toBe(0);
    expect(await storedRow(prId)).toBeUndefined();

    const llm = new StubLlm();
    const app2 = await appWith(llm);
    const empty = await makePr({ files: false });
    const none = await post(app2, empty.prId);
    expect(none.statusCode).toBe(422);
    expect(none.json().error?.code ?? none.json().code).toBe('no_changed_files');
    expect(llm.requests).toBe(0);
  });

  it('20 GETs of a stored brief each answer within 300 ms (AC17)', async () => {
    const app = await appWith(new StubLlm());
    const { prId } = await makePr();
    expect((await post(app, prId)).statusCode).toBe(200);
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const res = await get(app, prId);
      expect(res.statusCode).toBe(200);
      expect(performance.now() - started).toBeLessThan(300);
    }
  });
});
