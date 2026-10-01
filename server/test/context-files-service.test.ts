/**
 * ContextFilesService with an in-memory store and a fake clone (no DB, no fs):
 * the path/size gates, the suffix rule, the 403/404 split, stale saves, rename
 * collisions, and the content-free log line of every write (AC1–AC5, AC7–AC9).
 */
import { describe, it, expect, vi } from 'vitest';
import { PROJECT_CONTEXT_MAX_DOC_BYTES, PROJECT_CONTEXT_STORE_MAX_FILES } from '@devdigest/shared';
import { ContextFilesService } from '../src/modules/project-context/application/context-files-service.js';
import type {
  CloneDocs,
  ContextFileInfo,
  ContextFileRow,
  ContextStore,
  UsageRow,
} from '../src/modules/project-context/application/ports.js';
import { ConflictError } from '../src/platform/errors.js';

const GLOBS = ['**/{specs,docs,insights}/**/*.md'];
const ROOT = '.devdigest/specs/';

/** A store backed by a Map keyed by path (one repo); counts the calls the tests care about. */
function memoryStore(opts: { usage?: UsageRow[]; repo?: boolean; clonePath?: string | null } = {}) {
  const files = new Map<string, ContextFileRow>();
  const moved: [string, string][] = [];
  const store = {
    findRepo: vi.fn(async (_w: string, id: string) =>
      opts.repo === false ? null : { id, owner: 'o', name: 'n', clonePath: opts.clonePath === undefined ? '/clone' : opts.clonePath },
    ),
    agentExists: async () => true,
    skillExists: async () => true,
    listUsage: async () => opts.usage ?? [],
    getAgentPaths: async () => [],
    getSkillPaths: async () => [],
    replaceAgentPaths: async () => undefined,
    replaceSkillPaths: async () => undefined,
    listFiles: async (): Promise<ContextFileInfo[]> =>
      [...files.values()].map((f) => ({ ...f, chars: f.content.length })),
    findFile: async (_r: string, path: string) => files.get(path) ?? null,
    findFiles: async (_r: string, paths: readonly string[]) => paths.flatMap((p) => files.get(p) ?? []),
    lockRepo: vi.fn(async (_w: string, id: string) => ({ id, owner: 'o', name: 'n', clonePath: '/clone' })),
    insertFile: async (_r: string, path: string, content: string, sizeBytes: number) => {
      if (files.has(path)) throw new ConflictError('taken', undefined, 'path_exists');
      const row = { path, content, sizeBytes, version: 1, updatedAt: new Date('2026-01-01T00:00:00Z') };
      files.set(path, row);
      return row;
    },
    saveFile: async (_r: string, path: string, content: string, sizeBytes: number, base: number) => {
      const cur = files.get(path);
      if (!cur || cur.version !== base) return null;
      const row = { ...cur, content, sizeBytes, version: cur.version + 1 };
      files.set(path, row);
      return row;
    },
    renameFile: async (_r: string, path: string, newPath: string, base: number) => {
      const cur = files.get(path);
      if (!cur || cur.version !== base) return null;
      files.delete(path);
      const row = { ...cur, path: newPath, version: cur.version + 1 };
      files.set(newPath, row);
      return row;
    },
    moveAttachments: async (_r: string, from: string, to: string) => {
      moved.push([from, to]);
    },
    deleteFile: async (_r: string, path: string) => files.delete(path),
  } satisfies ContextStore;
  return { store, files, moved };
}

function build(
  fake: ReturnType<typeof memoryStore>,
  clone: Record<string, string> = {},
) {
  const tx = { run: vi.fn(async <T>(work: (r: { store: ContextStore }) => Promise<T>) => work({ store: fake.store })) };
  const docs: CloneDocs = {
    list: async () => null,
    read: async (_root, path) =>
      path in clone ? { status: 'ok', content: clone[path]!, sizeBytes: clone[path]!.length } : { status: 'not_found' },
  };
  const service = new ContextFilesService({ store: fake.store, tx, docs, globs: GLOBS });
  const log = { info: vi.fn() };
  return { service, tx, log };
}

const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('ContextFilesService.create', () => {
  it('AC1: a bare create twice makes untitled.md then untitled-2.md at version 1', async () => {
    const { service, log } = build(memoryStore());
    const a = await service.create('w', 'r', {}, log);
    const b = await service.create('w', 'r', {}, log);
    expect([a.path, b.path]).toEqual([`${ROOT}untitled.md`, `${ROOT}untitled-2.md`]);
    expect(a).toMatchObject({ version: 1, source: 'store', editable: true, doc_type: 'specs', used_by: 0, content: '' });
  });

  it('AC2: a taken path is path_exists on fail and gets -2 on suffix', async () => {
    const { service, log } = build(memoryStore());
    await service.create('w', 'r', { path: `${ROOT}a.md`, content: 'x' }, log);
    expect(await rejects(service.create('w', 'r', { path: `${ROOT}a.md`, on_conflict: 'fail' }, log))).toMatchObject({
      code: 'path_exists',
    });
    const second = await service.create('w', 'r', { path: `${ROOT}a.md`, on_conflict: 'suffix' }, log);
    expect(second.path).toBe(`${ROOT}a-2.md`);
  });

  it('AC7: invalid paths are 422 invalid_path and nothing is stored', async () => {
    const fake = memoryStore();
    const { service, log } = build(fake);
    for (const path of [
      '../x.md',
      `/${ROOT}a.md`,
      `${ROOT}a b.md`,
      `${ROOT}a.txt`,
      `${ROOT}1/2/3/4/5/6/a.md`,
      'specs/a.md',
    ]) {
      expect(await rejects(service.create('w', 'r', { path }, log)), path).toMatchObject({ code: 'invalid_path' });
    }
    expect(fake.files.size).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('AC7: 300 KB is 413 doc_too_large, a NUL is 422 invalid_content, the 501st file is 422 too_many_files', async () => {
    const fake = memoryStore();
    const { service, log } = build(fake);
    const big = 'a'.repeat(PROJECT_CONTEXT_MAX_DOC_BYTES + 1);
    expect(await rejects(service.create('w', 'r', { content: big }, log))).toMatchObject({ code: 'doc_too_large' });
    // 2-byte characters: the limit is bytes, not characters.
    const wide = 'é'.repeat(PROJECT_CONTEXT_MAX_DOC_BYTES / 2 + 1);
    expect(await rejects(service.create('w', 'r', { content: wide }, log))).toMatchObject({ code: 'doc_too_large' });
    expect(await rejects(service.create('w', 'r', { content: 'a\0b' }, log))).toMatchObject({ code: 'invalid_content' });
    for (let i = 0; i < PROJECT_CONTEXT_STORE_MAX_FILES; i++) {
      fake.files.set(`${ROOT}f${i}.md`, { path: `${ROOT}f${i}.md`, content: '', sizeBytes: 0, version: 1, updatedAt: new Date() });
    }
    expect(await rejects(service.create('w', 'r', {}, log))).toMatchObject({ code: 'too_many_files' });
  });

  it('AC8: a path the clone already holds is path_exists on fail and skipped on suffix', async () => {
    const { service, log } = build(memoryStore(), { [`${ROOT}existing.md`]: 'repo' });
    expect(await rejects(service.create('w', 'r', { path: `${ROOT}existing.md` }, log))).toMatchObject({
      code: 'path_exists',
    });
    const s = await service.create('w', 'r', { path: `${ROOT}existing.md`, on_conflict: 'suffix' }, log);
    expect(s.path).toBe(`${ROOT}existing-2.md`);
  });

  it('unknown repo is 404 repo_not_found before the path is judged', async () => {
    const { service, log } = build(memoryStore({ repo: false }));
    expect(await rejects(service.create('w', 'r', { path: '../x.md' }, log))).toMatchObject({ code: 'repo_not_found' });
  });

  it('AC9: one log line with repo id, operation, path, size and version, never the content', async () => {
    const { service, log } = build(memoryStore());
    await service.create('w', 'r', { path: `${ROOT}a.md`, content: 'secret-body' }, log);
    expect(log.info).toHaveBeenCalledTimes(1);
    const [obj] = log.info.mock.calls[0]!;
    expect(obj).toEqual({ repo_id: 'r', operation: 'create', path: `${ROOT}a.md`, size: 11, version: 1 });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('secret-body');
  });
});

describe('ContextFilesService.save', () => {
  it('AC3: saves at the base version (v2), a second save at v1 is stale_version with current_version 2', async () => {
    const fake = memoryStore();
    const { service, log } = build(fake);
    await service.create('w', 'r', { path: `${ROOT}a.md`, content: 'one' }, log);
    const saved = await service.save('w', 'r', `${ROOT}a.md`, { content: 'two', base_version: 1 }, log);
    expect(saved).toMatchObject({ version: 2, content: 'two' });
    const err = await rejects(service.save('w', 'r', `${ROOT}a.md`, { content: 'three', base_version: 1 }, log));
    expect(err).toMatchObject({ code: 'stale_version', details: { current_version: 2 } });
    expect(fake.files.get(`${ROOT}a.md`)?.content).toBe('two');
  });

  it('AC8: a clone file is 403 read_only, a path in neither is 404 doc_not_found', async () => {
    const { service, log } = build(memoryStore(), { [`${ROOT}existing.md`]: 'repo', 'docs/r.md': 'r' });
    const save = (path: string) => service.save('w', 'r', path, { content: 'x', base_version: 1 }, log);
    expect(await rejects(save(`${ROOT}existing.md`))).toMatchObject({ code: 'read_only' });
    expect(await rejects(save('docs/r.md'))).toMatchObject({ code: 'read_only' });
    expect(await rejects(save(`${ROOT}nope.md`))).toMatchObject({ code: 'doc_not_found' });
    expect(await rejects(save('../../etc/passwd.md'))).toMatchObject({ code: 'doc_not_found' });
  });

  it('413 / 422 on content, nothing written', async () => {
    const fake = memoryStore();
    const { service, log } = build(fake);
    await service.create('w', 'r', { path: `${ROOT}a.md`, content: 'one' }, log);
    const big = 'a'.repeat(PROJECT_CONTEXT_MAX_DOC_BYTES + 1);
    expect(await rejects(service.save('w', 'r', `${ROOT}a.md`, { content: big, base_version: 1 }, log))).toMatchObject({
      code: 'doc_too_large',
    });
    expect(await rejects(service.save('w', 'r', `${ROOT}a.md`, { content: '\0', base_version: 1 }, log))).toMatchObject({
      code: 'invalid_content',
    });
    expect(fake.files.get(`${ROOT}a.md`)).toMatchObject({ content: 'one', version: 1 });
  });
});

describe('ContextFilesService.rename', () => {
  it('AC4: moves the file and its attachments in one transaction, bumping the version', async () => {
    const usage: UsageRow[] = [{ path: `${ROOT}api/public.md`, agentId: 'a', agentName: 'A', via: 'direct', skillName: null }];
    const fake = memoryStore({ usage });
    const { service, tx, log } = build(fake);
    await service.create('w', 'r', { path: `${ROOT}a.md`, content: 'x' }, log);
    tx.run.mockClear();
    const res = await service.rename('w', 'r', { path: `${ROOT}a.md`, new_path: `${ROOT}api/public.md`, base_version: 1 }, log);
    expect(res).toMatchObject({ path: `${ROOT}api/public.md`, version: 2, used_by: 1 });
    expect(fake.moved).toEqual([[`${ROOT}a.md`, `${ROOT}api/public.md`]]);
    expect(tx.run).toHaveBeenCalledTimes(1);
    expect(fake.files.has(`${ROOT}a.md`)).toBe(false);
  });

  it('path_exists for a store or clone target, invalid_path for a bad one, stale_version, no-op for the same path', async () => {
    const fake = memoryStore();
    const { service, log } = build(fake, { [`${ROOT}existing.md`]: 'repo' });
    await service.create('w', 'r', { path: `${ROOT}a.md` }, log);
    await service.create('w', 'r', { path: `${ROOT}b.md` }, log);
    const rename = (to: string, base = 1) =>
      service.rename('w', 'r', { path: `${ROOT}a.md`, new_path: to, base_version: base }, log);
    expect(await rejects(rename(`${ROOT}b.md`))).toMatchObject({ code: 'path_exists' });
    expect(await rejects(rename(`${ROOT}existing.md`))).toMatchObject({ code: 'path_exists' });
    expect(await rejects(rename('../x.md'))).toMatchObject({ code: 'invalid_path' });
    expect(await rejects(rename(`${ROOT}c.md`, 7))).toMatchObject({ code: 'stale_version', details: { current_version: 1 } });
    expect(fake.moved).toEqual([]);
    expect((await rename(`${ROOT}a.md`)).version).toBe(1);
  });

  it('a clone file is 403 read_only, an unknown path 404', async () => {
    const { service, log } = build(memoryStore(), { [`${ROOT}existing.md`]: 'repo' });
    const rename = (path: string) => service.rename('w', 'r', { path, new_path: `${ROOT}z.md`, base_version: 1 }, log);
    expect(await rejects(rename(`${ROOT}existing.md`))).toMatchObject({ code: 'read_only' });
    expect(await rejects(rename(`${ROOT}nope.md`))).toMatchObject({ code: 'doc_not_found' });
  });
});

describe('ContextFilesService.delete', () => {
  it('removes the file only, logs once, and 403 / 404 for non-store paths', async () => {
    const fake = memoryStore();
    const { service, log } = build(fake, { [`${ROOT}existing.md`]: 'repo' });
    await service.create('w', 'r', { path: `${ROOT}a.md`, content: 'abc' }, log);
    log.info.mockClear();
    await service.delete('w', 'r', `${ROOT}a.md`, log);
    expect(fake.files.size).toBe(0);
    expect(log.info).toHaveBeenCalledWith({ repo_id: 'r', operation: 'delete', path: `${ROOT}a.md`, size: 3, version: 1 });
    expect(await rejects(service.delete('w', 'r', `${ROOT}a.md`, log))).toMatchObject({ code: 'doc_not_found' });
    expect(await rejects(service.delete('w', 'r', `${ROOT}existing.md`, log))).toMatchObject({ code: 'read_only' });
  });
});
