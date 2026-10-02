import { PROJECT_CONTEXT_MAX_PATHS, PROJECT_CONTEXT_PATH_MAX } from '@devdigest/shared';
import type { ContextDocType } from '@devdigest/shared';
import { DEFAULT_DOC_TYPE, DOC_EXTENSION, EXCLUDED_DIRS } from './constants.js';
import { matchesAnyGlob } from './globs.js';
import { checkStorePath } from './store-files.js';
import type { AttachmentValidation } from './types.js';

/**
 * Shape rule for a document path: repo-relative, `/`-separated, ends in `.md`,
 * at most 512 chars, no NUL, no backslash, no leading `/`, and no empty, `.`
 * or `..` segment. It is checked before any filesystem access (NFR3).
 */
export function checkPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > PROJECT_CONTEXT_PATH_MAX) return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/')) return false;
  if (!path.endsWith(DOC_EXTENSION)) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** True when a directory segment of the path is an excluded directory. */
export function hasExcludedDir(path: string): boolean {
  const dirs = path.split('/').slice(0, -1);
  return dirs.some((d) => EXCLUDED_DIRS.includes(d));
}

/** A path the list would show: right shape, no excluded dir, matches a glob. */
export function isListablePath(path: unknown, globs: readonly string[]): path is string {
  return checkPath(path) && !hasExcludedDir(path) && matchesAnyGlob(path, globs);
}

/** File name of a document path. */
export function docNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** The last `specs` / `docs` / `insights` directory segment, else `docs`. */
export function docTypeOf(path: string): ContextDocType {
  const dirs = path.split('/').slice(0, -1);
  for (let i = dirs.length - 1; i >= 0; i--) {
    const d = dirs[i];
    if (d === 'specs' || d === 'docs' || d === 'insights') return d;
  }
  return DEFAULT_DOC_TYPE;
}

/**
 * Validate a PUT body's path list: at most 50 paths, each listable or a store
 * path (store files are attachable like repo docs), no duplicates. Existence is not checked — a missing file is a run-time status.
 */
export function validateAttachmentPaths(
  paths: readonly unknown[],
  globs: readonly string[],
): AttachmentValidation {
  if (paths.length > PROJECT_CONTEXT_MAX_PATHS) return { ok: false, code: 'too_many_paths' };
  const seen = new Set<string>();
  for (const p of paths) {
    if (!isListablePath(p, globs) && !checkStorePath(p)) return { ok: false, code: 'invalid_path' };
    if (seen.has(p)) return { ok: false, code: 'duplicate_path' };
    seen.add(p);
  }
  return { ok: true };
}
