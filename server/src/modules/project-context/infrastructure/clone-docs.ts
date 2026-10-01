/**
 * Markdown documents of a local clone (infrastructure; implements CloneDocs).
 * Symlinks are never followed or listed (EC7), excluded directories are never
 * entered, and every read re-checks that the real path stays under the clone
 * root (NFR3). The path-shape / glob gates live in the domain; callers run them
 * before `read`.
 */
import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { PROJECT_CONTEXT_MAX_DOC_BYTES } from '@devdigest/shared';
import { EXCLUDED_DIRS } from '../domain/constants.js';
import { isListablePath } from '../domain/paths.js';
import type { CloneDocs, ClonedDocInfo, ClonedDocList, ClonedDocRead } from '../application/ports.js';

/** Files stat'ed/read at once while building a list (NFR1). */
const READ_CONCURRENCY = 16;

/** Repo-relative paths of every file under `root` the globs accept. */
async function collectPaths(root: string, globs: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = (await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })) as Dirent[];
    } catch {
      return; // unreadable / vanished directory: skip it
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.includes(e.name)) subdirs.push(relPath);
      } else if (e.isFile() && isListablePath(relPath, globs)) {
        found.push(relPath);
      }
    }
    for (const d of subdirs) await walk(d);
  };
  await walk('');
  return found;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping input order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function describeDoc(root: string, path: string): Promise<ClonedDocInfo | null> {
  try {
    const full = join(root, path);
    const st = await stat(full);
    if (!st.isFile()) return null;
    if (st.size > PROJECT_CONTEXT_MAX_DOC_BYTES) {
      return { path, sizeBytes: st.size, chars: st.size, updatedAt: st.mtime };
    }
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const text = await handle.readFile({ encoding: 'utf8' });
      return { path, sizeBytes: st.size, chars: text.length, updatedAt: st.mtime };
    } finally {
      await handle.close();
    }
  } catch {
    return null; // deleted or unreadable between the walk and the read
  }
}

export class FsCloneDocs implements CloneDocs {
  async list(root: string, globs: readonly string[], limit: number): Promise<ClonedDocList | null> {
    try {
      if (!(await stat(root)).isDirectory()) return null;
    } catch {
      return null;
    }
    const paths = (await collectPaths(root, globs)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const truncated = paths.length > limit;
    const described = await mapBounded(paths.slice(0, limit), READ_CONCURRENCY, (p) => describeDoc(root, p));
    return { docs: described.filter((d): d is ClonedDocInfo => d !== null), truncated };
  }

  async read(root: string, path: string): Promise<ClonedDocRead> {
    try {
      const realRoot = await realpath(root);
      const full = join(realRoot, path);
      if ((await lstat(full)).isSymbolicLink()) return { status: 'not_found' };
      const real = await realpath(full); // an intermediate symlinked directory resolves here
      if (!real.startsWith(realRoot + sep)) return { status: 'not_found' };
      const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = await handle.stat();
        if (!st.isFile()) return { status: 'not_found' };
        if (st.size > PROJECT_CONTEXT_MAX_DOC_BYTES) return { status: 'too_large' };
        return { status: 'ok', content: await handle.readFile({ encoding: 'utf8' }), sizeBytes: st.size };
      } finally {
        await handle.close();
      }
    } catch {
      return { status: 'not_found' }; // ENOENT, ELOOP (O_NOFOLLOW), EACCES…
    }
  }
}
