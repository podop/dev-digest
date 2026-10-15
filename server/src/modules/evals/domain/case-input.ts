/**
 * Content of hand-written eval cases (FR2–FR4, FR6, FR15): diff normalisation, the
 * deterministic checks that keep a case passable, the manual case snapshot and the merge
 * of an edit. Pure — the diff parser is injected, nothing here touches I/O or an LLM.
 */
import {
  EVAL_DIFF_FILES_DETAIL_MAX,
  EVAL_INPUT_DIFF_MAX_CHARS,
  type AgentEvalCaseUpdateInput,
  type EvalCaseCreateInput,
  type EvalCaseInputMeta,
  type EvalExpectation,
  type UnifiedDiff,
} from '@devdigest/shared';
import { ValidationError } from '../../../platform/errors.js';
import { buildSingleFileDiff, editExpectationLines } from './case-builder.js';
import type { CaseOwner, EvalCaseWrite, NewEvalCase, StoredCase } from './types.js';

/** Raw unified diff text → the parsed diff (injected: the parser is an adapter). */
type ParseDiff = (raw: string) => UnifiedDiff;

/** A contiguous run of new-side line numbers of one file. */
export interface LineRange {
  start: number;
  end: number;
}

const HAS_FILE_HEADER = /^(diff --git|\+\+\+ )/m;

/**
 * FR2: CRLF → LF, and a paste with no file header (`diff --git` / `+++ `) becomes a
 * single-file diff for `file`; a diff with headers is stored as given.
 */
export function normalizeCaseDiff(raw: string, file: string): string {
  const text = raw.replace(/\r\n/g, '\n');
  return HAS_FILE_HEADER.test(text) ? text : buildSingleFileDiff(file, text);
}

/** New-side lines of one file as sorted, merged runs (adjacent lines join one run). */
function newSideRanges(diff: UnifiedDiff, file: string): LineRange[] {
  const lines = diff.files
    .filter((f) => f.path === file)
    .flatMap((f) => f.hunks.flatMap((h) => h.newLineNumbers));
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.end + 1) last.end = n;
    else ranges.push({ start: n, end: n });
  }
  return ranges;
}

/**
 * FR3 in order: stored length, a file with a hunk, the expectation file among the diff's
 * files (exact path match), the lines intersecting a new-side line of that file. Throws
 * `ValidationError` (422) with the code the client branches on; `details` carries the
 * paths / ranges the author can pick from (capped).
 */
export function checkCaseContent(
  diff: string,
  expectation: Pick<EvalExpectation, 'file' | 'start_line' | 'end_line'>,
  parse: ParseDiff,
): void {
  if (diff.length > EVAL_INPUT_DIFF_MAX_CHARS) {
    throw new ValidationError(
      `The diff exceeds ${EVAL_INPUT_DIFF_MAX_CHARS} characters`,
      undefined,
      'patch_too_large',
    );
  }
  const parsed = parse(diff);
  if (!parsed.files.some((f) => f.hunks.length > 0)) {
    throw new ValidationError('The diff has no file with a hunk (@@ header)', undefined, 'diff_invalid');
  }
  const paths = [...new Set(parsed.files.map((f) => f.path))];
  if (!paths.includes(expectation.file)) {
    throw new ValidationError(
      'The expectation file is not among the diff files',
      { files: paths.slice(0, EVAL_DIFF_FILES_DETAIL_MAX) },
      'expectation_file_not_in_diff',
    );
  }
  const ranges = newSideRanges(parsed, expectation.file);
  if (!ranges.some((r) => r.start <= expectation.end_line && expectation.start_line <= r.end)) {
    throw new ValidationError(
      'The expectation lines do not intersect a changed or context line of the file',
      { ranges: ranges.slice(0, EVAL_DIFF_FILES_DETAIL_MAX) },
      'expectation_lines_not_in_diff',
    );
  }
}

/** FR4: a blank or missing PR title is stored as the case name. */
function titleOrName(prTitle: string | null | undefined, name: string): string {
  return prTitle === undefined || prTitle === null || prTitle.trim() === '' ? name : prTitle;
}

/** A blank description is stored as null (no PR description block reaches the engine). */
function descriptionOrNull(text: string | null | undefined): string | null {
  return text === undefined || text === null || text.trim() === '' ? null : text;
}

/**
 * FR1, FR4: the snapshot of a from-scratch case. `diff` is already normalised and
 * checked; repo, PR number and head commit are null, there is no source finding/review/PR.
 */
export function buildManualCase(
  workspaceId: string,
  owner: CaseOwner,
  input: EvalCaseCreateInput,
  diff: string,
): NewEvalCase {
  const e = input.expectation;
  return {
    workspaceId,
    ownerKind: owner.kind,
    ownerId: owner.id,
    name: input.name,
    notes: input.notes ?? null,
    expectation: {
      kind: e.kind,
      file: e.file,
      start_line: e.start_line,
      end_line: e.end_line,
      severity: e.severity ?? null,
      category: e.category ?? null,
      title: e.title ?? null,
    },
    inputDiff: diff,
    inputMeta: {
      pr_title: titleOrName(input.input_meta?.pr_title, input.name),
      pr_description: descriptionOrNull(input.input_meta?.pr_description),
      repo: null,
      pr_number: null,
      head_sha: null,
    },
    sourceFindingId: null,
    sourceReviewId: null,
    sourcePrId: null,
  };
}

export interface CaseEditMerge {
  /** Only the fields the edit writes. */
  values: EvalCaseWrite;
  /** The edit carries diff, file or lines: the merged content must pass `checkCaseContent`. */
  recheck: boolean;
  /** Some content value (not name / notes) really differs from the stored one (FR15). */
  contentChanged: boolean;
}

/**
 * FR6: merge a PATCH into the stored case. Absent = keep; `null` clears severity / category
 * / title / description. Merged `end_line < start_line` is a 400 (EC16); a blank `pr_title`
 * becomes the (merged) name; a new diff is normalised against the merged file.
 */
export function mergeCaseEdit(stored: StoredCase, patch: AgentEvalCaseUpdateInput): CaseEditMerge {
  const linesEdited = patch.start_line !== undefined || patch.end_line !== undefined;
  const expectationEdited =
    linesEdited ||
    patch.kind !== undefined ||
    patch.file !== undefined ||
    patch.severity !== undefined ||
    patch.category !== undefined ||
    patch.title !== undefined;

  const lines = linesEdited ? editExpectationLines(stored.expectation, patch) : stored.expectation;
  const expectation: EvalExpectation = {
    kind: patch.kind ?? stored.expectation.kind,
    file: patch.file ?? stored.expectation.file,
    start_line: lines.start_line,
    end_line: lines.end_line,
    severity: patch.severity === undefined ? stored.expectation.severity : patch.severity,
    category: patch.category === undefined ? stored.expectation.category : patch.category,
    title: patch.title === undefined ? stored.expectation.title : patch.title,
  };

  const name = patch.name ?? stored.name;
  const inputDiff = patch.input_diff === undefined ? stored.inputDiff : normalizeCaseDiff(patch.input_diff, expectation.file);
  const metaEdited = patch.pr_title !== undefined || patch.pr_description !== undefined;
  const inputMeta: EvalCaseInputMeta = {
    ...stored.inputMeta,
    pr_title: patch.pr_title === undefined ? stored.inputMeta.pr_title : titleOrName(patch.pr_title, name),
    pr_description:
      patch.pr_description === undefined ? stored.inputMeta.pr_description : descriptionOrNull(patch.pr_description),
  };

  const s = stored.expectation;
  const contentChanged =
    expectation.kind !== s.kind ||
    expectation.file !== s.file ||
    expectation.start_line !== s.start_line ||
    expectation.end_line !== s.end_line ||
    expectation.severity !== s.severity ||
    expectation.category !== s.category ||
    expectation.title !== s.title ||
    inputDiff !== stored.inputDiff ||
    inputMeta.pr_title !== stored.inputMeta.pr_title ||
    inputMeta.pr_description !== stored.inputMeta.pr_description;

  return {
    values: {
      ...(patch.name !== undefined ? { name } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(expectationEdited ? { expectation } : {}),
      ...(patch.input_diff !== undefined ? { inputDiff } : {}),
      ...(metaEdited ? { inputMeta } : {}),
      ...(contentChanged ? { markContentEdited: true } : {}),
    },
    recheck: patch.input_diff !== undefined || patch.file !== undefined || linesEdited,
    contentChanged,
  };
}
