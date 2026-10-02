/**
 * Pure builders for the generation input (FR3, FR9): excerpts of root files and the
 * first-task candidate signals. Nothing here reads a file — the application layer
 * passes text in. Secrets never leave this file: `.env.example` yields NAMES only; README/compose are redacted.
 */
import {
  COMPOSE_MAX_CHARS,
  ENV_NAMES_MAX,
  README_MAX_CHARS,
  SCRIPTS_MAX_CHARS,
  TODO_LINE_MAX_CHARS,
  TODO_MAX,
  UNTESTED_MAX,
} from './constants.js';
import { redactSecrets } from './redact.js';

export interface TodoLine {
  path: string;
  line: number;
  text: string;
}

/** Cut to `max` characters, ending with an ellipsis when something was removed. */
export function truncateText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/** README excerpt with secret values redacted (it is sent to the model). */
export function readmeExcerpt(text: string): string | null {
  const t = redactSecrets(text).trim();
  return t.length === 0 ? null : t.slice(0, README_MAX_CHARS);
}

/** docker-compose excerpt with secret values redacted (it is sent to the model). */
export function composeExcerpt(text: string): string | null {
  const t = redactSecrets(text).trim();
  return t.length === 0 ? null : t.slice(0, COMPOSE_MAX_CHARS);
}

/** The `scripts` block of a package.json, re-rendered; null when absent or not parseable. */
export function packageScripts(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return null;
  const entries = Object.entries(scripts as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  );
  if (entries.length === 0) return null;
  return JSON.stringify(Object.fromEntries(entries), null, 2).slice(0, SCRIPTS_MAX_CHARS);
}

const ENV_NAME_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Variable NAMES from a `.env.example`; values and comments are discarded. */
export function envVariableNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_NAME_RE.exec(line);
    if (m?.[1] && !names.includes(m[1])) names.push(m[1]);
    if (names.length >= ENV_NAMES_MAX) break;
  }
  return names;
}

const TODO_RE = /\b(?:TODO|FIXME)\b/;

/** TODO/FIXME lines of one file (1-based line numbers), each cut to the line cap. */
export function findTodoLines(path: string, text: string): TodoLine[] {
  const out: TodoLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (TODO_RE.test(line)) out.push({ path, line: i + 1, text: truncateText(line, TODO_LINE_MAX_CHARS) });
  }
  return out;
}

/** Flatten per-file TODO lines in rank order, capped at TODO_MAX overall. */
export function collectTodoLines(perFile: readonly (readonly TodoLine[])[]): TodoLine[] {
  return perFile.flat().slice(0, TODO_MAX);
}

const TEST_PATH_RE = /(?:[._-](?:test|spec)\.[^/]+$)|(?:(?:^|\/)(?:__tests__|tests?)\/)/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return (dot > 0 ? file.slice(0, dot) : file).toLowerCase();
}

/**
 * Up to UNTESTED_MAX top-ranked source files with no indexed test file whose name
 * contains their base name. `rankedPaths` is rank-descending; tests are never candidates.
 */
export function findUntestedFiles(rankedPaths: readonly string[], indexedPaths: readonly string[]): string[] {
  const testNames = indexedPaths.filter(isTestPath).map((p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase());
  const out: string[] = [];
  for (const path of rankedPaths) {
    if (isTestPath(path)) continue;
    const base = baseName(path);
    if (base.length === 0 || testNames.some((n) => n.includes(base))) continue;
    out.push(path);
    if (out.length >= UNTESTED_MAX) break;
  }
  return out;
}
