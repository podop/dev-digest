/**
 * Pure builders for the generation input (FR2, FR4): changed line ranges from hunk
 * headers, the capped file list, the capped findings, the linked issue number and the
 * `missing_inputs` entries. Nothing here reads a file, a database or the network —
 * the application layer passes the facts in. No hunk BODY is ever kept (NFR3).
 */
import type { BlastCaller, BlastRadius, BriefMissingInput, ChangedSymbol, Severity, SmartDiffRole } from '@devdigest/shared';
import { classifyFile } from '../../smart-diff/index.js';
import {
  FINDING_TITLE_MAX_CHARS,
  MAX_CALLERS,
  MAX_FILES,
  MAX_FINDINGS,
  MAX_RANGES_PER_FILE,
} from './constants.js';

/** Inclusive 1-based line range in head numbering. */
export interface LineRange {
  start: number;
  end: number;
}

/** A changed file as stored: counts plus ranges (all of them) taken from its patch. */
export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  ranges: readonly LineRange[];
}

/** A changed file as the prompt lists it (ranges capped). */
export interface PromptFile extends ChangedFile {
  role: SmartDiffRole;
}

/** A current finding of the PR: where it sits and how it is called. */
export interface FindingFact {
  severity: Severity;
  file: string;
  startLine: number;
  endLine: number;
  title: string;
}

/** Cut to `max` characters, ending with an ellipsis when something was removed. */
export function truncateText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

// Same hunk-header shape as adapters/git/diff-parser.ts (an adapter; domain does not import it).
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Changed line ranges in head numbering, from the `@@` headers only (D6/NFR3: no body line
 * is read). A pure-deletion hunk (`+c,0`) has no head line: it becomes `[c, c]`, clamped to ≥ 1.
 */
export function changedRanges(patch: string | null | undefined): LineRange[] {
  if (!patch) return [];
  const out: LineRange[] = [];
  for (const line of patch.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    const start = Math.max(1, Number(m[1]));
    const count = m[2] === undefined ? 1 : Number(m[2]);
    out.push({ start, end: count <= 1 ? start : start + count - 1 });
  }
  return out;
}

export interface SelectedFiles {
  files: PromptFile[];
  /** Files beyond the listed ones — rendered as one "N more files" line. */
  moreFiles: number;
}

/** FR2: the ≤ 100 files with the most changed lines (stable), each with ≤ 20 ranges and its Smart Diff role. */
export function selectFiles(files: readonly ChangedFile[]): SelectedFiles {
  const ranked = files
    .map((f, i) => ({ f, i, lines: f.additions + f.deletions }))
    .sort((a, b) => b.lines - a.lines || a.i - b.i)
    .slice(0, MAX_FILES)
    .map(({ f }) => ({ ...f, role: classifyFile(f.path), ranges: f.ranges.slice(0, MAX_RANGES_PER_FILE) }));
  return { files: ranked, moreFiles: Math.max(0, files.length - ranked.length) };
}

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 0, WARNING: 1, SUGGESTION: 2 };

/** FR2: ≤ 30 findings, CRITICAL first (stable within a severity), titles cut to 120 chars. */
export function selectFindings(findings: readonly FindingFact[]): FindingFact[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .slice(0, MAX_FINDINGS)
    .map(({ f }) => ({ ...f, title: truncateText(f.title, FINDING_TITLE_MAX_CHARS) }));
}

/** A blast radius that is degraded is "unknown", not data: the brief treats it as missing (FR4). */
export function usableBlast(blast: BlastRadius | null): BlastRadius | null {
  return blast === null || blast.degraded === true ? null : blast;
}

/** What the prompt carries of the blast radius: summary, symbols (uncapped) and ≤ 30 distinct callers. */
export interface PromptBlast {
  summary: string;
  changedSymbols: ChangedSymbol[];
  callers: BlastCaller[];
}

export function promptBlast(blast: BlastRadius): PromptBlast {
  const seen = new Set<string>();
  const callers: BlastCaller[] = [];
  for (const d of blast.downstream) {
    for (const c of d.callers) {
      const key = `${c.file}:${c.line}:${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callers.push(c);
    }
  }
  return { summary: blast.summary, changedSymbols: blast.changed_symbols, callers: callers.slice(0, MAX_CALLERS) };
}

// Same rule the GitHub adapter uses for `linked_issue` (adapters/github/octokit.ts): first `#N`.
const ISSUE_REF_RE = /#(\d+)/;

/** The first `#N` of the PR description, or null. */
export function linkedIssueNumber(body: string | null | undefined): number | null {
  if (!body) return null;
  const m = ISSUE_REF_RE.exec(body);
  const n = m?.[1] ? Number(m[1]) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** How the linked issue turned out: no `#N`, fetched, or the fetch failed / timed out. */
export type IssueOutcome = 'not_linked' | 'fetched' | 'fetch_failed';

/** Outcome of the spec-document step, counted after the budget trim. */
export interface SpecsOutcome {
  /** Agents with a current review of the PR. */
  reviewedAgents: number;
  /** Distinct documents attached to them (agent + skill paths, de-duplicated). */
  attachedDocs: number;
  /** Documents that could not be read (status missing, too_large or unreadable). */
  unreadable: number;
  /** Documents dropped by the run-context budget or the brief's token budget. */
  overBudget: number;
}

export interface MissingInputFacts {
  description: string | null | undefined;
  /** A stored intent exists. */
  hasIntent: boolean;
  /** The blast read: null when the read failed, else the raw blast (degraded or not). */
  blast: BlastRadius | null;
  specs: SpecsOutcome;
  issue: IssueOutcome;
}

/** FR4: every absent or dropped input with its reason; empty when the brief had everything. */
export function buildMissingInputs(f: MissingInputFacts): BriefMissingInput[] {
  const out: BriefMissingInput[] = [];
  if (!f.description || f.description.trim().length === 0) out.push({ input: 'description', reason: 'empty' });
  if (!f.hasIntent) out.push({ input: 'intent', reason: 'not_derived' });
  if (f.blast === null) out.push({ input: 'blast', reason: 'degraded' });
  else if (f.blast.degraded === true) {
    out.push(f.blast.reason ? { input: 'blast', reason: 'degraded', detail: f.blast.reason } : { input: 'blast', reason: 'degraded' });
  }
  const s = f.specs;
  if (s.reviewedAgents === 0) out.push({ input: 'specs', reason: 'no_review_run' });
  else if (s.attachedDocs === 0) out.push({ input: 'specs', reason: 'none_attached' });
  else {
    if (s.overBudget > 0) out.push({ input: 'specs', reason: 'over_budget', detail: `${s.overBudget} of ${s.attachedDocs}` });
    if (s.unreadable > 0) out.push({ input: 'specs', reason: 'unreadable', detail: `${s.unreadable} of ${s.attachedDocs}` });
  }
  if (f.issue === 'not_linked') out.push({ input: 'linked_issue', reason: 'not_linked' });
  else if (f.issue === 'fetch_failed') out.push({ input: 'linked_issue', reason: 'fetch_failed' });
  return out;
}
