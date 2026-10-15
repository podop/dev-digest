import { describe, it, expect } from 'vitest';
import type { AgentEvalCaseUpdateInput, EvalCaseCreateInput, EvalExpectation } from '@devdigest/shared';
import { EVAL_DIFF_FILES_DETAIL_MAX, EVAL_INPUT_DIFF_MAX_CHARS } from '@devdigest/shared';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';
import { ValidationError } from '../src/platform/errors.js';
import {
  buildManualCase,
  checkCaseContent,
  mergeCaseEdit,
  normalizeCaseDiff,
  } from '../src/modules/evals/domain/case-input.js';
import type { StoredCase } from '../src/modules/evals/domain/types.js';

/** Hunk with new-side lines 10 (context), 11 (+), 12 (context), the deleted line takes none. */
const HUNK = '@@ -10,3 +10,3 @@\n   port: 3000,\n-  old: 1,\n+  stripeKey: "sk",\n   redisUrl: x,';
const headed = (path: string, hunk = HUNK) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}`;

const code = (fn: () => void): { code: string; details: unknown } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return { code: e.code, details: e.details };
    throw e;
  }
  throw new Error('did not throw');
};
const check = (diff: string, file: string, start: number, end: number) =>
  checkCaseContent(diff, { file, start_line: start, end_line: end }, parseUnifiedDiff);

describe('normalizeCaseDiff (FR2, EC1, EC12)', () => {
  it('wraps header-less hunks into a single-file diff that parses to the typed file (EC1)', () => {
    const out = normalizeCaseDiff(HUNK, 'src/a.ts');
    const parsed = parseUnifiedDiff(out);
    expect(parsed.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(parsed.files[0]?.hunks[0]?.newLineNumbers).toEqual([10, 11, 12]);
  });

  it('stores a diff with headers as given, any number of files (EC2)', () => {
    const two = `${headed('src/a.ts')}\n${headed('src/b.ts')}`;
    expect(normalizeCaseDiff(two, 'src/b.ts')).toBe(two);
    expect(parseUnifiedDiff(two).files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('a `+++ ` line alone counts as a header; a diff --git line alone too', () => {
    const plus = `--- a/x.ts\n+++ b/x.ts\n${HUNK}`;
    expect(normalizeCaseDiff(plus, 'other.ts')).toBe(plus);
    const git = `diff --git a/x.ts b/x.ts\n${HUNK}`;
    expect(normalizeCaseDiff(git, 'other.ts')).toBe(git);
  });

  it('CRLF becomes LF without moving line numbers (EC12)', () => {
    const crlf = headed('src/a.ts').replace(/\n/g, '\r\n');
    const out = normalizeCaseDiff(crlf, 'src/a.ts');
    expect(out).not.toContain('\r');
    expect(parseUnifiedDiff(out).files[0]?.hunks[0]?.newLineNumbers).toEqual([10, 11, 12]);
  });
});

describe('checkCaseContent (FR3)', () => {
  it('accepts lines on a changed and on a context line, and a range that only overlaps', () => {
    const d = headed('src/a.ts');
    expect(() => check(d, 'src/a.ts', 11, 11)).not.toThrow();
    expect(() => check(d, 'src/a.ts', 10, 10)).not.toThrow();
    expect(() => check(d, 'src/a.ts', 12, 40)).not.toThrow();
    expect(() => check(d, 'src/a.ts', 1, 10)).not.toThrow();
  });

  it('EC6: hunk header counts that do not match the lines present are accepted', () => {
    const lying = headed('src/a.ts', '@@ -1,99 +10,99 @@\n ctx\n+added');
    expect(() => check(lying, 'src/a.ts', 11, 11)).not.toThrow();
  });

  it('patch_too_large is checked first, on the stored length', () => {
    const big = headed('src/a.ts', `@@ -1,1 +1,1 @@\n+${'x'.repeat(EVAL_INPUT_DIFF_MAX_CHARS)}`);
    expect(code(() => check(big, 'nowhere.ts', 1, 1)).code).toBe('patch_too_large');
    const exact = 'x'.repeat(EVAL_INPUT_DIFF_MAX_CHARS - headed('src/a.ts', '@@ -1,1 +1,1 @@\n+').length);
    const atLimit = headed('src/a.ts', `@@ -1,1 +1,1 @@\n+${exact}`);
    expect(atLimit.length).toBe(EVAL_INPUT_DIFF_MAX_CHARS);
    expect(() => check(atLimit, 'src/a.ts', 1, 1)).not.toThrow();
  });

  it('EC3: text without @@ and a deleted-file diff are diff_invalid', () => {
    expect(code(() => check('const a = 1;\nconst b = 2;', 'src/a.ts', 1, 1)).code).toBe('diff_invalid');
    const deleted = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b';
    expect(code(() => check(deleted, 'x.ts', 1, 1)).code).toBe('diff_invalid');
    expect(code(() => check('', 'x.ts', 1, 1)).code).toBe('diff_invalid');
  });

  it('EC5: the file must match a diff path exactly; details.files lists the paths (capped)', () => {
    const d = headed('src/a.ts');
    for (const file of ['b/src/a.ts', 'SRC/A.ts', 'a.ts']) {
      const err = code(() => check(d, file, 11, 11));
      expect(err.code).toBe('expectation_file_not_in_diff');
      expect(err.details).toEqual({ files: ['src/a.ts'] });
    }
    const many = Array.from({ length: EVAL_DIFF_FILES_DETAIL_MAX + 5 }, (_, i) => headed(`f${i}.ts`)).join('\n');
    const files = (code(() => check(many, 'none.ts', 11, 11)).details as { files: string[] }).files;
    expect(files).toHaveLength(EVAL_DIFF_FILES_DETAIL_MAX);
    expect(files[0]).toBe('f0.ts');
  });

  it('EC4: a range on deleted lines only or beyond the hunks lists the file ranges', () => {
    const d = headed('src/a.ts', '@@ -1,3 +1,1 @@\n ctx\n-gone1\n-gone2');
    const onDeleted = code(() => check(d, 'src/a.ts', 2, 3));
    expect(onDeleted.code).toBe('expectation_lines_not_in_diff');
    expect(onDeleted.details).toEqual({ ranges: [{ start: 1, end: 1 }] });
    const beyond = code(() => check(headed('src/a.ts'), 'src/a.ts', 13, 20));
    expect(beyond.details).toEqual({ ranges: [{ start: 10, end: 12 }] });
  });

  it('ranges are the file\'s contiguous new-side runs across hunks, not another file\'s', () => {
    const two = headed('src/a.ts', `${HUNK}\n@@ -30,1 +31,2 @@\n ctx\n+add`) + '\n' + headed('src/b.ts', '@@ -1,1 +100,1 @@\n+z');
    const err = code(() => check(two, 'src/a.ts', 20, 25));
    expect(err.details).toEqual({
      ranges: [
        { start: 10, end: 12 },
        { start: 31, end: 32 },
      ],
    });
    expect(() => check(two, 'src/b.ts', 100, 100)).not.toThrow();
  });
});

const createInput = (over: Partial<EvalCaseCreateInput> = {}): EvalCaseCreateInput => ({
  name: 'Hardcoded key',
  expectation: { kind: 'must_find', file: 'src/a.ts', start_line: 11, end_line: 11 },
  input_diff: HUNK,
  ...over,
});

describe('buildManualCase (FR1, FR4)', () => {
  it('has no source ids and null repo / PR number / head commit; PR title defaults to the name', () => {
    const c = buildManualCase('w1', { kind: 'skill', id: 's1' }, createInput({ notes: 'n' }), 'DIFF');
    expect(c).toMatchObject({
      workspaceId: 'w1',
      ownerKind: 'skill',
      ownerId: 's1',
      notes: 'n',
      inputDiff: 'DIFF',
      sourceFindingId: null,
      sourceReviewId: null,
      sourcePrId: null,
    });
    expect(c.inputMeta).toEqual({
      pr_title: 'Hardcoded key',
      pr_description: null,
      repo: null,
      pr_number: null,
      head_sha: null,
    });
    expect(c.expectation).toEqual({
      kind: 'must_find',
      file: 'src/a.ts',
      start_line: 11,
      end_line: 11,
      severity: null,
      category: null,
      title: null,
    });
  });

  it('keeps a given PR title / description, blank ones fall back', () => {
    const given = buildManualCase(
      'w',
      { kind: 'agent', id: 'a' },
      createInput({ input_meta: { pr_title: 'Add rl', pr_description: 'body' } }),
      'D',
    );
    expect(given.inputMeta).toMatchObject({ pr_title: 'Add rl', pr_description: 'body' });
    const blank = buildManualCase(
      'w',
      { kind: 'agent', id: 'a' },
      createInput({ input_meta: { pr_title: '  ', pr_description: '  ' } }),
      'D',
    );
    expect(blank.inputMeta).toMatchObject({ pr_title: 'Hardcoded key', pr_description: null });
  });
});

describe('mergeCaseEdit (FR6, FR15)', () => {
  const expectation: EvalExpectation = {
    kind: 'must_find',
    file: 'src/a.ts',
    start_line: 11,
    end_line: 12,
    severity: 'CRITICAL',
    category: 'security',
    title: 'Hardcoded key',
  };
  const stored: StoredCase = {
    name: 'Case',
    expectation,
    inputDiff: headed('src/a.ts'),
    inputMeta: { pr_title: 'Case', pr_description: 'old', repo: 'acme/api', pr_number: 7, head_sha: 'abc' },
  };
  const merge = (patch: AgentEvalCaseUpdateInput) => mergeCaseEdit(stored, patch);

  it('name / notes only: not content, no recheck, nothing else written', () => {
    const m = merge({ name: 'New', notes: null });
    expect(m).toEqual({ values: { name: 'New', notes: null }, recheck: false, contentChanged: false });
  });

  it('an edit that repeats stored values is not a content change', () => {
    const m = merge({ kind: 'must_find', start_line: 11, title: 'Hardcoded key', pr_title: 'Case', input_diff: stored.inputDiff });
    expect(m.contentChanged).toBe(false);
    expect(m.values.markContentEdited).toBeUndefined();
    expect(m.recheck).toBe(true);
  });

  it.each<[string, AgentEvalCaseUpdateInput]>([
    ['kind', { kind: 'must_not_flag' }],
    ['file', { file: 'src/b.ts' }],
    ['start_line', { start_line: 10 }],
    ['end_line', { end_line: 13 }],
    ['severity', { severity: 'WARNING' }],
    ['severity cleared', { severity: null }],
    ['category', { category: 'bug' }],
    ['title', { title: 'Other' }],
    ['title cleared', { title: null }],
    ['input_diff', { input_diff: headed('src/a.ts', '@@ -1,1 +11,1 @@\n+x') }],
    ['pr_title', { pr_title: 'Other' }],
    ['pr_description', { pr_description: 'new' }],
    ['pr_description cleared', { pr_description: null }],
  ])('%s is a content change', (_label, patch) => {
    const m = merge(patch);
    expect(m.contentChanged).toBe(true);
    expect(m.values.markContentEdited).toBe(true);
  });

  it('recheck only when the edit carries diff, file or lines', () => {
    expect(merge({ kind: 'must_not_flag' }).recheck).toBe(false);
    expect(merge({ severity: null, title: 'x', pr_title: 'y' }).recheck).toBe(false);
    expect(merge({ file: 'src/a.ts' }).recheck).toBe(true);
    expect(merge({ end_line: 12 }).recheck).toBe(true);
    expect(merge({ input_diff: 'x' }).recheck).toBe(true);
  });

  it('merged end < start is a 400 validation_error, from either bound', () => {
    expect(() => merge({ end_line: 10 })).toThrow(/end_line/);
    expect(() => merge({ start_line: 13 })).toThrow(/end_line/);
    expect(() => merge({ start_line: 13, end_line: 14 })).not.toThrow();
  });

  it('writes the merged expectation, keeping untouched fields', () => {
    const m = merge({ kind: 'must_not_flag', severity: null });
    expect(m.values.expectation).toEqual({ ...expectation, kind: 'must_not_flag', severity: null });
  });

  it('a new header-less diff is wrapped for the merged file; CRLF is normalised', () => {
    const m = merge({ input_diff: HUNK.replace(/\n/g, '\r\n'), file: 'src/z.ts', start_line: 11, end_line: 11 });
    expect(m.values.inputDiff).toBe(normalizeCaseDiff(HUNK, 'src/z.ts'));
    expect(m.values.inputDiff).toContain('+++ b/src/z.ts');
  });

  it('a blank pr_title becomes the merged name; a blank description becomes null', () => {
    const m = merge({ name: 'Renamed', pr_title: '', pr_description: ' ' });
    expect(m.values.inputMeta).toMatchObject({ pr_title: 'Renamed', pr_description: null, repo: 'acme/api', pr_number: 7 });
    expect(merge({ pr_title: null }).values.inputMeta?.pr_title).toBe('Case');
  });

  it('a finding-derived meta keeps repo / PR number on a PR-meta edit', () => {
    expect(merge({ pr_title: 'T' }).values.inputMeta).toEqual({ ...stored.inputMeta, pr_title: 'T' });
  });
});
