import {
  PROJECT_CONTEXT_PATH_MAX,
  PROJECT_CONTEXT_STORE_MAX_DEPTH,
  PROJECT_CONTEXT_STORE_ROOT,
  PROJECT_CONTEXT_STORE_SEGMENT_RE,
} from '@devdigest/shared';
import { DOC_EXTENSION } from './constants.js';

/**
 * Shape rule for a store file path (FR8): starts with `.devdigest/specs/`, ends
 * in `.md`, at most 512 chars, at most 5 folder levels below the root, and every
 * segment is non-empty, not `.` / `..` and made of letters, digits, `.`, `_`, `-`.
 * Pure string check: a store path never reaches the file system (NFR2).
 */
export function checkStorePath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  if (path.length > PROJECT_CONTEXT_PATH_MAX) return false;
  if (!path.startsWith(PROJECT_CONTEXT_STORE_ROOT) || !path.endsWith(DOC_EXTENSION)) return false;
  const segments = path.slice(PROJECT_CONTEXT_STORE_ROOT.length).split('/');
  if (segments.length - 1 > PROJECT_CONTEXT_STORE_MAX_DEPTH) return false;
  return segments.every(
    (seg) => seg !== '.' && seg !== '..' && PROJECT_CONTEXT_STORE_SEGMENT_RE.test(seg),
  );
}

/** `a/b.md` + 2 -> `a/b-2.md`. The caller re-checks the result with `checkStorePath`. */
export function withSuffix(path: string, n: number): string {
  const base = path.endsWith(DOC_EXTENSION) ? path.slice(0, -DOC_EXTENSION.length) : path;
  return `${base}-${n}${DOC_EXTENSION}`;
}

/** Size of a text as stored: its UTF-8 byte length. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** True when the text holds a NUL character (never valid markdown). */
export function hasNul(text: string): boolean {
  return text.includes('\0');
}
