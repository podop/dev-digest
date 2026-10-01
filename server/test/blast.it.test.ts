/**
 * GET /pulls/:id/blast (server/specs/07-blast-radius.md). The repo-intel
 * facade is replaced via overrides.repoIntel; no model call is made
 * (overrides.llm covers every provider id — server/INSIGHTS.md).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import { BlastRadius as BlastRadiusSchema, PrHistory as PrHistorySchema } from '@devdigest/shared';
import type { BlastRadius, GitHubClient, PrHistory } from '@devdigest/shared';
import type { BlastResult, RepoIntel } from '../src/modules/repo-intel/types.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () =>
  loadConfig({ ...process.env, NODE_ENV: 'test', REVIEW_INTENT_ENABLED: 'false' } as NodeJS.ProcessEnv);

let repoSeq = 0;
async function setupRepoAndPr(db: PgFixture['handle']['db'], workspaceId: string, files: string[]) {
  const name = `blast-${repoSeq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 482,
      title: 'Add rate limiting',
      author: 'marisa.koch',
      branch: 'feat/rl',
      base: 'main',
      headSha: 'a1b2c3d4',
      additions: 5,
      deletions: 1,
      filesCount: files.length,
      status: 'needs_review',
    })
    .returning();
  if (files.length > 0) {
    await db.insert(t.prFiles).values(files.map((path) => ({ prId: pr!.id, path, additions: 1, deletions: 0, patch: null })));
  }
  return { repo: repo!, pr: pr! };
}

function fakeRepoIntel(result: BlastResult) {
  const getBlastRadius = vi.fn(async () => result);
  return { facade: { getBlastRadius } as unknown as RepoIntel, getBlastRadius };
}

d('GET /pulls/:id/blast (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function appWith(facade: RepoIntel, github?: GitHubClient) {
    const llm = new MockLLMProvider('openai');
    return {
      llm,
      appPromise: buildApp({
        config: config(),
        db: pg.handle.db,
        overrides: { llm: { openai: llm, anthropic: llm, openrouter: llm }, repoIntel: facade, ...(github ? { github } : {}) },
      }),
    };
  }

  it('maps the index read to BlastRadius: grouped callers, endpoints/crons, summary; one facade call, no LLM', async () => {
    const { facade, getBlastRadius } = fakeRepoIntel({
      changedSymbols: [
        { name: 'rateLimit', file: 'src/rl.ts', kind: 'function' },
        { name: 'unused', file: 'src/rl.ts', kind: 'function' },
      ],
      callers: [
        { file: 'src/rl.ts', symbol: 'self', viaSymbol: 'rateLimit', line: 2, rank: 0.9 },
        { file: 'src/router.ts', symbol: 'publicRouter', viaSymbol: 'rateLimit', line: 23, rank: 0.8 },
        { file: 'src/cron.ts', symbol: 'sweep', viaSymbol: 'rateLimit', line: 5, rank: 0.4 },
      ],
      impactedEndpoints: ['GET /x'],
      factsByFile: {
        'src/router.ts': { endpoints: ['GET /x', 'POST /y'], crons: [] },
        'src/cron.ts': { endpoints: [], crons: ['nightly'] },
      },
      degraded: false,
    } as BlastResult);
    const { llm, appPromise } = appWith(facade);
    const app = await appPromise;
    const { repo, pr } = await setupRepoAndPr(pg.handle.db, workspaceId, ['src/rl.ts', 'src/other.ts']);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/blast` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BlastRadius;
    expect(() => BlastRadiusSchema.parse(body)).not.toThrow();
    expect(body.changed_symbols.map((s) => s.name)).toEqual(['rateLimit', 'unused']);
    expect(body.downstream).toEqual([
      {
        symbol: 'rateLimit',
        callers: [
          { name: 'publicRouter', file: 'src/router.ts', line: 23 },
          { name: 'sweep', file: 'src/cron.ts', line: 5 },
        ],
        endpoints_affected: ['GET /x', 'POST /y'],
        crons_affected: ['nightly'],
      },
    ]);
    expect(body.summary).toBe('2 changed symbols · 2 callers · 2 endpoints · 1 cron');
    expect(body.degraded).toBe(false);
    expect(getBlastRadius).toHaveBeenCalledTimes(1);
    expect(getBlastRadius).toHaveBeenCalledWith(repo.id, ['src/other.ts', 'src/rl.ts']);
    expect(llm.calls).toHaveLength(0);
  });

  it('passes degraded + reason through', async () => {
    const { facade } = fakeRepoIntel({
      changedSymbols: [],
      callers: [],
      impactedEndpoints: [],
      degraded: true,
      reason: 'no_data',
    });
    const app = await appWith(facade).appPromise;
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, []);

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/blast` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BlastRadius;
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe('no_data');
    expect(body.downstream).toEqual([]);
  });

  it('an unknown PR id is a 404 not_found and the index is not read', async () => {
    const { facade, getBlastRadius } = fakeRepoIntel({ changedSymbols: [], callers: [], impactedEndpoints: [] });
    const app = await appWith(facade).appPromise;

    const res = await app.inject({ method: 'GET', url: `/pulls/${randomUUID()}/blast` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
    expect(getBlastRadius).not.toHaveBeenCalled();
  });

  describe('GET /pulls/:id/history', () => {
    const noIntel = () => fakeRepoIntel({ changedSymbols: [], callers: [], impactedEndpoints: [] }).facade;

    it('returns prior merged PRs touching this PR\'s files, newest first, excluding itself', async () => {
      const github = new MockGitHubClient({
        mergedPulls: [
          { number: 482, title: 'this PR', author: 'me', merged_at: '2026-03-01T00:00:00Z', files: ['src/rl.ts'] },
          { number: 401, title: 'Older limiter', author: 'ann', merged_at: '2026-02-01T00:00:00Z', files: ['src/rl.ts', 'README.md'] },
          { number: 410, title: 'Newer limiter', author: 'bob', merged_at: '2026-02-10T00:00:00Z', files: ['src/other.ts', 'src/rl.ts'] },
          { number: 411, title: 'Unrelated', author: 'eve', merged_at: '2026-02-11T00:00:00Z', files: ['docs/x.md'] },
        ],
      });
      const app = await appWith(noIntel(), github).appPromise;
      const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, ['src/rl.ts', 'src/other.ts']);

      const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/history` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as PrHistory;
      expect(() => PrHistorySchema.parse(body)).not.toThrow();
      expect(body.history).toEqual([
        { pr_number: 410, title: 'Newer limiter', merged_at: '2026-02-10T00:00:00Z', author: 'bob', files_overlap: ['src/other.ts', 'src/rl.ts'], notes: '' },
        { pr_number: 401, title: 'Older limiter', merged_at: '2026-02-01T00:00:00Z', author: 'ann', files_overlap: ['src/rl.ts'], notes: '' },
      ]);
    });

    it('a throwing GitHub client degrades to 200 with an empty list', async () => {
      const github = new MockGitHubClient();
      github.listMergedPullRequests = async () => {
        throw new Error('GitHub is down');
      };
      const app = await appWith(noIntel(), github).appPromise;
      const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId, ['src/rl.ts']);

      const res = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/history` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ history: [] });
    });

    it('an unknown PR id is a 404 not_found', async () => {
      const app = await appWith(noIntel(), new MockGitHubClient()).appPromise;
      const res = await app.inject({ method: 'GET', url: `/pulls/${randomUUID()}/history` });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
    });
  });
});
