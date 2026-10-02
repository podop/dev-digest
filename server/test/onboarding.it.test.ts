/**
 * Onboarding Tour HTTP surface (specs/2026-10-01-onboarding-generator.md): GET/POST
 * /repos/:id/onboarding over real Postgres (Testcontainers). The repo-intel facade,
 * git and every LLM provider are test doubles (overrides — server/INSIGHTS.md), so
 * no model call is made. Covers the stored round-trip (AC1), verified paths (AC2),
 * stale flag (AC5, AC6), errors (AC7, AC8, AC11) and the old-shape read (AC12).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { OnboardingTourState } from '@devdigest/shared';
import type { LLMProvider, StructuredRequest, StructuredResult } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { ConfigError } from '../src/platform/errors.js';
import { MockGitClient, MockLLMProvider } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import type { RepoIntel } from '../src/modules/repo-intel/types.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const FILES = ['src/index.ts', 'src/app.ts', 'src/db.ts', 'src/util.ts', 'README.md', 'package.json'];
const SECRET_VALUE = 'sk-live-do-not-send';
const COMPOSE_SECRET = 's3cret-compose-pw';
const README_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** What the model returns: one invented path and one over-long command exercise the verification. */
const LLM_TOUR = {
  architecture: {
    summary: 'A small `Fastify` service.',
    nodes: [
      { id: 'api', label: 'API', kind: 'entry' },
      { id: 'db', label: 'Postgres', kind: 'store' },
    ],
    edges: [{ from: 'api', to: 'db' }],
  },
  critical_paths: [
    { path: 'src/index.ts', reason: 'Entry point.' },
    { path: 'src/app.ts', reason: 'Builds the app.' },
    { path: 'src/db.ts', reason: 'Data access.' },
    { path: 'src/invented.ts', reason: 'Does not exist.' },
  ],
  run_steps: [{ command: 'pnpm install' }, { command: 'pnpm dev', comment: 'Start the API.' }],
  reading_path: [
    { path: 'README.md', reason: 'Overview.' },
    { path: 'src/index.ts', reason: 'Start here.' },
    { path: 'src/app.ts', reason: 'Wiring.' },
  ],
  first_tasks: [{ title: 'Add tests for util', path: 'src/util.ts', complexity: 'low' }],
};

/** A fake index whose commit and size the tests move. */
function fakeIndex() {
  const state = { filesIndexed: FILES.length, lastIndexedSha: 'sha-1' };
  const facade = {
    getIndexState: async () => ({ ...state }),
    getRepoMap: async () => ({ text: 'src/index.ts\nsrc/app.ts' }),
    getTopFilesByRank: async () => FILES.filter((p) => p.startsWith('src/')),
    getCriticalPaths: async () => [['src/index.ts', 'src/app.ts']],
    listIndexedFiles: async () => [...FILES],
  } as unknown as RepoIntel;
  return { state, facade };
}

d('Onboarding Tour routes (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let seq = 0;
  const apps: FastifyInstance[] = [];
  const index = fakeIndex();
  const git = new MockGitClient({
    files: {
      'README.md': `# Demo\nRun it.\nToken: ${README_TOKEN}\n`,
      'docker-compose.yml': `services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${COMPOSE_SECRET}\n`,
      'package.json': '{"scripts":{"dev":"tsx watch src/index.ts"}}',
      '.env.example': `API_KEY=${SECRET_VALUE}\nPORT=3000\n`,
      'src/index.ts': '// TODO: wire graceful shutdown\n',
    },
  });

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
  });
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await pg?.stop();
  });

  async function appWith(llm: LLMProvider) {
    const app = await buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: { repoIntel: index.facade, git, llm: { openai: llm, anthropic: llm, openrouter: llm } },
    });
    apps.push(app);
    return app;
  }

  const okLlm = () => new MockLLMProvider('openai', { structuredBySchema: { OnboardingTour: LLM_TOUR } });

  async function makeRepo(inWorkspace = workspaceId) {
    const name = `ob-${seq++}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId: inWorkspace, owner: 'acme', name, fullName: `acme/${name}`, defaultBranch: 'main' })
      .returning();
    index.state.filesIndexed = FILES.length;
    index.state.lastIndexedSha = 'sha-1';
    return repo!.id;
  }

  const get = (app: FastifyInstance, id: string) => app.inject({ method: 'GET', url: `/repos/${id}/onboarding` });
  const post = (app: FastifyInstance, id: string) => app.inject({ method: 'POST', url: `/repos/${id}/onboarding` });

  it('GET is none before a tour exists; POST stores a verified tour that GET returns (AC1, AC2)', async () => {
    const llm = okLlm();
    const app = await appWith(llm);
    const id = await makeRepo();
    expect((await get(app, id)).json()).toEqual({ status: 'none' });

    const res = await post(app, id);
    expect(res.statusCode, res.body).toBe(200);
    const body = OnboardingTourState.parse(res.json());
    if (body.status !== 'ready') throw new Error('expected a ready tour');
    expect(body).toMatchObject({ stale: false });
    expect(body.tour).toMatchObject({ repo_id: id, indexed_sha: 'sha-1', files_indexed: FILES.length, language: 'en' });
    expect(body.tour.critical_paths.map((p) => p.path)).toEqual(['src/index.ts', 'src/app.ts', 'src/db.ts']);

    const [row] = await pg.handle.db.select().from(t.onboarding).where(eq(t.onboarding.repoId, id));
    expect(row).toBeDefined();
    const again = (await get(app, id)).json();
    expect(again).toEqual(body);

    // Only variable NAMES of .env.example reach the model, never values.
    const sent = JSON.stringify(llm.calls.map((c) => c.req));
    expect(sent).toContain('API_KEY');
    expect(sent).not.toContain(SECRET_VALUE);
    // README and compose excerpts are redacted too: the key stays, the value does not.
    expect(sent).toContain('POSTGRES_PASSWORD');
    expect(sent).not.toContain(COMPOSE_SECRET);
    expect(sent).not.toContain(README_TOKEN);
  });

  it('GET returns a stored tour within 300 ms (AC13)', async () => {
    const app = await appWith(okLlm());
    const id = await makeRepo();
    expect((await post(app, id)).statusCode).toBe(200);

    expect((await get(app, id)).statusCode).toBe(200); // warm-up
    const started = performance.now();
    const res = await get(app, id);
    const elapsedMs = performance.now() - started;

    expect(res.json()).toMatchObject({ status: 'ready' });
    expect(elapsedMs).toBeLessThan(300);
  });

  it('a new indexed commit flags the stored tour stale; regenerating clears it (AC5, AC6)', async () => {
    const app = await appWith(okLlm());
    const id = await makeRepo();
    expect((await post(app, id)).statusCode).toBe(200);

    index.state.lastIndexedSha = 'sha-2';
    expect((await get(app, id)).json()).toMatchObject({ status: 'ready', stale: true, stale_reason: 'index_changed' });

    expect((await post(app, id)).statusCode).toBe(200);
    expect((await get(app, id)).json()).toMatchObject({ status: 'ready', stale: false });
  });

  it('a stored value of an older shape reads as none (AC12)', async () => {
    const app = await appWith(okLlm());
    const id = await makeRepo();
    await pg.handle.db.insert(t.onboarding).values({ repoId: id, json: { sections: [{ id: 'x', title: 'Old' }] } });
    expect((await get(app, id)).json()).toEqual({ status: 'none' });
  });

  it('unknown and other-workspace repos are 404 repo_not_found', async () => {
    const app = await appWith(okLlm());
    const [other] = await pg.handle.db.insert(t.workspaces).values({ name: 'ob-other' }).returning();
    const foreign = await makeRepo(other!.id);
    for (const id of [foreign, '00000000-0000-4000-8000-0000000000aa']) {
      for (const call of [get, post]) {
        const res = await call(app, id);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: { code: 'repo_not_found' } });
      }
    }
    expect((await get(app, 'not-a-uuid')).statusCode).toBe(422);
  });

  it('an empty index is 422 index_not_ready and no model call is made (AC7)', async () => {
    const llm = okLlm();
    const app = await appWith(llm);
    const id = await makeRepo();
    index.state.filesIndexed = 0;
    const res = await post(app, id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'index_not_ready' } });
    expect(llm.calls).toHaveLength(0);
  });

  it('a provider without a key is 422 provider_not_configured (AC8)', async () => {
    const noKey: LLMProvider = {
      id: 'openai',
      listModels: async () => [],
      complete: async () => {
        throw new ConfigError('OPENAI_API_KEY is not configured');
      },
      completeStructured: async () => {
        throw new ConfigError('OPENAI_API_KEY is not configured');
      },
      embed: async () => [],
    };
    const app = await appWith(noKey);
    const id = await makeRepo();
    const res = await post(app, id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'provider_not_configured' } });
  });

  it('a failed generation is 502 generation_failed and keeps the previous tour (AC11)', async () => {
    const ok = await appWith(okLlm());
    const id = await makeRepo();
    const first = (await post(ok, id)).json();

    const failing = await appWith(new MockLLMProvider('openai', { failStructuredFromCall: 1 }));
    const res = await post(failing, id);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'generation_failed' } });
    expect((await get(failing, id)).json()).toEqual(first);
  });

  it('a second POST while one runs is 409 generation_in_progress; the first still completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const inner = okLlm();
    const slow: LLMProvider = {
      id: 'openai',
      listModels: () => inner.listModels(),
      complete: (req) => inner.complete(req),
      embed: (texts) => inner.embed(texts),
      completeStructured: async <T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> => {
        started();
        await gate;
        return inner.completeStructured(req);
      },
    };
    const app = await appWith(slow);
    const id = await makeRepo();
    const first = post(app, id);
    await running;
    const second = await post(app, id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'generation_in_progress' } });
    release();
    expect((await first).statusCode).toBe(200);
    // The slot is free again.
    expect((await post(app, id)).statusCode).toBe(200);
  });
});
