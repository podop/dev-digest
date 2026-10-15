/**
 * Turning a decided finding into an eval case (FR1, FR2): the pure part — validation of
 * the finding's state, the single-file unified diff, the snapshot. No I/O.
 */
import {
  EVAL_CASE_NAME_MAX,
  EVAL_INPUT_DIFF_MAX_CHARS,
  type EvalExpectation,
} from '@devdigest/shared';
import { InvalidInputError, ValidationError } from '../../../platform/errors.js';
import type { FindingSource, NewEvalCase } from './types.js';

/**
 * The finding file's stored patch as a valid single-file unified diff. Same header as
 * `pull.repo.ts storedDiff` so the engine's parser sees `a/<path>` / `b/<path>`.
 */
export function buildSingleFileDiff(path: string, patch: string): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, patch].join('\n');
}

/** Default case name: the finding title (1–120 chars); the location when the title is blank. */
export function caseName(title: string, file: string, startLine: number): string {
  const trimmed = title.trim();
  const name = trimmed === '' ? `${file}:${startLine}` : trimmed;
  return name.slice(0, EVAL_CASE_NAME_MAX);
}

/**
 * Validate the finding (decided, has an agent, has a usable patch) and build the case
 * snapshot. Throws `ValidationError` (422) with the code the client branches on.
 */
export function buildEvalCase(workspaceId: string, src: FindingSource): NewEvalCase {
  if (src.decision === null) {
    throw new ValidationError('Accept or dismiss the finding first', undefined, 'finding_undecided');
  }
  if (src.agentId === null) {
    throw new ValidationError('The review of this finding has no agent', undefined, 'finding_no_agent');
  }
  if (src.patch === null || src.patch.trim() === '') {
    throw new ValidationError('The PR has no stored patch for this file', undefined, 'patch_unavailable');
  }
  if (src.patch.length > EVAL_INPUT_DIFF_MAX_CHARS) {
    throw new ValidationError(
      `The patch exceeds ${EVAL_INPUT_DIFF_MAX_CHARS} characters`,
      undefined,
      'patch_too_large',
    );
  }
  const expectation: EvalExpectation = {
    kind: src.decision === 'accepted' ? 'must_find' : 'must_not_flag',
    file: src.file,
    start_line: src.startLine,
    end_line: Math.max(src.endLine, src.startLine),
    severity: src.severity,
    category: src.category,
    title: src.title,
  };
  return {
    workspaceId,
    ownerKind: 'agent',
    ownerId: src.agentId,
    name: caseName(src.title, src.file, src.startLine),
    notes: null,
    expectation,
    inputDiff: buildSingleFileDiff(src.file, src.patch),
    inputMeta: {
      pr_title: src.prTitle,
      pr_description: src.prBody,
      repo: src.repoFullName,
      pr_number: src.prNumber,
      head_sha: src.headSha,
    },
    sourceFindingId: src.findingId,
    sourceReviewId: src.reviewId,
    sourcePrId: src.prId,
  };
}

/**
 * Apply a PATCH of the lines to the stored expectation (EC16): `end_line >= start_line`
 * is checked against the merged values, so changing only one bound is validated too.
 */
export function editExpectationLines(
  stored: EvalExpectation,
  edit: { start_line?: number | undefined; end_line?: number | undefined },
): EvalExpectation {
  const start_line = edit.start_line ?? stored.start_line;
  const end_line = edit.end_line ?? stored.end_line;
  if (end_line < start_line) {
    throw new InvalidInputError('end_line must be >= start_line', undefined, 'validation_error');
  }
  return { ...stored, start_line, end_line };
}
