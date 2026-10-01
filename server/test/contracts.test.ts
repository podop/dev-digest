import { describe, it, expect } from 'vitest';
import {
  Review,
  Finding,
  Intent,
  BlastRadius,
  Risks,
  PrHistory,
  SmartDiff,
  SmartDiffRole,
  Conformance,
  OnboardingTour,
  OnboardingTourState,
  EvalRun,
  MemoryItem,
  RunTrace,
  RunStats,
  ContextList,
  ContextDocPreview,
  ContextAttachments,
  Settings,
  Repo,
  PrDetail,
} from '@devdigest/shared';

/**
 * Contract tests — parse/round-trip the fixtures from data.jsx/data2.jsx
 * so feature agents can rely on the schemas matching the prototype data.
 */
describe('AI contracts parse fixtures', () => {
  it('Review + Finding (data.jsx VERDICT/FINDINGS)', () => {
    const review = Review.parse({
      verdict: 'request_changes',
      summary: 'Two blockers before merge.',
      score: 61,
      findings: [
        {
          id: 'f1',
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded Stripe secret key in commit',
          file: 'src/config.ts',
          start_line: 12,
          end_line: 12,
          rationale: 'Line 12 contains a literal `sk_live_` Stripe key.',
          suggestion: 'Move to env and rotate.',
          confidence: 0.98,
          kind: 'secret_leak',
        },
      ],
    });
    expect(review.findings).toHaveLength(1);
    expect(review.score).toBe(61);
  });

  it('lethal-trifecta Finding variant', () => {
    const f = Finding.parse({
      id: 'f2',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Lethal trifecta',
      file: 'src/api/public/webhooks.ts',
      start_line: 61,
      end_line: 74,
      rationale: 'all three legs present',
      confidence: 0.79,
      kind: 'lethal_trifecta',
      trifecta_components: ['private_data_access', 'untrusted_input', 'exfil_path'],
      evidence: [{ component: 'untrusted_input', file: 'src/api/public/webhooks.ts', line: 61 }],
    });
    expect(f.trifecta_components).toContain('exfil_path');
  });

  it('Intent / BlastRadius / Risks / PrHistory', () => {
    expect(() =>
      Intent.parse({ intent: 'x', in_scope: ['a'], out_of_scope: ['b'] }),
    ).not.toThrow();
    expect(() =>
      BlastRadius.parse({
        changed_symbols: [{ name: 'rateLimit', file: 'a.ts', kind: 'function' }],
        downstream: [
          {
            symbol: 'rateLimit',
            callers: [{ name: 'publicRouter', file: 'b.ts', line: 23 }],
            endpoints_affected: ['GET /x'],
            crons_affected: ['c'],
          },
        ],
        summary: 's',
      }),
    ).not.toThrow();
    const withDegraded = BlastRadius.parse({
      changed_symbols: [],
      downstream: [],
      summary: 's',
      degraded: true,
      reason: 'index_partial',
    });
    expect(withDegraded.degraded).toBe(true);
    expect(withDegraded.reason).toBe('index_partial');
    expect(
      BlastRadius.safeParse({ changed_symbols: [], downstream: [], summary: 's', degraded: true, reason: 'nope' })
        .success,
    ).toBe(false);
    expect(() =>
      Risks.parse({
        risks: [{ kind: 'security', title: 't', explanation: 'e', severity: 'high', file_refs: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      PrHistory.parse({
        history: [
          {
            pr_number: 401,
            title: 't',
            merged_at: '2026-03-18',
            author: 'a',
            files_overlap: [],
            notes: 'n',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('SmartDiff (data.jsx DIFF)', () => {
    const d = SmartDiff.parse({
      groups: [
        {
          role: 'core',
          files: [{ path: 'a.ts', additions: 84, deletions: 0, finding_lines: [28, 52] }],
        },
      ],
      split_suggestion: { too_big: false, total_lines: 285, proposed_splits: [] },
    });
    expect(d.groups[0]!.role).toBe('core');
  });

  it('SmartDiff parses tests and docs roles', () => {
    expect(() => SmartDiff.parse({ groups: [], split_suggestion: { too_big: false, total_lines: 0, proposed_splits: [] } })).not.toThrow();
    expect(SmartDiffRole.parse('tests')).toBe('tests');
    expect(SmartDiffRole.parse('docs')).toBe('docs');
  });

  it('Conformance / EvalRun / MemoryItem', () => {
    expect(() =>
      Conformance.parse({
        spec_id: 's1',
        spec_title: 'Spec',
        items: [{ requirement: 'r', status: 'implemented' }],
        completeness_pct: 80,
      }),
    ).not.toThrow();
    expect(() =>
      EvalRun.parse({
        recall: 0.82,
        precision: 0.91,
        citation_accuracy: 0.95,
        traces_passed: 17,
        traces_total: 20,
        duration_ms: 12000,
        cost_usd: 0.23,
        per_trace: [{ name: 't01', pass: true, expected: 'x', actual: 'x' }],
      }),
    ).not.toThrow();
    expect(() =>
      MemoryItem.parse({
        content: 'c',
        scope: 'team',
        kind: 'decision',
        confidence: 0.92,
        sources: [{ pr: 401, context: 'ctx' }],
      }),
    ).not.toThrow();
  });

  it('RunTrace (data2.jsx TRACE single-document)', () => {
    const trace = RunTrace.parse({
      config: { agent: 'Security Reviewer', version: 'v7', model: 'gpt-4.1', pr: 482, source: 'local' },
      stats: { duration_ms: 8200, tokens_in: 14820, tokens_out: 1240, findings: 3, grounding: '3/3 passed' },
      prompt_assembly: { system: 's', user: 'u' },
      tool_calls: [{ tool: 'read_file', args: "'src/config.ts'", meta: '1,240 bytes', ms: 120 }],
      raw_output: '{}',
      memory_pulled: [{ pr: 288, text: 'verified via stripe-signature' }],
      specs_read: ['specs/security-baseline.md'],
      log: [{ t: '00.00', kind: 'info', msg: 'started' }],
    });
    expect(trace.tool_calls).toHaveLength(1);
    // A trace written before cost tracking has no cost_usd key — still valid.
    expect(trace.stats.cost_usd).toBeUndefined();
    // ...and one written before Project Context has no project_context key.
    expect(trace.project_context).toBeUndefined();
  });

  it('RunTrace carries project_context docs (included + skipped, both origins)', () => {
    const trace = RunTrace.parse({
      config: { agent: 'Security Reviewer', model: 'gpt-4.1' },
      stats: { duration_ms: 1, tokens_in: 1, tokens_out: 1, findings: 0, grounding: '0/0 passed' },
      prompt_assembly: { system: 's', user: 'u' },
      tool_calls: [],
      raw_output: '{}',
      memory_pulled: [],
      specs_read: ['docs/a.md'],
      log: [],
      project_context: {
        budget_tokens: 16000,
        tokens_total: 10,
        docs: [
          { path: 'docs/a.md', doc_type: 'docs', origin: { kind: 'agent' }, tokens: 10, status: 'included', text: 'hello' },
          {
            path: 'specs/b.md',
            doc_type: 'specs',
            origin: { kind: 'skill', skill_id: 's1', skill_name: 'security' },
            tokens: 0,
            status: 'missing',
          },
        ],
      },
    });
    expect(trace.project_context?.docs).toHaveLength(2);
    expect(trace.project_context?.docs[1]?.text).toBeUndefined();
    expect(() =>
      RunTrace.parse({
        config: { agent: 'a', model: 'm' },
        stats: { duration_ms: 1, tokens_in: 1, tokens_out: 1, findings: 0, grounding: 'x' },
        prompt_assembly: { system: 's', user: 'u' },
        tool_calls: [],
        raw_output: '{}',
        memory_pulled: [],
        specs_read: [],
        log: [],
        project_context: {
          budget_tokens: 1,
          tokens_total: 0,
          docs: [{ path: 'a.md', doc_type: 'docs', origin: { kind: 'agent' }, tokens: 0, status: 'bogus' }],
        },
      }),
    ).toThrow();
  });

  it('Project Context list, preview and attachment shapes parse', () => {
    const doc = {
      path: 'docs/a.md',
      name: 'a.md',
      doc_type: 'docs',
      size_bytes: 40,
      tokens: 10,
      updated_at: '2026-10-01T00:00:00.000Z',
      used_by: 2,
    };
    const list = ContextList.parse({ clone_status: 'ready', globs: ['**/docs/**/*.md'], docs: [doc], tokens_total: 10 });
    expect(list.truncated).toBeUndefined();
    expect(ContextList.parse({ clone_status: 'not_cloned', globs: [], docs: [], tokens_total: 0, truncated: true }).truncated).toBe(true);
    const preview = ContextDocPreview.parse({
      ...doc,
      content: '# a',
      used_by_agents: [{ id: 'a1', name: 'Sec', via: 'skill', skill_name: 'security' }, { id: 'a2', name: 'Perf', via: 'direct' }],
    });
    expect(preview.used_by_agents).toHaveLength(2);
    expect(ContextAttachments.parse({ repo_id: 'r1', paths: ['docs/b.md', 'docs/a.md'] }).paths[0]).toBe('docs/b.md');
  });

  it('RunTrace stats carry cost_usd (number or null)', () => {
    const base = { duration_ms: 1, tokens_in: 1, tokens_out: 1, findings: 0, grounding: '0/0 passed' };
    expect(RunStats.parse({ ...base, cost_usd: 0.0013 }).cost_usd).toBe(0.0013);
    expect(RunStats.parse({ ...base, cost_usd: null }).cost_usd).toBeNull();
  });
});

describe('platform DTOs', () => {
  it('Settings defaults + passthrough', () => {
    const s = Settings.parse({ extra_key: 'x' });
    expect(s.theme).toBe('dark');
    expect((s as Record<string, unknown>).extra_key).toBe('x');
  });

  it('Repo + PrDetail', () => {
    expect(() =>
      Repo.parse({
        id: 'r1',
        workspace_id: 'w1',
        owner: 'acme',
        name: 'payments-api',
        full_name: 'acme/payments-api',
        default_branch: 'main',
        clone_path: null,
        last_polled_at: null,
        created_by: null,
      }),
    ).not.toThrow();
    expect(() =>
      PrDetail.parse({
        number: 482,
        title: 't',
        author: 'a',
        branch: 'b',
        base: 'main',
        head_sha: 'sha',
        additions: 1,
        deletions: 0,
        files_count: 1,
        status: 'open',
        files: [],
        commits: [],
      }),
    ).not.toThrow();
  });
});

describe('OnboardingTour contract', () => {
  const tour = () => ({
    repo_id: 'r1',
    generated_at: '2026-10-01T10:00:00.000Z',
    indexed_sha: 'abc123',
    files_indexed: 120,
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    tokens_in: 9000,
    tokens_out: 1200,
    cost_usd: null,
    prompt_version: 1,
    language: 'en' as const,
    architecture: {
      summary: 'A Fastify API over Postgres.',
      nodes: [
        { id: 'api', label: 'API', kind: 'entry' as const },
        { id: 'db', label: 'Postgres', kind: 'store' as const },
      ],
      edges: [{ from: 'api', to: 'db' }],
    },
    critical_paths: [{ path: 'server/src/app.ts', reason: 'Bootstraps the API.' }],
    run_steps: [{ command: './scripts/dev.sh', comment: 'Boots everything' }],
    reading_path: [],
    first_tasks: [{ title: 'Add a test', path: 'server/src/modules', complexity: 'low' as const }],
  });

  it('parses a valid tour and both state shapes', () => {
    expect(OnboardingTour.parse(tour()).architecture.nodes).toHaveLength(2);
    expect(OnboardingTourState.parse({ status: 'none' })).toEqual({ status: 'none' });
    const ready = OnboardingTourState.parse({
      status: 'ready',
      stale: true,
      stale_reason: 'index_changed',
      tour: tour(),
    });
    expect(ready.status === 'ready' && ready.stale_reason).toBe('index_changed');
  });

  it('rejects 13 nodes', () => {
    const t = tour();
    t.architecture.nodes = Array.from({ length: 13 }, (_, i) => ({
      id: `n${i}`,
      label: `N${i}`,
      kind: 'module' as const,
    }));
    expect(OnboardingTour.safeParse(t).success).toBe(false);
  });

  it('rejects an unknown stale reason and a non-en language', () => {
    expect(
      OnboardingTourState.safeParse({ status: 'ready', stale: true, stale_reason: 'x', tour: tour() }).success,
    ).toBe(false);
    expect(OnboardingTour.safeParse({ ...tour(), language: 'de' }).success).toBe(false);
  });

  it('rejects the old {sections} shape', () => {
    const old = { sections: [{ kind: 'architecture', title: 'T', body: 'b', links: [] }] };
    expect(OnboardingTour.safeParse(old).success).toBe(false);
    expect(OnboardingTourState.safeParse(old).success).toBe(false);
  });
});
