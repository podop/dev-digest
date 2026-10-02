/**
 * Project Context store files over HTTP (specs/2026-10-01-project-context-files.md):
 * create / save / rename / delete of `.devdigest/specs/` files kept in Postgres,
 * the merged list and preview, and the clone collision rules (AC1-AC4, AC5
 * attachments, AC7-AC9). Real Postgres (Testcontainers) and a tmp directory
 * standing in for the clone. No model call is made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { PROJECT_CONTEXT_MAX_DOC_BYTES, ContextDocPreview, ContextList } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const ROOT = '.devdigest/specs/';

d('Project Context store files (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let app: FastifyInstance;
  let tmp: string;
  let seq = 0;
  /** Lines the routes wrote to `req.log` (the test logger level is silent). */
  const logged: Record<string, unknown>[] = [];

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    app = await buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
    });
    app.addHook('onRequest', async (req) => {
      (req as { log: unknown }).log = { info: (obj: Record<string, unknown>) => logged.push(obj) };
    });
    tmp = await mkdtemp(join(tmpdir(), 'pcf-it-'));
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  async function makeRepo(files: Record<string, string> = {}, opts: { clone?: boolean } = {}) {
    const name = `pcf-${seq++}`;
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
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}`, clonePath: opts.clone === false ? null : dir })
      .returning();
    return repo!;
  }

  async function makeAgent() {
    const [a] = await pg.handle.db
      .insert(t.agents)
      .values({ workspaceId, name: `agent-${seq++}`, provider: 'openai', model: 'gpt-4o', systemPrompt: 'review' })
      .returning();
    return a!;
  }

  async function makeSkill() {
    const [s] = await pg.handle.db
      .insert(t.skills)
      .values({ workspaceId, name: `skill-${seq++}`, description: 'd', type: 'custom', source: 'manual', body: 'b' })
      .returning();
    return s!;
  }

  const q = (path: string) => encodeURIComponent(path);
  const create = (repoId: string, payload?: object) =>
    app.inject({ method: 'POST', url: `/repos/${repoId}/context/files`, ...(payload ? { payload } : {}) });
  const save = (repoId: string, path: string, content: string, base_version: number) =>
    app.inject({ method: 'PUT', url: `/repos/${repoId}/context/files?path=${q(path)}`, payload: { content, base_version } });
  const rename = (repoId: string, path: string, new_path: string, base_version: number) =>
    app.inject({ method: 'POST', url: `/repos/${repoId}/context/files/rename`, payload: { path, new_path, base_version } });
  const del = (repoId: string, path: string) =>
    app.inject({ method: 'DELETE', url: `/repos/${repoId}/context/files?path=${q(path)}` });
  const list = async (repoId: string) => ContextList.parse((await app.inject({ method: 'GET', url: `/repos/${repoId}/context` })).json());
  const preview = (repoId: string, path: string) =>
    app.inject({ method: 'GET', url: `/repos/${repoId}/context/doc?path=${q(path)}` });
  const put = (kind: 'agents' | 'skills', id: string, repo_id: string, paths: string[]) =>
    app.inject({ method: 'PUT', url: `/${kind}/${id}/context`, payload: { repo_id, paths } });
  const attached = async (kind: 'agents' | 'skills', id: string, repoId: string) =>
    (await app.inject({ method: 'GET', url: `/${kind}/${id}/context?repoId=${repoId}` })).json().paths as string[];
  const storedRows = (repoId: string) =>
    pg.handle.db.select().from(t.contextFiles).where(eq(t.contextFiles.repoId, repoId));

  it('AC1: a bare POST twice makes untitled.md and untitled-2.md (201, version 1); the list shows them before repo docs', async () => {
    const repo = await makeRepo({ 'docs/r.md': 'repo doc' });
    const a = await create(repo.id);
    expect(a.statusCode, a.body).toBe(201);
    const b = await create(repo.id);
    expect(ContextDocPreview.parse(a.json())).toMatchObject({
      path: `${ROOT}untitled.md`,
      doc_type: 'specs',
      source: 'store',
      editable: true,
      version: 1,
      content: '',
    });
    expect(b.json().path).toBe(`${ROOT}untitled-2.md`);
    const body = await list(repo.id);
    expect(body.docs.map((x) => [x.path, x.source, x.editable, x.version, x.used_by])).toEqual([
      [`${ROOT}untitled-2.md`, 'store', true, 1, 0],
      [`${ROOT}untitled.md`, 'store', true, 1, 0],
      ['docs/r.md', 'repo', false, undefined, 0],
    ]);
    expect(body.docs[0]).toMatchObject({ doc_type: 'specs', name: 'untitled-2.md', tokens: 0 });
    expect(new Date(body.docs[0]!.updated_at).toISOString()).toBe(body.docs[0]!.updated_at);
  });

  it('the list sorts store paths bytewise (COLLATE "C") and shows them when the repo is not cloned', async () => {
    const repo = await makeRepo({}, { clone: false });
    const paths = [`${ROOT}a/b.md`, `${ROOT}a.md`, `${ROOT}Z.md`, `${ROOT}a-b.md`];
    for (const path of paths) expect((await create(repo.id, { path, content: 'abcdefgh' })).statusCode).toBe(201);
    const body = await list(repo.id);
    expect(body.clone_status).toBe('not_cloned');
    expect(body.docs.map((x) => x.path)).toEqual([...paths].sort());
    expect(body.tokens_total).toBe(8);
  });

  it('a POST with an explicit path and content stores them; preview serves the store first', async () => {
    const repo = await makeRepo();
    const res = await create(repo.id, { path: `${ROOT}notes/a.md`, content: '# Hi\n' });
    expect(res.statusCode).toBe(201);
    const p = await preview(repo.id, `${ROOT}notes/a.md`);
    expect(ContextDocPreview.parse(p.json())).toMatchObject({
      content: '# Hi\n',
      source: 'store',
      editable: true,
      version: 1,
      size_bytes: 5,
      tokens: 2,
      name: 'a.md',
    });
  });

  it('AC2: a taken path is 409 path_exists on fail and gets -2 on suffix', async () => {
    const repo = await makeRepo();
    await create(repo.id, { path: `${ROOT}a.md`, content: 'x' });
    const dup = await create(repo.id, { path: `${ROOT}a.md`, on_conflict: 'fail' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('path_exists');
    const suffixed = await create(repo.id, { path: `${ROOT}a.md`, on_conflict: 'suffix' });
    expect(suffixed.statusCode).toBe(201);
    expect(suffixed.json().path).toBe(`${ROOT}a-2.md`);
  });

  it('AC3: a save at the base version bumps it; a stale save is 409 stale_version and changes nothing', async () => {
    const repo = await makeRepo();
    await create(repo.id, { path: `${ROOT}a.md`, content: 'one' });
    const ok = await save(repo.id, `${ROOT}a.md`, 'two', 1);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ version: 2, content: 'two' });
    expect((await preview(repo.id, `${ROOT}a.md`)).json().content).toBe('two');
    const stale = await save(repo.id, `${ROOT}a.md`, 'three', 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'stale_version', details: { current_version: 2 } });
    expect((await preview(repo.id, `${ROOT}a.md`)).json()).toMatchObject({ content: 'two', version: 2 });
  });

  it('AC4: a rename moves attachments of agents and skills in this repo only, keeping their position', async () => {
    const repo = await makeRepo();
    const other = await makeRepo();
    const oldPath = `${ROOT}a.md`;
    const newPath = `${ROOT}api/public.md`;
    await create(repo.id, { path: oldPath, content: 'x' });
    const agent = await makeAgent();
    const skill = await makeSkill();
    await put('agents', agent.id, repo.id, ['docs/x.md', oldPath, 'docs/y.md']);
    await put('skills', skill.id, repo.id, [oldPath]);
    await put('agents', agent.id, other.id, [oldPath]);

    const res = await rename(repo.id, oldPath, newPath, 1);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ path: newPath, version: 2, used_by: 1 });
    expect(await attached('agents', agent.id, repo.id)).toEqual(['docs/x.md', newPath, 'docs/y.md']);
    expect(await attached('skills', skill.id, repo.id)).toEqual([newPath]);
    expect(await attached('agents', agent.id, other.id)).toEqual([oldPath]);
    expect((await preview(repo.id, oldPath)).statusCode).toBe(404);
    expect((await list(repo.id)).docs.map((x) => x.path)).toEqual([newPath]);
  });

  it('a rename onto a path the owner already attached keeps one row at the moved position', async () => {
    const repo = await makeRepo();
    await create(repo.id, { path: `${ROOT}a.md` });
    const agent = await makeAgent();
    await put('agents', agent.id, repo.id, [`${ROOT}b.md`, `${ROOT}a.md`]);
    expect((await rename(repo.id, `${ROOT}a.md`, `${ROOT}b.md`, 1)).statusCode).toBe(200);
    expect(await attached('agents', agent.id, repo.id)).toEqual([`${ROOT}b.md`]);
  });

  it('rename: stale 409, taken 409 path_exists (rolled back), invalid 422, same path is a no-op', async () => {
    const repo = await makeRepo();
    await create(repo.id, { path: `${ROOT}a.md` });
    await create(repo.id, { path: `${ROOT}b.md` });
    const agent = await makeAgent();
    await put('agents', agent.id, repo.id, [`${ROOT}a.md`]);
    expect((await rename(repo.id, `${ROOT}a.md`, `${ROOT}c.md`, 5)).json().error.code).toBe('stale_version');
    const taken = await rename(repo.id, `${ROOT}a.md`, `${ROOT}b.md`, 1);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('path_exists');
    expect((await rename(repo.id, `${ROOT}a.md`, 'specs/c.md', 1)).statusCode).toBe(422);
    expect((await rename(repo.id, `${ROOT}a.md`, `${ROOT}a.md`, 1)).json().version).toBe(1);
    expect(await attached('agents', agent.id, repo.id)).toEqual([`${ROOT}a.md`]);
    expect((await storedRows(repo.id)).map((r) => [r.path, r.version]).sort()).toEqual([
      [`${ROOT}a.md`, 1],
      [`${ROOT}b.md`, 1],
    ]);
  });

  it('AC5: a delete is 204, the file leaves the list and preview, the attachment stays', async () => {
    const repo = await makeRepo();
    await create(repo.id, { path: `${ROOT}a.md` });
    const agent = await makeAgent();
    await put('agents', agent.id, repo.id, [`${ROOT}a.md`]);
    const res = await del(repo.id, `${ROOT}a.md`);
    expect(res.statusCode).toBe(204);
    expect((await list(repo.id)).docs).toEqual([]);
    expect((await preview(repo.id, `${ROOT}a.md`)).json().error.code).toBe('doc_not_found');
    expect(await attached('agents', agent.id, repo.id)).toEqual([`${ROOT}a.md`]);
    expect((await del(repo.id, `${ROOT}a.md`)).statusCode).toBe(404);
  });

  it('AC7: bad paths are 422 invalid_path on create and rename and store nothing', async () => {
    const repo = await makeRepo();
    for (const path of ['../x.md', `/${ROOT}a.md`, `${ROOT}a b.md`, `${ROOT}a.txt`, `${ROOT}1/2/3/4/5/6/a.md`, 'specs/a.md']) {
      const res = await create(repo.id, { path });
      expect(res.statusCode, path).toBe(422);
      expect(res.json().error.code).toBe('invalid_path');
    }
    expect(await storedRows(repo.id)).toHaveLength(0);
    await create(repo.id, { path: `${ROOT}ok.md` });
    for (const path of ['../x.md', `${ROOT}a b.md`, 'specs/a.md']) {
      expect((await rename(repo.id, `${ROOT}ok.md`, path, 1)).json().error.code, path).toBe('invalid_path');
    }
    expect((await storedRows(repo.id)).map((r) => r.path)).toEqual([`${ROOT}ok.md`]);
  });

  it('AC7: 300 KB is 413 doc_too_large (create and save); a NUL is 422; the 501st file is 422 too_many_files', async () => {
    const repo = await makeRepo();
    const big = 'a'.repeat(300_000);
    const tooBig = await create(repo.id, { path: `${ROOT}big.md`, content: big });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe('doc_too_large');
    await create(repo.id, { path: `${ROOT}a.md`, content: 'x' });
    expect((await save(repo.id, `${ROOT}a.md`, big, 1)).json().error.code).toBe('doc_too_large');
    expect((await save(repo.id, `${ROOT}a.md`, 'a\u0000b', 1)).json().error.code).toBe('invalid_content');
    expect((await storedRows(repo.id)).map((r) => [r.path, r.content, r.version])).toEqual([[`${ROOT}a.md`, 'x', 1]]);

    const full = await makeRepo();
    await pg.handle.db
      .insert(t.contextFiles)
      .values(Array.from({ length: 500 }, (_, i) => ({ repoId: full.id, path: `${ROOT}f${i}.md`, content: '', sizeBytes: 0 })));
    const over = await create(full.id);
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('too_many_files');
    expect(await storedRows(full.id)).toHaveLength(500);
  });

  it('AC8: a path the clone holds is 409 on create and rename, listed read-only, 403 on PUT / rename / DELETE', async () => {
    const repo = await makeRepo({ [`${ROOT}existing.md`]: 'from the repo' });
    expect((await create(repo.id, { path: `${ROOT}existing.md` })).json().error.code).toBe('path_exists');
    const suffixed = await create(repo.id, { path: `${ROOT}existing.md`, on_conflict: 'suffix' });
    expect(suffixed.json().path).toBe(`${ROOT}existing-2.md`);
    await create(repo.id, { path: `${ROOT}mine.md` });
    const taken = await rename(repo.id, `${ROOT}mine.md`, `${ROOT}existing.md`, 1);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('path_exists');

    const body = await list(repo.id);
    const repoDoc = body.docs.find((x) => x.path === `${ROOT}existing.md`);
    expect(repoDoc).toMatchObject({ source: 'repo', editable: false });
    expect(repoDoc!.version).toBeUndefined();
    expect(body.docs.map((x) => x.source)).toEqual(['store', 'store', 'repo']);

    for (const res of [
      await save(repo.id, `${ROOT}existing.md`, 'x', 1),
      await rename(repo.id, `${ROOT}existing.md`, `${ROOT}z.md`, 1),
      await del(repo.id, `${ROOT}existing.md`),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('read_only');
    }
    expect((await save(repo.id, `${ROOT}nope.md`, 'x', 1)).json().error.code).toBe('doc_not_found');
  });

  it('404 repo_not_found for an unknown repo; 422 for a missing base_version', async () => {
    const unknown = randomUUID();
    expect((await create(unknown)).json().error.code).toBe('repo_not_found');
    expect((await save(unknown, `${ROOT}a.md`, 'x', 1)).json().error.code).toBe('repo_not_found');
    expect((await del(unknown, `${ROOT}a.md`)).json().error.code).toBe('repo_not_found');
    const repo = await makeRepo();
    const res = await app.inject({
      method: 'PUT',
      url: `/repos/${repo.id}/context/files?path=${q(`${ROOT}a.md`)}`,
      payload: { content: 'x' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('concurrent writes: bare creates get distinct paths; saves at the same base version let exactly one win', async () => {
    const repo = await makeRepo();
    const created = await Promise.all(Array.from({ length: 5 }, () => create(repo.id)));
    expect(created.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(created.map((r) => r.json().path)).size).toBe(5);

    const path = created[0]!.json().path as string;
    const saves = await Promise.all(['a', 'b', 'c'].map((c) => save(repo.id, path, c, 1)));
    expect(saves.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect((await preview(repo.id, path)).json().version).toBe(2);
  });

  it('AC9: each write logs one content-free line and answers within 300 ms for a 256 KB file', async () => {
    const repo = await makeRepo();
    // Multi-byte text just under the 256 KB limit, so the size is bytes, not characters.
    const content = `${'é'.repeat(PROJECT_CONTEXT_MAX_DOC_BYTES / 2 - 8)}END-OF-BODY`;
    const size = Buffer.byteLength(content);
    const path = `${ROOT}big.md`;
    // Warm-up: first requests pay for pool connections and JIT.
    await create(repo.id, { path: `${ROOT}warm.md`, content });
    await save(repo.id, `${ROOT}warm.md`, content, 1);
    await rename(repo.id, `${ROOT}warm.md`, `${ROOT}warm2.md`, 2);
    await del(repo.id, `${ROOT}warm2.md`);
    logged.length = 0;

    const timed = async <T>(fn: () => Promise<T>) => {
      const start = performance.now();
      const res = await fn();
      return { res, ms: performance.now() - start };
    };
    const c = await timed(() => create(repo.id, { path, content }));
    const s = await timed(() => save(repo.id, path, `${content}!`, 1));
    const r = await timed(() => rename(repo.id, path, `${ROOT}big2.md`, 2));
    const x = await timed(() => del(repo.id, `${ROOT}big2.md`));
    expect([c.res.statusCode, s.res.statusCode, r.res.statusCode, x.res.statusCode]).toEqual([201, 200, 200, 204]);
    for (const { ms } of [c, s, r, x]) expect(ms).toBeLessThan(300);

    expect(logged).toEqual([
      { repo_id: repo.id, operation: 'create', path, size: size, version: 1 },
      { repo_id: repo.id, operation: 'save', path, size: size + 1, version: 2 },
      { repo_id: repo.id, operation: 'rename', path: `${ROOT}big2.md`, size: size + 1, version: 3 },
      { repo_id: repo.id, operation: 'delete', path: `${ROOT}big2.md`, size: size + 1, version: 3 },
    ]);
    expect(JSON.stringify(logged)).not.toContain('END-OF-BODY');
  });
});
