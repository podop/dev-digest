/**
 * Project Context HTTP surface (specs/2026-10-01-project-context.md): document
 * list + preview from a local clone (AC1, AC2, AC4–AC6, AC12, AC17) and the
 * per-repo agent/skill attachments with `used_by` (AC3, AC7, AC8). Real
 * Postgres (Testcontainers) and a real tmp directory standing in for the clone.
 * No model call is made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ContextDocPreview, ContextList } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = (extra: Record<string, string> = {}) =>
  loadConfig({ ...process.env, NODE_ENV: 'test', ...extra } as NodeJS.ProcessEnv);

d('Project Context routes (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let app: FastifyInstance;
  let tmp: string;
  let seq = 0;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    app = await buildApp({ config: config(), db: pg.handle.db });
    tmp = await mkdtemp(join(tmpdir(), 'pc-it-'));
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  /** A repo row whose clone is a fresh tmp dir holding `files` (path → text). */
  async function makeRepo(files: Record<string, string> = {}, opts: { clone?: boolean } = {}) {
    const name = `pc-${seq++}`;
    const dir = join(tmp, name);
    if (opts.clone !== false) {
      await mkdir(dir, { recursive: true });
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), text);
      }
    }
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name,
        fullName: `acme/${name}`,
        clonePath: opts.clone === false ? null : dir,
      })
      .returning();
    return { repo: repo!, dir };
  }

  async function makeAgent(name = `agent-${seq++}`) {
    const [a] = await pg.handle.db
      .insert(t.agents)
      .values({ workspaceId, name, provider: 'openai', model: 'gpt-4o', systemPrompt: 'review' })
      .returning();
    return a!;
  }

  async function makeSkill(name = `skill-${seq++}`) {
    const [s] = await pg.handle.db
      .insert(t.skills)
      .values({ workspaceId, name, description: 'd', type: 'custom', source: 'manual', body: 'b' })
      .returning();
    return s!;
  }

  const list = (repoId: string) => app.inject({ method: 'GET', url: `/repos/${repoId}/context` });
  const doc = (repoId: string, path: string) =>
    app.inject({ method: 'GET', url: `/repos/${repoId}/context/doc?path=${encodeURIComponent(path)}` });

  describe('list', () => {
    it('AC1: lists only .md under specs/docs/insights, skips excluded dirs, with types, sizes, tokens', async () => {
      const { repo } = await makeRepo({
        'specs/a.md': 'a'.repeat(9),
        'docs/b.md': 'bb',
        'insights/c.md': 'c'.repeat(4),
        'src/d.md': 'not matched',
        'node_modules/x/docs/e.md': 'excluded',
        'docs/notes.txt': 'not markdown',
      });
      const res = await list(repo.id);
      expect(res.statusCode).toBe(200);
      const body = ContextList.parse(res.json());
      expect(body.clone_status).toBe('ready');
      expect(body.globs).toEqual(['**/{specs,docs,insights}/**/*.md']);
      expect(body.docs.map((x) => [x.path, x.doc_type, x.size_bytes, x.tokens, x.used_by])).toEqual([
        ['docs/b.md', 'docs', 2, 1, 0],
        ['insights/c.md', 'insights', 4, 1, 0],
        ['specs/a.md', 'specs', 9, 3, 0],
      ]);
      expect(body.docs[0]!.name).toBe('b.md');
      expect(new Date(body.docs[0]!.updated_at).toISOString()).toBe(body.docs[0]!.updated_at);
      expect(body.tokens_total).toBe(5);
      expect(body.truncated).toBeUndefined();
    });

    it('AC2: a custom glob in configuration replaces the default and is echoed', async () => {
      const custom = await buildApp({
        config: config({ PROJECT_CONTEXT_GLOBS: 'src/*.md, rules/**/*.md' }),
        db: pg.handle.db,
      });
      try {
        const { repo } = await makeRepo({
          'specs/a.md': 'x',
          'src/d.md': 'y',
          'src/deep/e.md': 'z',
          'rules/r/f.md': 'w',
        });
        const res = await custom.inject({ method: 'GET', url: `/repos/${repo.id}/context` });
        const body = ContextList.parse(res.json());
        expect(body.globs).toEqual(['src/*.md', 'rules/**/*.md']);
        expect(body.docs.map((x) => x.path)).toEqual(['rules/r/f.md', 'src/d.md']);
      } finally {
        await custom.close();
      }
    });

    it('AC5: a symlink pointing outside the clone is not listed', async () => {
      const { repo, dir } = await makeRepo({ 'specs/a.md': 'a' });
      const outside = join(tmp, 'outside.md');
      await writeFile(outside, 'secret');
      await symlink(outside, join(dir, 'specs', 'link.md'));
      await mkdir(join(tmp, 'outside-dir'), { recursive: true });
      await writeFile(join(tmp, 'outside-dir', 'g.md'), 'secret');
      await symlink(join(tmp, 'outside-dir'), join(dir, 'docs'));
      const body = ContextList.parse((await list(repo.id)).json());
      expect(body.docs.map((x) => x.path)).toEqual(['specs/a.md']);
    });

    it('AC6: a 300 KB document is still listed with its size', async () => {
      const { repo } = await makeRepo({ 'specs/big.md': 'x'.repeat(300_000) });
      const body = ContextList.parse((await list(repo.id)).json());
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0]).toMatchObject({ path: 'specs/big.md', size_bytes: 300_000, tokens: 75_000 });
    });

    it('AC12: a repo with no clone lists not_cloned and no documents', async () => {
      const { repo } = await makeRepo({}, { clone: false });
      const body = ContextList.parse((await list(repo.id)).json());
      expect(body).toMatchObject({ clone_status: 'not_cloned', docs: [], tokens_total: 0 });
    });

    it('a clone path that no longer exists is not_cloned too', async () => {
      const { repo, dir } = await makeRepo({ 'specs/a.md': 'a' });
      await rm(dir, { recursive: true, force: true });
      expect(ContextList.parse((await list(repo.id)).json()).clone_status).toBe('not_cloned');
    });

    it('404 repo_not_found for an unknown repo; 422 for a non-uuid id', async () => {
      const res = await list(randomUUID());
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('repo_not_found');
      expect((await list('nope')).statusCode).toBe(422);
    });

    it('AC17: 500 documents list within 1 s; 501 returns 500 and truncated', async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 500; i++) files[`docs/d${String(i).padStart(3, '0')}.md`] = `# doc ${i}\n`;
      const { repo } = await makeRepo(files);
      const started = performance.now();
      const res = await list(repo.id);
      const elapsed = performance.now() - started;
      const body = ContextList.parse(res.json());
      expect(body.docs).toHaveLength(500);
      expect(body.truncated).toBeUndefined();
      expect(elapsed).toBeLessThan(1000);

      const { repo: over } = await makeRepo({ ...files, 'docs/d500.md': '# extra\n' });
      const cut = ContextList.parse((await list(over.id)).json());
      expect(cut.docs).toHaveLength(500);
      expect(cut.docs.at(-1)!.path).toBe('docs/d499.md');
      expect(cut.truncated).toBe(true);
    });
  });

  describe('preview', () => {
    it('AC4: returns the content, type, tokens and used_by_agents', async () => {
      const { repo } = await makeRepo({ 'specs/a.md': '# Title\n\nbody text' });
      const res = await doc(repo.id, 'specs/a.md');
      expect(res.statusCode).toBe(200);
      const body = ContextDocPreview.parse(res.json());
      expect(body).toMatchObject({
        path: 'specs/a.md',
        name: 'a.md',
        doc_type: 'specs',
        content: '# Title\n\nbody text',
        tokens: 5,
        size_bytes: 18,
        used_by: 0,
        used_by_agents: [],
      });
    });

    it.each(['../x.md', '/etc/a.md', 'specs/a.txt', 'src/d.md', 'specs/../../x.md', 'specs//a.md', 'specs\\a.md', 'node_modules/x/docs/e.md'])(
      'AC4: %s → 400 invalid_path, nothing read',
      async (path) => {
        const { repo } = await makeRepo({ 'specs/a.md': 'a', 'src/d.md': 'd' });
        const res = await doc(repo.id, path);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('invalid_path');
      },
    );

    it('404 doc_not_found for a listable path that does not exist; 404 repo_not_found for an unknown repo', async () => {
      const { repo } = await makeRepo({ 'specs/a.md': 'a' });
      const missing = await doc(repo.id, 'specs/none.md');
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('doc_not_found');
      const noRepo = await doc(randomUUID(), 'specs/a.md');
      expect(noRepo.statusCode).toBe(404);
      expect(noRepo.json().error.code).toBe('repo_not_found');
    });

    it('404 doc_not_found when the repo has no clone', async () => {
      const { repo } = await makeRepo({}, { clone: false });
      const res = await doc(repo.id, 'specs/a.md');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('doc_not_found');
    });

    it('AC5: a symlink file and a file under a symlinked directory are 404, never read', async () => {
      const { repo, dir } = await makeRepo({ 'specs/a.md': 'a' });
      await writeFile(join(tmp, 'secret.md'), 'TOP SECRET');
      await symlink(join(tmp, 'secret.md'), join(dir, 'specs', 'link.md'));
      await mkdir(join(tmp, 'secret-dir'), { recursive: true });
      await writeFile(join(tmp, 'secret-dir', 'g.md'), 'TOP SECRET');
      await symlink(join(tmp, 'secret-dir'), join(dir, 'docs'));
      for (const path of ['specs/link.md', 'docs/g.md']) {
        const res = await doc(repo.id, path);
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('TOP SECRET');
      }
    });

    it('AC6: a 300 KB document is 413 doc_too_large', async () => {
      const { repo } = await makeRepo({ 'specs/big.md': 'x'.repeat(300_000) });
      const res = await doc(repo.id, 'specs/big.md');
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('doc_too_large');
    });
  });

  describe('attachments and used_by', () => {
    const put = (kind: 'agents' | 'skills', id: string, body: unknown) =>
      app.inject({ method: 'PUT', url: `/${kind}/${id}/context`, payload: body as object });
    const get = (kind: 'agents' | 'skills', id: string, repoId: string) =>
      app.inject({ method: 'GET', url: `/${kind}/${id}/context?repoId=${repoId}` });

    it('AC7: PUT keeps the order, GET returns it, the agent version is unchanged', async () => {
      const { repo } = await makeRepo({ 'specs/a.md': 'a', 'docs/b.md': 'b' });
      const agent = await makeAgent();
      const res = await put('agents', agent.id, { repo_id: repo.id, paths: ['docs/b.md', 'specs/a.md'] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ repo_id: repo.id, paths: ['docs/b.md', 'specs/a.md'] });
      expect((await get('agents', agent.id, repo.id)).json()).toEqual({
        repo_id: repo.id,
        paths: ['docs/b.md', 'specs/a.md'],
      });
      const [row] = await pg.handle.db.select().from(t.agents).where(eq(t.agents.id, agent.id));
      expect(row!.version).toBe(agent.version);
      const versions = await pg.handle.db.select().from(t.agentVersions).where(eq(t.agentVersions.agentId, agent.id));
      expect(versions).toHaveLength(0);

      // replace, not append; an empty list clears
      await put('agents', agent.id, { repo_id: repo.id, paths: ['specs/a.md'] });
      expect((await get('agents', agent.id, repo.id)).json().paths).toEqual(['specs/a.md']);
      await put('agents', agent.id, { repo_id: repo.id, paths: [] });
      expect((await get('agents', agent.id, repo.id)).json().paths).toEqual([]);
    });

    it('AC7: paths are not required to exist; lists are per repo', async () => {
      const { repo } = await makeRepo({});
      const { repo: other } = await makeRepo({});
      const agent = await makeAgent();
      const res = await put('agents', agent.id, { repo_id: repo.id, paths: ['specs/gone.md'] });
      expect(res.statusCode).toBe(200);
      expect((await get('agents', agent.id, other.id)).json().paths).toEqual([]);
    });

    it('AC7: duplicate → 422 duplicate_path, 51 → 422 too_many_paths, bad shape → 422 invalid_path, nothing saved', async () => {
      const { repo } = await makeRepo({});
      const agent = await makeAgent();
      await put('agents', agent.id, { repo_id: repo.id, paths: ['specs/keep.md'] });

      const dup = await put('agents', agent.id, { repo_id: repo.id, paths: ['specs/a.md', 'specs/a.md'] });
      expect(dup.statusCode).toBe(422);
      expect(dup.json().error.code).toBe('duplicate_path');

      const many = await put('agents', agent.id, {
        repo_id: repo.id,
        paths: Array.from({ length: 51 }, (_, i) => `specs/${i}.md`),
      });
      expect(many.statusCode).toBe(422);
      expect(many.json().error.code).toBe('too_many_paths');

      for (const bad of ['../x.md', 'src/d.md', 'specs/a.txt', '/specs/a.md']) {
        const res = await put('agents', agent.id, { repo_id: repo.id, paths: [bad] });
        expect(res.statusCode).toBe(422);
        expect(res.json().error.code).toBe('invalid_path');
      }
      expect((await get('agents', agent.id, repo.id)).json().paths).toEqual(['specs/keep.md']);
    });

    it('AC7: 50 paths are accepted', async () => {
      const { repo } = await makeRepo({});
      const agent = await makeAgent();
      const paths = Array.from({ length: 50 }, (_, i) => `specs/${i}.md`);
      expect((await put('agents', agent.id, { repo_id: repo.id, paths })).statusCode).toBe(200);
    });

    it('AC7: unknown agent / repo → 404; a non-uuid repo id → 422', async () => {
      const { repo } = await makeRepo({});
      const agent = await makeAgent();
      const noAgent = await put('agents', randomUUID(), { repo_id: repo.id, paths: [] });
      expect(noAgent.statusCode).toBe(404);
      expect(noAgent.json().error.code).toBe('agent_not_found');
      const noRepo = await put('agents', agent.id, { repo_id: randomUUID(), paths: [] });
      expect(noRepo.statusCode).toBe(404);
      expect(noRepo.json().error.code).toBe('repo_not_found');
      expect((await put('agents', agent.id, { repo_id: 'x', paths: [] })).statusCode).toBe(422);
      expect((await get('agents', randomUUID(), repo.id)).statusCode).toBe(404);
      expect((await get('agents', agent.id, randomUUID())).statusCode).toBe(404);
    });

    it('AC7: concurrent PUTs for one agent serialise (last writer wins, no 500)', async () => {
      const { repo } = await makeRepo({});
      const agent = await makeAgent();
      const bodies = Array.from({ length: 6 }, (_, i) => ({
        repo_id: repo.id,
        paths: [`specs/${i}.md`, 'specs/shared.md'],
      }));
      const results = await Promise.all(bodies.map((b) => put('agents', agent.id, b)));
      expect(results.map((r) => r.statusCode)).toEqual(bodies.map(() => 200));
      const final = (await get('agents', agent.id, repo.id)).json().paths as string[];
      expect(bodies.map((b) => b.paths)).toContainEqual(final);
    });

    it('AC8: a skill keeps the order and its version is unchanged; same errors', async () => {
      const { repo } = await makeRepo({});
      const skill = await makeSkill();
      const res = await put('skills', skill.id, { repo_id: repo.id, paths: ['docs/b.md', 'specs/a.md'] });
      expect(res.statusCode).toBe(200);
      expect((await get('skills', skill.id, repo.id)).json().paths).toEqual(['docs/b.md', 'specs/a.md']);
      const [row] = await pg.handle.db.select().from(t.skills).where(eq(t.skills.id, skill.id));
      expect(row!.version).toBe(skill.version);
      const versions = await pg.handle.db.select().from(t.skillVersions).where(eq(t.skillVersions.skillId, skill.id));
      expect(versions).toHaveLength(0);

      const dup = await put('skills', skill.id, { repo_id: repo.id, paths: ['specs/a.md', 'specs/a.md'] });
      expect(dup.json().error.code).toBe('duplicate_path');
      const unknown = await put('skills', randomUUID(), { repo_id: repo.id, paths: [] });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('skill_not_found');
    });

    it('AC3: used_by counts distinct agents (direct or via a linked skill), only in that repo', async () => {
      const { repo } = await makeRepo({ 'specs/a.md': 'aaaa' });
      const { repo: other } = await makeRepo({ 'specs/a.md': 'aaaa' });
      const x = await makeAgent('Agent X');
      const y = await makeAgent('Agent Y');
      const z = await makeAgent('Agent Z');
      const skill = await makeSkill('Rules Skill');
      await pg.handle.db.insert(t.agentSkills).values([
        { agentId: y.id, skillId: skill.id, order: 0 },
        { agentId: z.id, skillId: skill.id, order: 0 },
      ]);
      await put('agents', x.id, { repo_id: repo.id, paths: ['specs/a.md'] });
      await put('skills', skill.id, { repo_id: repo.id, paths: ['specs/a.md'] });
      // Z also attaches directly: still one agent, `direct` wins
      await put('agents', z.id, { repo_id: repo.id, paths: ['specs/a.md'] });

      const body = ContextList.parse((await list(repo.id)).json());
      expect(body.docs.find((x) => x.path === 'specs/a.md')!.used_by).toBe(3);
      expect(ContextList.parse((await list(other.id)).json()).docs[0]!.used_by).toBe(0);

      const preview = ContextDocPreview.parse((await doc(repo.id, 'specs/a.md')).json());
      expect(preview.used_by).toBe(3);
      expect(preview.used_by_agents).toEqual([
        { id: x.id, name: 'Agent X', via: 'direct' },
        { id: y.id, name: 'Agent Y', via: 'skill', skill_name: 'Rules Skill' },
        { id: z.id, name: 'Agent Z', via: 'direct' },
      ]);
    });

    it('attachments are removed with their repo', async () => {
      const { repo } = await makeRepo({});
      const agent = await makeAgent();
      await put('agents', agent.id, { repo_id: repo.id, paths: ['specs/a.md'] });
      await pg.handle.db.delete(t.repos).where(eq(t.repos.id, repo.id));
      const rows = await pg.handle.db.select().from(t.agentContextDocs).where(eq(t.agentContextDocs.agentId, agent.id));
      expect(rows).toEqual([]);
    });
  });
});
