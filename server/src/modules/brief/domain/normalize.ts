/**
 * Turns the model's loose output into the stored brief content (FR5-FR7) and derives
 * the stale flag (FR9). The model only PROPOSES: every file is checked against the PR's
 * changed files and the blast data, every line is re-grounded, text is clamped to the
 * stored limits (so a stored brief always passes `PrBrief.safeParse`), and nothing is re-asked.
 */
import type { BlastRadius, PrBrief, ReviewFocusItem, Risk } from '@devdigest/shared';
import {
  FOCUS_MAX,
  FOCUS_REASON_MAX,
  PROMPT_VERSION,
  RISK_EXPLANATION_MAX,
  RISK_KIND_MAX,
  RISK_TITLE_MAX,
  RISKS_MAX,
  SUMMARY_MAX,
} from './constants.js';
import { truncateText, type ChangedFile, type FindingFact } from './input.js';
import type { BriefLlmOutput } from './prompt.js';

/** What the model's file/line claims are checked against. */
export interface GroundingFacts {
  /** ALL changed files of the PR with their ranges (not only the listed ones). */
  files: readonly Pick<ChangedFile, 'path' | 'ranges'>[];
  /** ALL current findings. */
  findings: readonly Pick<FindingFact, 'file' | 'startLine' | 'endLine'>[];
  /** Usable blast radius (null when degraded or missing). */
  blast: BlastRadius | null;
}

/** Items removed (counts only — never PR text; goes to the NFR5 generation log line). */
export interface DroppedCounts {
  risks: number;
  review_focus: number;
  /** Individual risk file refs removed (unknown path), including those of dropped risks. */
  risk_refs: number;
}

export interface NormalizedBrief {
  summary: string;
  risks: Risk[];
  review_focus: ReviewFocusItem[];
  dropped: DroppedCounts;
}

/** `./src/a.ts` and `/src/a.ts` → `src/a.ts`. */
export function normalizePath(raw: string): string {
  return raw.trim().replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

interface FileGrounding {
  inPr: boolean;
  ranges: readonly { start: number; end: number }[];
  findings: readonly { start: number; end: number }[];
  callerLines: readonly number[];
}

function groundingIndex(facts: GroundingFacts): Map<string, FileGrounding> {
  const index = new Map<string, { inPr: boolean; ranges: { start: number; end: number }[]; findings: { start: number; end: number }[]; callerLines: number[] }>();
  const entry = (path: string) => {
    let e = index.get(path);
    if (!e) {
      e = { inPr: false, ranges: [], findings: [], callerLines: [] };
      index.set(path, e);
    }
    return e;
  };
  for (const f of facts.files) {
    const e = entry(normalizePath(f.path));
    e.inPr = true;
    e.ranges.push(...f.ranges);
  }
  for (const f of facts.findings) {
    const e = index.get(normalizePath(f.file));
    // A finding on a file outside the PR's files and the blast data does not make that file known.
    if (e) e.findings.push({ start: f.startLine, end: f.endLine });
  }
  if (facts.blast) {
    for (const s of facts.blast.changed_symbols) entry(normalizePath(s.file));
    for (const d of facts.blast.downstream) {
      for (const c of d.callers) entry(normalizePath(c.file)).callerLines.push(c.line);
    }
  }
  return index;
}

function isGrounded(g: FileGrounding, line: number): boolean {
  return (
    g.ranges.some((r) => line >= r.start && line <= r.end) ||
    g.findings.some((r) => line >= r.start && line <= r.end) ||
    g.callerLines.includes(line)
  );
}

/** FR7: keep a grounded line; else the first changed line (PR file) / first caller line (blast-only file); else a positive line or 1. */
function groundLine(g: FileGrounding, requested: number | null): { line: number; kept: boolean } {
  const wanted = requested !== null && requested >= 1 ? requested : null;
  if (wanted !== null && isGrounded(g, wanted)) return { line: wanted, kept: true };
  const fallback = g.inPr
    ? g.ranges.length > 0
      ? Math.min(...g.ranges.map((r) => r.start))
      : null
    : g.callerLines.length > 0
      ? Math.min(...g.callerLines)
      : null;
  if (fallback !== null) return { line: fallback, kept: false };
  return { line: wanted ?? 1, kept: wanted !== null };
}

function toLine(n: number): number | null {
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const REF_RE = /^(.*?):(\d+)(?:-(\d+))?$/;

/** `path`, `path:12` or `path:12-20` → parts; a missing line is null. */
function parseRef(raw: string): { path: string; start: number | null; end: number | null } {
  const m = REF_RE.exec(raw.trim());
  if (!m) return { path: normalizePath(raw), start: null, end: null };
  return { path: normalizePath(m[1] ?? ''), start: Number(m[2]), end: m[3] === undefined ? null : Number(m[3]) };
}

function refsOf(
  raw: readonly string[],
  index: ReadonlyMap<string, FileGrounding>,
): { refs: string[]; removed: number } {
  const refs: string[] = [];
  let removed = 0;
  for (const r of raw) {
    const p = parseRef(r);
    const g = p.path.length > 0 ? index.get(p.path) : undefined;
    if (!g) {
      removed++;
      continue;
    }
    const { line, kept } = groundLine(g, p.start);
    const ref = kept && p.end !== null && p.end > line ? `${p.path}:${line}-${p.end}` : `${p.path}:${line}`;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return { refs, removed };
}

/**
 * `facts` describe the PR; the result is clamped, grounded and limited. Items are validated
 * first and the limits applied afterwards, so a valid item is never lost to an invalid one.
 */
export function normalizeBrief(raw: BriefLlmOutput, facts: GroundingFacts): NormalizedBrief {
  const index = groundingIndex(facts);

  let removedRefs = 0;
  const validRisks: Risk[] = [];
  for (const r of raw.risks) {
    const { refs, removed } = refsOf(r.file_refs, index);
    removedRefs += removed;
    const title = truncateText(r.title, RISK_TITLE_MAX);
    if (refs.length === 0 || title.length === 0) continue;
    validRisks.push({
      kind: truncateText(r.kind, RISK_KIND_MAX) || 'other',
      title,
      explanation: truncateText(r.explanation, RISK_EXPLANATION_MAX),
      severity: r.severity,
      file_refs: refs,
    });
  }
  const risks = validRisks.slice(0, RISKS_MAX);

  const seen = new Set<string>();
  const validFocus: ReviewFocusItem[] = [];
  for (const f of raw.review_focus) {
    const path = normalizePath(f.file);
    const g = index.get(path);
    const reason = truncateText(f.reason, FOCUS_REASON_MAX);
    if (!g || reason.length === 0) continue;
    const { line } = groundLine(g, toLine(f.line));
    const key = `${path}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    validFocus.push({ file: path, line, reason });
  }
  const focus = validFocus.slice(0, FOCUS_MAX);

  return {
    summary: truncateText(raw.summary, SUMMARY_MAX),
    risks,
    review_focus: focus,
    dropped: {
      risks: raw.risks.length - risks.length,
      review_focus: raw.review_focus.length - focus.length,
      risk_refs: removedRefs,
    },
  };
}

/** FR9: stale when the PR's stored head SHA moved or the prompt version changed. */
export function isStale(
  stored: Pick<PrBrief, 'head_sha' | 'prompt_version'>,
  currentHeadSha: string,
  currentPromptVersion: string = PROMPT_VERSION,
): boolean {
  return stored.head_sha !== currentHeadSha || stored.prompt_version !== currentPromptVersion;
}
