import { describe, it, expect } from 'vitest';
import type { EvalExpectation, EvalRunSummary } from '@devdigest/shared';
import { EVAL_INPUT_DIFF_MAX_CHARS } from '@devdigest/shared';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';
import { aggregateRun, metricDelta, rangesIntersect, runVerdict, scoreCase } from '../src/modules/evals/domain/scoring.js';
import { buildEvalCase, buildSingleFileDiff, caseName, editExpectationLines } from '../src/modules/evals/domain/case-builder.js';
import { assertComparable, compareRuns, lineDiff } from '../src/modules/evals/domain/compare.js';
import { regressionAlert, sparklineOf, trendOf } from '../src/modules/evals/domain/dashboard.js';
import type { CaseOutcome, EvalRunConfig, FindingSource, KeptFinding } from '../src/modules/evals/domain/types.js';

const exp = (kind: EvalExpectation['kind'], start = 10, end = 12, file = 'src/a.ts'): EvalExpectation => ({
  kind,
  file,
  start_line: start,
  end_line: end,
  severity: 'CRITICAL',
  category: 'security',
  title: 't',
});
const kept = (start: number, end = start, file = 'src/a.ts'): KeptFinding => ({
  file,
  start_line: start,
  end_line: end,
  severity: 'WARNING',
  category: 'bug',
  title: 'f',
});

/** AC12: 2 hits, 2 violations, 2 unlabeled, 1 dropped of 7. */
function ac12Outcomes(): CaseOutcome[] {
  const specs: Array<{ e: EvalExpectation; findings: KeptFinding[]; dropped: number }> = [
    { e: exp('must_find'), findings: [kept(10), kept(11, 12)], dropped: 0 }, // hit x2 -> passed
    { e: exp('must_find', 50, 52), findings: [kept(90)], dropped: 1 }, // miss + 1 unlabeled -> failed
    { e: exp('must_not_flag', 20, 22), findings: [kept(20), kept(21)], dropped: 0 }, // 2 violations -> failed
    { e: exp('must_not_flag', 70, 72), findings: [kept(5)], dropped: 0 }, // clean + 1 unlabeled -> passed
  ];
  return specs.map(({ e, findings, dropped }) => {
    const s = scoreCase(e, findings);
    return {
      kind: e.kind,
      status: s.status,
      hit_count: s.hit_count,
      violation_count: s.violation_count,
      unlabeled_count: s.unlabeled_count,
      dropped_count: dropped,
      cost_usd: null,
      error: null,
    };
  });
}

describe('scoring', () => {
  it('rangesIntersect is inclusive and order-insensitive', () => {
    expect(rangesIntersect(1, 3, 3, 5)).toBe(true);
    expect(rangesIntersect(1, 3, 4, 5)).toBe(false);
    expect(rangesIntersect(5, 1, 2, 2)).toBe(true);
  });

  it('labels hit / violation / unlabeled by file and line intersection', () => {
    const find = scoreCase(exp('must_find'), [kept(11), kept(11, 11, 'src/b.ts'), kept(40)]);
    expect(find.findings.map((f) => f.match)).toEqual(['hit', 'unlabeled', 'unlabeled']);
    expect(find.status).toBe('passed');
    const flag = scoreCase(exp('must_not_flag'), [kept(10)]);
    expect(flag.findings[0]?.match).toBe('violation');
    expect(flag.status).toBe('failed');
    expect(scoreCase(exp('must_not_flag'), []).status).toBe('passed');
    expect(scoreCase(exp('must_find'), []).status).toBe('failed');
  });

  it('AC12: statuses passed/failed/failed/passed, recall 0.5, precision 0.5, citation 6/7, unlabeled 2', () => {
    const outcomes = ac12Outcomes();
    expect(outcomes.map((o) => o.status)).toEqual(['passed', 'failed', 'failed', 'passed']);
    const m = aggregateRun(outcomes);
    expect(m.recall).toBe(0.5);
    expect(m.precision).toBe(0.5);
    expect(m.citation_accuracy).toBeCloseTo(6 / 7, 4);
    expect(m.unlabeled_findings).toBe(2);
    expect(m.cases_passed).toBe(2);
    expect(runVerdict(outcomes)).toEqual({ status: 'completed', error: null });
  });

  it('AC16/EC11: no must_find case -> recall null; no findings -> precision and citation null', () => {
    const o = scoreCase(exp('must_not_flag'), []);
    const m = aggregateRun([
      { kind: 'must_not_flag', status: o.status, hit_count: 0, violation_count: 0, unlabeled_count: 0, dropped_count: 0, cost_usd: null, error: null },
    ]);
    expect(m.recall).toBeNull();
    expect(m.precision).toBeNull();
    expect(m.citation_accuracy).toBeNull();
    expect(m.cases_passed).toBe(1);
  });

  it('errored cases are excluded from denominators, counted, and their cost still sums', () => {
    const base = { hit_count: 0, violation_count: 0, unlabeled_count: 0, dropped_count: 0 };
    const m = aggregateRun([
      { ...base, kind: 'must_find', status: 'error', cost_usd: 0.25, error: 'boom' },
      { ...base, kind: 'must_find', status: 'passed', hit_count: 1, cost_usd: 0.5, error: null },
      { ...base, kind: 'must_find', status: 'error', cost_usd: null, error: 'later' },
    ]);
    expect(m.cases_errored).toBe(2);
    expect(m.recall).toBe(1);
    expect(m.cost_usd).toBe(0.75);
    expect(aggregateRun([{ ...base, kind: 'must_find', status: 'error', cost_usd: null, error: 'x' }]).cost_usd).toBeNull();
  });

  it('EC10: every case errored -> failed with the first error; empty set is not failed', () => {
    const base = { kind: 'must_find' as const, hit_count: 0, violation_count: 0, unlabeled_count: 0, dropped_count: 0, cost_usd: null };
    expect(
      runVerdict([
        { ...base, status: 'error', error: 'first' },
        { ...base, status: 'error', error: 'second' },
      ]),
    ).toEqual({ status: 'failed', error: 'first' });
    expect(runVerdict([]).status).toBe('completed');
  });

  it('metricDelta rounds to 4 dp and is null with a null side', () => {
    expect(metricDelta(0.9, 0.85)).toBe(-0.05);
    expect(metricDelta(null, 0.5)).toBeNull();
  });
});

const source = (over: Partial<FindingSource> = {}): FindingSource => ({
  findingId: 'f1',
  reviewId: 'r1',
  prId: 'p1',
  agentId: 'a1',
  decision: 'accepted',
  file: 'src/config.ts',
  startLine: 11,
  endLine: 11,
  severity: 'CRITICAL',
  category: 'security',
  title: 'Hardcoded key',
  patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk",\n   redisUrl: x,',
  prTitle: 'Add rl',
  prBody: null,
  prNumber: 482,
  headSha: 'abc',
  repoFullName: 'acme/api',
  ...over,
});

describe('case builder', () => {
  it('snapshots kind, lines, meta and builds a one-file diff whose hunk contains the lines (AC1)', () => {
    const c = buildEvalCase('w1', source());
    expect(c.expectation).toMatchObject({ kind: 'must_find', file: 'src/config.ts', start_line: 11, end_line: 11 });
    expect(c.inputMeta).toEqual({ pr_title: 'Add rl', pr_description: null, repo: 'acme/api', pr_number: 482, head_sha: 'abc' });
    const diff = parseUnifiedDiff(c.inputDiff);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.path).toBe('src/config.ts');
    expect(diff.files[0]?.hunks[0]?.newLineNumbers).toContain(11);
    expect(c.sourceFindingId).toBe('f1');
    expect(c.agentId).toBe('a1');
  });

  it('dismissed -> must_not_flag (AC2)', () => {
    expect(buildEvalCase('w1', source({ decision: 'dismissed' })).expectation.kind).toBe('must_not_flag');
  });

  it('rejects with the spec codes (AC4)', () => {
    const code = (s: FindingSource) => {
      try {
        buildEvalCase('w1', s);
      } catch (e) {
        return (e as { code: string }).code;
      }
      return 'ok';
    };
    expect(code(source({ decision: null }))).toBe('finding_undecided');
    expect(code(source({ agentId: null }))).toBe('finding_no_agent');
    expect(code(source({ patch: null }))).toBe('patch_unavailable');
    expect(code(source({ patch: '  \n' }))).toBe('patch_unavailable');
    expect(code(source({ patch: 'x'.repeat(EVAL_INPUT_DIFF_MAX_CHARS) }))).toBe('ok');
    expect(code(source({ patch: 'x'.repeat(EVAL_INPUT_DIFF_MAX_CHARS + 1) }))).toBe('patch_too_large');
  });

  it('name: title truncated to 120, location when blank', () => {
    expect(caseName('x'.repeat(200), 'f.ts', 3)).toHaveLength(120);
    expect(caseName('  ', 'f.ts', 3)).toBe('f.ts:3');
  });

  it('header matches the stored-diff header', () => {
    expect(buildSingleFileDiff('a/b.ts', '@@ -1 +1 @@')).toBe('diff --git a/a/b.ts b/a/b.ts\n--- a/a/b.ts\n+++ b/a/b.ts\n@@ -1 +1 @@');
  });

  it('editExpectationLines validates against the merged values (EC16)', () => {
    const e = exp('must_find', 10, 12);
    expect(editExpectationLines(e, { end_line: 15 })).toMatchObject({ start_line: 10, end_line: 15 });
    expect(() => editExpectationLines(e, { end_line: 9 })).toThrow(/end_line/);
    expect(() => editExpectationLines(e, { start_line: 13 })).toThrow(/end_line/);
    try {
      editExpectationLines(e, { end_line: 1 });
    } catch (err) {
      expect((err as { kind: string; code: string }).kind).toBe('invalid_input');
      expect((err as { code: string }).code).toBe('validation_error');
    }
  });
});

describe('lineDiff', () => {
  it('one changed line -> exactly one del and one add', () => {
    const out = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(out.filter((l) => l.op === 'add')).toEqual([{ op: 'add', line: 'B' }]);
    expect(out.filter((l) => l.op === 'del')).toEqual([{ op: 'del', line: 'b' }]);
    expect(out.filter((l) => l.op === 'same').map((l) => l.line)).toEqual(['a', 'c']);
  });

  it('inserts, deletions in the middle, identical and empty inputs', () => {
    expect(lineDiff('a\nb', 'a\nb').every((l) => l.op === 'same')).toBe(true);
    expect(lineDiff('', '')).toEqual([]);
    expect(lineDiff('', 'x')).toEqual([{ op: 'add', line: 'x' }]);
    const out = lineDiff('1\n2\n3\n4\n5', '1\n3\n5\n6');
    expect(out.filter((l) => l.op === 'del').map((l) => l.line)).toEqual(['2', '4']);
    expect(out.filter((l) => l.op === 'add').map((l) => l.line)).toEqual(['6']);
  });

  it('reconstructs both sides', () => {
    const a = 'x\ny\nz\nw';
    const b = 'y\nq\nz\nw\nr';
    const out = lineDiff(a, b);
    expect(out.filter((l) => l.op !== 'add').map((l) => l.line).join('\n')).toBe(a);
    expect(out.filter((l) => l.op !== 'del').map((l) => l.line).join('\n')).toBe(b);
  });
});

const run = (over: Partial<EvalRunSummary> = {}): EvalRunSummary => ({
  id: 'r',
  agent_id: 'a1',
  agent_version: 1,
  model: 'gpt',
  status: 'completed',
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:01:00.000Z',
  cases_total: 2,
  cases_finished: 2,
  cases_passed: 1,
  cases_errored: 0,
  recall: 0.5,
  precision: 0.9,
  citation_accuracy: 1,
  unlabeled_findings: 0,
  cost_usd: 0.1,
  duration_ms: 1000,
  error: null,
  ...over,
});
const config = (over: Partial<EvalRunConfig> = {}): EvalRunConfig => ({
  provider: 'openai',
  model: 'gpt',
  system_prompt: 'l1\nl2',
  strategy: 'single-pass',
  skills: [],
  ...over,
});

describe('compareRuns', () => {
  it('AC17: deltas B-A, flips, one add + one del, config diff', () => {
    const out = compareRuns(
      {
        run: run({ id: 'A' }),
        config: config(),
        results: [
          { case_id: 'c1', case_name: 'one', status: 'passed' },
          { case_id: 'c2', case_name: 'two', status: 'failed' },
          { case_id: 'c3', case_name: 'three', status: 'passed' },
        ],
      },
      {
        run: run({ id: 'B', recall: 1, precision: 0.85, cost_usd: 0.3 }),
        config: config({ system_prompt: 'l1\nL2', model: 'gpt-2', strategy: 'map-reduce', skills: [{ id: 's', name: 'sk', description: '', body: '', version: 1 }] }),
        results: [
          { case_id: 'c1', case_name: 'one', status: 'passed' },
          { case_id: 'c2', case_name: 'two', status: 'passed' },
          { case_id: 'c4', case_name: 'four', status: 'error' },
        ],
      },
    );
    expect(out.delta).toEqual({ recall: 0.5, precision: -0.05, citation_accuracy: 0, cost_usd: 0.2 });
    expect(out.cases.map((c) => [c.case_id, c.a, c.b, c.flipped])).toEqual([
      ['c1', 'passed', 'passed', false],
      ['c2', 'failed', 'passed', true],
      ['c3', 'passed', 'absent', true],
      ['c4', 'absent', 'error', true],
    ]);
    expect(out.config_diff.system_prompt.filter((l) => l.op === 'add')).toHaveLength(1);
    expect(out.config_diff.system_prompt.filter((l) => l.op === 'del')).toHaveLength(1);
    expect(out.config_diff.model).toEqual({ a: 'gpt', b: 'gpt-2' });
    expect(out.config_diff.strategy).toEqual({ a: 'single-pass', b: 'map-reduce' });
    expect(out.config_diff.skills_added).toEqual(['sk']);
    expect(out.config_diff.skills_removed).toEqual([]);
  });

  it('identical config -> null model/strategy, unchanged prompt; null metric -> null delta', () => {
    const out = compareRuns(
      { run: run({ recall: null }), config: config(), results: [] },
      { run: run(), config: config(), results: [] },
    );
    expect(out.config_diff.model).toBeNull();
    expect(out.config_diff.strategy).toBeNull();
    expect(out.config_diff.system_prompt.every((l) => l.op === 'same')).toBe(true);
    expect(out.delta.recall).toBeNull();
  });

  it('EC12: different agents or an unfinished run is not comparable', () => {
    expect(() => assertComparable(run(), run({ agent_id: 'a2' }))).toThrow(/different agents/);
    expect(() => assertComparable(run(), run({ status: 'running' }))).toThrow(/not finished/);
    expect(() => assertComparable(run(), run({ status: 'failed' }))).not.toThrow();
  });
});

describe('dashboard derivations', () => {
  it('AC18: precision 0.9 -> 0.85 with recall up -> exactly the precision alert', () => {
    const alert = regressionAlert(run({ recall: 0.7, precision: 0.85 }), run({ recall: 0.5, precision: 0.9 }));
    expect(alert).toEqual({ metrics: [{ metric: 'precision', delta: -0.05 }] });
  });

  it('threshold is >= 0.02 on rounded deltas; null metrics and a missing previous never alert', () => {
    expect(regressionAlert(run({ precision: 0.88 }), run({ precision: 0.9 }))?.metrics).toEqual([{ metric: 'precision', delta: -0.02 }]);
    expect(regressionAlert(run({ precision: 0.89 }), run({ precision: 0.9 }))).toBeNull();
    expect(regressionAlert(run({ precision: null }), run({ precision: 0.9 }))).toBeNull();
    expect(regressionAlert(run(), null)).toBeNull();
    expect(regressionAlert(null, run())).toBeNull();
  });

  it('names every dropped metric in contract order', () => {
    const alert = regressionAlert(run({ recall: 0.1, precision: 0.1, citation_accuracy: 0.5 }), run({ recall: 0.5, precision: 0.9, citation_accuracy: 1 }));
    expect(alert?.metrics.map((m) => m.metric)).toEqual(['recall', 'precision', 'citation_accuracy']);
  });

  it('trend keeps the last 20 and sparkline the last 10, oldest first', () => {
    const newestFirst = Array.from({ length: 25 }, (_, i) => run({ id: `r${25 - i}` }));
    expect(trendOf(newestFirst)).toHaveLength(20);
    expect(trendOf(newestFirst)[19]?.id).toBe('r25');
    expect(trendOf(newestFirst)[0]?.id).toBe('r6');
    const spark = sparklineOf(newestFirst);
    expect(spark).toHaveLength(10);
    expect(spark.map((p) => p.run_id)[0]).toBe('r16');
    expect(sparklineOf([])).toEqual([]);
  });
});
