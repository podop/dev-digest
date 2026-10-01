/**
 * Turns the model's loose output into the stored tour content (FR4/FR5) and derives
 * the stale flag (FR7). The model only PROPOSES: every path is checked against the
 * indexed files, text is clamped to the stored limits (so a stored tour always passes
 * `OnboardingTour.safeParse`), and a section below its minimum is emptied, not failed.
 */
import type { OnboardingStaleReason, OnboardingTour } from '@devdigest/shared';
import { ONBOARDING_LIMITS as L } from '@devdigest/shared';
import { isDangerousCommand } from './command-safety.js';
import { PROMPT_VERSION } from './constants.js';
import { truncateText } from './input.js';
import type { OnboardingLlmOutput } from './prompt.js';

export type TourContent = Pick<
  OnboardingTour,
  'architecture' | 'critical_paths' | 'run_steps' | 'reading_path' | 'first_tasks'
>;

/** Items removed per section (counts only — never repo text; goes to the NFR4 log line). */
export interface DroppedCounts {
  nodes: number;
  edges: number;
  critical_paths: number;
  run_steps: number;
  reading_path: number;
  first_tasks: number;
}

export interface NormalizedTour {
  tour: TourContent;
  dropped: DroppedCounts;
}

/** `./src/a.ts` and `/src/a.ts` → `src/a.ts`; a trailing `/` (folder) is removed. */
export function normalizePath(raw: string): string {
  return raw.trim().replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

interface PathItem {
  path: string;
  reason: string;
}

/** Keep items whose path is a known file (or, when `allowFolders`, a folder with files under it). */
function checkedPaths<T extends { path: string }>(
  items: readonly T[],
  files: ReadonlySet<string>,
  folderPrefixes: ReadonlySet<string>,
  allowFolders: boolean,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const path = normalizePath(item.path);
    if (path.length === 0 || path.length > L.pathMax || seen.has(path)) continue;
    const known = files.has(path) || (allowFolders && folderPrefixes.has(path));
    if (!known) continue;
    seen.add(path);
    out.push({ ...item, path });
  }
  return out;
}

function pathSection(
  items: readonly PathItem[],
  files: ReadonlySet<string>,
  folders: ReadonlySet<string>,
  min: number,
  max: number,
): PathItem[] {
  const valid = checkedPaths(items, files, folders, false)
    .slice(0, max)
    .map((i) => ({ path: i.path, reason: truncateText(i.reason, L.reasonMax) }));
  return valid.length < min ? [] : valid;
}

/** Every ancestor folder of every indexed file (`a/b/c.ts` → `a`, `a/b`). */
function folderSet(files: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const f of files) {
    let i = f.indexOf('/');
    while (i > 0) {
      folders.add(f.slice(0, i));
      i = f.indexOf('/', i + 1);
    }
  }
  return folders;
}

function clampId(id: string): string {
  return id.trim().slice(0, L.nodeIdMax);
}

function architectureOf(raw: OnboardingLlmOutput['architecture']): { arch: TourContent['architecture']; nodes: number; edges: number } {
  const nodes: TourContent['architecture']['nodes'] = [];
  const ids = new Set<string>();
  for (const n of raw.nodes) {
    const id = clampId(n.id);
    const label = truncateText(n.label, L.nodeLabelMax);
    if (id.length === 0 || label.length === 0 || ids.has(id)) continue;
    ids.add(id);
    nodes.push({ id, label, kind: n.kind });
  }
  const kept = nodes.slice(0, L.nodesMax);
  const summary = truncateText(raw.summary, L.summaryMax);
  if (kept.length < L.nodesMin) {
    return { arch: { summary, nodes: [], edges: [] }, nodes: raw.nodes.length, edges: raw.edges.length };
  }
  const known = new Set(kept.map((n) => n.id));
  const edgeKeys = new Set<string>();
  const edges: TourContent['architecture']['edges'] = [];
  for (const e of raw.edges) {
    const from = clampId(e.from);
    const to = clampId(e.to);
    const key = `${from}\u0000${to}`;
    if (!known.has(from) || !known.has(to) || edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ from, to });
  }
  const keptEdges = edges.slice(0, L.edgesMax);
  return {
    arch: { summary, nodes: kept, edges: keptEdges },
    nodes: raw.nodes.length - kept.length,
    edges: raw.edges.length - keptEdges.length,
  };
}

function runStepsOf(raw: OnboardingLlmOutput['run_steps']): TourContent['run_steps'] {
  const steps: TourContent['run_steps'] = [];
  for (const s of raw) {
    const command = s.command.trim();
    if (command.length === 0 || command.length > L.commandMax || isDangerousCommand(command)) continue;
    const comment = s.comment ? truncateText(s.comment, L.commentMax) : '';
    steps.push(comment.length > 0 ? { command, comment } : { command });
  }
  const kept = steps.slice(0, L.runStepsMax);
  return kept.length < L.runStepsMin ? [] : kept;
}

function firstTasksOf(
  raw: OnboardingLlmOutput['first_tasks'],
  files: ReadonlySet<string>,
  folders: ReadonlySet<string>,
): TourContent['first_tasks'] {
  return checkedPaths(raw, files, folders, true)
    .map((t) => ({ title: truncateText(t.title, L.taskTitleMax), path: t.path, complexity: t.complexity }))
    .filter((t) => t.title.length > 0)
    .slice(0, L.firstTasksMax);
}

/**
 * `indexedPaths` = every indexed file of the repo. A critical/reading path must be one
 * of them exactly; a first-task path may also be a folder with indexed files under it.
 */
export function normalizeTour(raw: OnboardingLlmOutput, indexedPaths: Iterable<string>): NormalizedTour {
  const files = new Set(indexedPaths);
  const folders = folderSet(files);
  const arch = architectureOf(raw.architecture);
  const critical = pathSection(raw.critical_paths, files, folders, L.criticalPathsMin, L.criticalPathsMax);
  const reading = pathSection(raw.reading_path, files, folders, L.readingPathMin, L.readingPathMax);
  const runSteps = runStepsOf(raw.run_steps);
  const tasks = firstTasksOf(raw.first_tasks, files, folders);
  return {
    tour: {
      architecture: arch.arch,
      critical_paths: critical,
      run_steps: runSteps,
      reading_path: reading,
      first_tasks: tasks,
    },
    dropped: {
      nodes: arch.nodes,
      edges: arch.edges,
      critical_paths: raw.critical_paths.length - critical.length,
      run_steps: raw.run_steps.length - runSteps.length,
      reading_path: raw.reading_path.length - reading.length,
      first_tasks: raw.first_tasks.length - tasks.length,
    },
  };
}

export type Staleness = { stale: false } | { stale: true; reason: OnboardingStaleReason };

/** FR7: a different indexed commit wins over a changed prompt version. */
export function staleness(
  stored: Pick<OnboardingTour, 'indexed_sha' | 'prompt_version'>,
  currentSha: string | null,
  currentPromptVersion: number = PROMPT_VERSION,
): Staleness {
  if (currentSha !== stored.indexed_sha) return { stale: true, reason: 'index_changed' };
  if (currentPromptVersion !== stored.prompt_version) return { stale: true, reason: 'prompt_changed' };
  return { stale: false };
}
