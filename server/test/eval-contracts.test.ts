import { describe, it, expect } from 'vitest';
import {
  AgentEvalCase,
  AgentEvalCaseUpdateInput,
  EvalCaseResult,
  EvalCompare,
  EvalAgentDashboard,
  EvalOverview,
  EvalRunAllResponse,
  EvalRunDetail,
  EvalRunListQuery,
  EvalRunSummary,
  EvalExpectation,
  FindingRecord,
} from '@devdigest/shared';

const expectation = {
  kind: 'must_find' as const,
  file: 'src/a.ts',
  start_line: 10,
  end_line: 12,
  severity: 'CRITICAL',
  category: 'security',
  title: 'SQL injection',
};

const run = {
  id: 'r1',
  agent_id: 'a1',
  agent_version: 3,
  model: 'gpt-4o',
  status: 'completed' as const,
  started_at: '2026-10-14T10:00:00.000Z',
  finished_at: '2026-10-14T10:01:00.000Z',
  cases_total: 8,
  cases_finished: 8,
  cases_passed: 6,
  cases_errored: 0,
  recall: 0.75,
  precision: 1,
  citation_accuracy: 0.8571,
  unlabeled_findings: 2,
  cost_usd: 0.0123,
  duration_ms: 60000,
  error: null,
};

const evalCase = {
  id: 'c1',
  agent_id: 'a1',
  name: 'SQL injection',
  notes: null,
  expectation,
  input_diff: 'diff --git a/src/a.ts b/src/a.ts\n',
  input_meta: {
    pr_title: 'Add query',
    pr_description: null,
    repo: 'acme/app',
    pr_number: 7,
    head_sha: 'abc123',
  },
  source_finding_id: 'f1',
  source_pr_id: 'p1',
  created_at: '2026-10-14T10:00:00.000Z',
  last_result: null,
};

describe('eval-pipeline contracts', () => {
  it('parses an eval case, with and without a last result', () => {
    expect(AgentEvalCase.parse(evalCase)).toEqual(evalCase);
    const withResult = {
      ...evalCase,
      last_result: { run_id: 'r1', status: 'passed', ran_at: '2026-10-14T10:01:00.000Z' },
    };
    expect(AgentEvalCase.parse(withResult).last_result?.status).toBe('passed');
  });

  it('rejects an expectation with end_line < start_line, a bad kind or line 0', () => {
    expect(EvalExpectation.safeParse({ ...expectation, end_line: 9 }).success).toBe(false);
    expect(EvalExpectation.safeParse({ ...expectation, kind: 'nope' }).success).toBe(false);
    expect(EvalExpectation.safeParse({ ...expectation, start_line: 0, end_line: 0 }).success).toBe(false);
    expect(EvalExpectation.safeParse({ ...expectation, end_line: 10 }).success).toBe(true);
  });

  it('rejects a case name over 120 characters', () => {
    expect(AgentEvalCase.safeParse({ ...evalCase, name: 'x'.repeat(121) }).success).toBe(false);
    expect(AgentEvalCase.safeParse({ ...evalCase, name: '' }).success).toBe(false);
  });

  describe('AgentEvalCaseUpdateInput', () => {
    it('accepts any subset, including the empty body', () => {
      expect(AgentEvalCaseUpdateInput.parse({})).toEqual({});
      expect(AgentEvalCaseUpdateInput.parse({ notes: null })).toEqual({ notes: null });
      expect(AgentEvalCaseUpdateInput.parse({ name: 'n', start_line: 3, end_line: 3 })).toEqual({
        name: 'n',
        start_line: 3,
        end_line: 3,
      });
    });

    it('rejects empty/over-long name and lines < 1 or non-integer', () => {
      expect(AgentEvalCaseUpdateInput.safeParse({ name: '' }).success).toBe(false);
      expect(AgentEvalCaseUpdateInput.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
      expect(AgentEvalCaseUpdateInput.safeParse({ start_line: 0 }).success).toBe(false);
      expect(AgentEvalCaseUpdateInput.safeParse({ end_line: 1.5 }).success).toBe(false);
    });

    it('does not compare end_line to start_line (checked against the stored case)', () => {
      expect(AgentEvalCaseUpdateInput.safeParse({ start_line: 20, end_line: 5 }).success).toBe(true);
    });
  });

  it('parses a run summary; metrics may be null while running', () => {
    expect(EvalRunSummary.parse(run)).toEqual(run);
    const running = {
      ...run,
      status: 'running',
      finished_at: null,
      recall: null,
      precision: null,
      citation_accuracy: null,
      cost_usd: null,
      duration_ms: null,
    };
    expect(EvalRunSummary.parse(running).recall).toBeNull();
    expect(EvalRunSummary.safeParse({ ...run, recall: 1.2 }).success).toBe(false);
    expect(EvalRunSummary.safeParse({ ...run, status: 'done' }).success).toBe(false);
  });

  it('parses a run detail with per-case results', () => {
    const result = {
      case_id: 'c1',
      case_name: 'SQL injection',
      expectation,
      status: 'passed',
      findings: [
        { file: 'src/a.ts', start_line: 10, end_line: 11, severity: 'CRITICAL', category: 'security', title: 't', match: 'hit' },
        { file: 'src/b.ts', start_line: 1, end_line: 1, severity: null, category: null, title: null, match: 'unlabeled' },
      ],
      dropped_count: 1,
      duration_ms: 1200,
      cost_usd: null,
      error: null,
    };
    expect(EvalCaseResult.parse(result).findings).toHaveLength(2);
    expect(EvalRunDetail.parse({ run, results: [result] }).results).toHaveLength(1);
    expect(EvalCaseResult.safeParse({ ...result, status: 'timeout' }).success).toBe(false);
    expect(
      EvalCaseResult.safeParse({ ...result, findings: [{ ...result.findings[0], match: 'x' }] }).success,
    ).toBe(false);
  });

  it('coerces and bounds the runs list limit (default 20, 1-100)', () => {
    expect(EvalRunListQuery.parse({}).limit).toBe(20);
    expect(EvalRunListQuery.parse({ limit: '5' }).limit).toBe(5);
    expect(EvalRunListQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(EvalRunListQuery.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('parses a compare payload with absent cases and a prompt line diff', () => {
    const compare = {
      a: run,
      b: { ...run, id: 'r2' },
      delta: { recall: 0.1, precision: 0, citation_accuracy: null, cost_usd: -0.001 },
      cases: [
        { case_id: 'c1', case_name: 'n', a: 'failed', b: 'passed', flipped: true },
        { case_id: 'c2', case_name: 'm', a: 'absent', b: 'passed', flipped: false },
      ],
      config_diff: {
        system_prompt: [
          { op: 'same', line: 'You are a reviewer.' },
          { op: 'del', line: 'Be brief.' },
          { op: 'add', line: 'Be thorough.' },
        ],
        model: { a: 'gpt-4o', b: 'gpt-4.1' },
        strategy: null,
        skills_added: ['sql'],
        skills_removed: [],
      },
    };
    expect(EvalCompare.parse(compare).cases[1]?.a).toBe('absent');
    expect(
      EvalCompare.safeParse({
        ...compare,
        config_diff: { ...compare.config_diff, system_prompt: [{ op: 'move', line: 'x' }] },
      }).success,
    ).toBe(false);
  });

  it('parses dashboards and bounds sparkline / recent runs / trend', () => {
    const spark = { run_id: 'r1', recall: 1, precision: null, citation_accuracy: 0.5 };
    const agent = { agent_id: 'a1', name: 'Sec', model: 'gpt-4o', cases_total: 8, latest: run, sparkline: [spark] };
    expect(
      EvalOverview.parse({ agents: [agent], recent_runs: [{ ...run, agent_name: 'Sec' }] }).agents,
    ).toHaveLength(1);
    expect(
      EvalOverview.safeParse({
        agents: [{ ...agent, sparkline: Array.from({ length: 11 }, () => spark) }],
        recent_runs: [],
      }).success,
    ).toBe(false);
    expect(
      EvalOverview.safeParse({
        agents: [],
        recent_runs: Array.from({ length: 21 }, () => ({ ...run, agent_name: 'x' })),
      }).success,
    ).toBe(false);

    const dash = {
      agent_id: 'a1',
      cases_total: 8,
      latest: run,
      previous: null,
      trend: [run],
      alert: { metrics: [{ metric: 'recall', delta: -0.05 }] },
    };
    expect(EvalAgentDashboard.parse(dash).alert?.metrics[0]?.metric).toBe('recall');
    expect(
      EvalAgentDashboard.safeParse({ ...dash, alert: { metrics: [{ metric: 'cost', delta: 1 }] } }).success,
    ).toBe(false);
  });

  it('parses a run-all response with skip reasons', () => {
    const body = {
      started: [{ ...run, status: 'running', finished_at: null }],
      skipped: [
        { agent_id: 'a2', reason: 'no_cases' },
        { agent_id: 'a3', reason: 'run_active' },
      ],
    };
    expect(EvalRunAllResponse.parse(body).skipped).toHaveLength(2);
    expect(
      EvalRunAllResponse.safeParse({ started: [], skipped: [{ agent_id: 'a', reason: 'disabled' }] }).success,
    ).toBe(false);
  });

  it('FindingRecord.eval_case_id is optional/nullable (additive)', () => {
    const base = {
      id: 'f1',
      review_id: 'rv1',
      accepted_at: null,
      dismissed_at: null,
      file: 'src/a.ts',
      start_line: 1,
      end_line: 2,
      severity: 'WARNING',
      category: 'bug',
      title: 't',
      rationale: 'r',
      confidence: 0.5,
    };
    expect(FindingRecord.parse(base).eval_case_id).toBeUndefined();
    expect(FindingRecord.parse({ ...base, eval_case_id: null }).eval_case_id).toBeNull();
    expect(FindingRecord.parse({ ...base, eval_case_id: 'c1' }).eval_case_id).toBe('c1');
  });
});
