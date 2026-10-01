import { describe, it, expect } from 'vitest';
import { buildBlastRadius, blastSummary } from '../src/modules/blast/domain/blast-radius.js';
import type { MergedPrSummary } from '@devdigest/shared';
import { selectPriorPrs } from '../src/modules/blast/domain/history.js';
import type { BlastResult } from '../src/modules/blast/domain/types.js';

const sym = (name: string, file: string) => ({ name, file, kind: 'function' });
const caller = (file: string, symbol: string, viaSymbol: string, line: number, rank: number) => ({
  file,
  symbol,
  viaSymbol,
  line,
  rank,
});

describe('buildBlastRadius', () => {
  it('groups callers by viaSymbol, ordered by max rank desc and callers by rank desc', () => {
    const r: BlastResult = {
      changedSymbols: [sym('a', 'src/a.ts'), sym('b', 'src/b.ts')],
      callers: [
        caller('src/x.ts', 'x1', 'a', 3, 0.2),
        caller('src/y.ts', 'y1', 'b', 9, 0.9),
        caller('src/z.ts', 'z1', 'a', 5, 0.5),
      ],
      factsByFile: {},
    };
    const out = buildBlastRadius(r);
    expect(out.downstream.map((d) => d.symbol)).toEqual(['b', 'a']);
    expect(out.downstream[1]!.callers).toEqual([
      { name: 'z1', file: 'src/z.ts', line: 5 },
      { name: 'x1', file: 'src/x.ts', line: 3 },
    ]);
    expect(out.changed_symbols).toEqual([sym('a', 'src/a.ts'), sym('b', 'src/b.ts')]);
  });

  it('breaks rank ties by name, file, line', () => {
    const out = buildBlastRadius({
      changedSymbols: [sym('a', 'src/a.ts')],
      callers: [
        caller('src/z.ts', 'beta', 'a', 1, 0),
        caller('src/y.ts', 'alpha', 'a', 8, 0),
        caller('src/x.ts', 'alpha', 'a', 2, 0),
      ],
    });
    expect(out.downstream[0]!.callers.map((c) => `${c.name}@${c.file}:${c.line}`)).toEqual([
      'alpha@src/x.ts:2',
      'alpha@src/y.ts:8',
      'beta@src/z.ts:1',
    ]);
  });

  it('drops a caller whose file declares the symbol (name + file), keeps the same name elsewhere', () => {
    const out = buildBlastRadius({
      changedSymbols: [sym('run', 'src/a.ts')],
      callers: [caller('src/a.ts', 'inner', 'run', 4, 1), caller('src/b.ts', 'outer', 'run', 7, 1)],
    });
    expect(out.downstream).toHaveLength(1);
    expect(out.downstream[0]!.callers).toEqual([{ name: 'outer', file: 'src/b.ts', line: 7 }]);
  });

  it('omits a group whose callers were all dropped', () => {
    const out = buildBlastRadius({
      changedSymbols: [sym('run', 'src/a.ts')],
      callers: [caller('src/a.ts', 'inner', 'run', 4, 1)],
    });
    expect(out.downstream).toEqual([]);
    expect(out.summary).toBe('1 changed symbol · 0 callers · 0 endpoints · 0 crons');
  });

  it('attaches the de-duplicated union of factsByFile over the group caller files', () => {
    const out = buildBlastRadius({
      changedSymbols: [sym('a', 'src/a.ts')],
      callers: [
        caller('src/x.ts', 'x1', 'a', 1, 2),
        caller('src/x.ts', 'x2', 'a', 9, 1),
        caller('src/y.ts', 'y1', 'a', 1, 1),
        caller('src/none.ts', 'n1', 'a', 1, 0),
      ],
      factsByFile: {
        'src/x.ts': { endpoints: ['GET /x', 'GET /shared'], crons: ['nightly'] },
        'src/y.ts': { endpoints: ['GET /shared', 'POST /y'], crons: [] },
        'src/unrelated.ts': { endpoints: ['GET /nope'], crons: ['nope'] },
      },
    });
    expect(out.downstream[0]!.endpoints_affected).toEqual(['GET /x', 'GET /shared', 'POST /y']);
    expect(out.downstream[0]!.crons_affected).toEqual(['nightly']);
  });

  it('summary uses distinct counts across groups', () => {
    const out = buildBlastRadius({
      changedSymbols: [sym('a', 'src/a.ts'), sym('b', 'src/b.ts'), sym('c', 'src/c.ts')],
      callers: [
        caller('src/x.ts', 'x1', 'a', 1, 1),
        caller('src/x.ts', 'x1', 'b', 1, 1), // same caller reaches two symbols → counted once
        caller('src/y.ts', 'y1', 'b', 2, 1),
      ],
      factsByFile: {
        'src/x.ts': { endpoints: ['GET /x'], crons: ['nightly'] },
        'src/y.ts': { endpoints: ['GET /x', 'GET /y'], crons: [] },
      },
    });
    expect(out.summary).toBe('3 changed symbols · 2 callers · 2 endpoints · 1 cron');
  });

  it('passes degraded/reason through and has no endpoints without factsByFile', () => {
    const out = buildBlastRadius({
      changedSymbols: [sym('a', 'src/a.ts')],
      callers: [caller('src/x.ts', 'x1', 'a', 1, 0)],
      degraded: true,
      reason: 'no_data',
    });
    expect(out.degraded).toBe(true);
    expect(out.reason).toBe('no_data');
    expect(out.downstream[0]!.endpoints_affected).toEqual([]);
    expect(out.downstream[0]!.crons_affected).toEqual([]);
  });

  it('omits degraded/reason when the facade did not set them', () => {
    const out = buildBlastRadius({ changedSymbols: [], callers: [] });
    expect('degraded' in out).toBe(false);
    expect('reason' in out).toBe(false);
  });
});

describe('blastSummary', () => {
  it('pluralises', () => {
    expect(blastSummary(1, [])).toBe('1 changed symbol · 0 callers · 0 endpoints · 0 crons');
  });
});

describe('selectPriorPrs', () => {
  const pr = (number: number, merged_at: string, files: string[]): MergedPrSummary => ({
    number,
    title: `PR ${number}`,
    author: 'dev',
    merged_at,
    files,
  });

  it('excludes the PR itself and PRs without overlap, lists the overlap sorted, notes empty', () => {
    const out = selectPriorPrs(
      [pr(9, '2026-02-01T00:00:00Z', ['a.ts']), pr(3, '2026-01-01T00:00:00Z', ['z.ts', 'a.ts', 'q.ts']), pr(4, '2026-01-02T00:00:00Z', ['q.ts'])],
      { number: 9, files: ['a.ts', 'z.ts'] },
    );
    expect(out).toEqual([
      { pr_number: 3, title: 'PR 3', merged_at: '2026-01-01T00:00:00Z', author: 'dev', files_overlap: ['a.ts', 'z.ts'], notes: '' },
    ]);
  });

  it('orders newest first and caps the list', () => {
    const all = Array.from({ length: 12 }, (_, i) => pr(i + 1, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, ['a.ts']));
    const out = selectPriorPrs(all, { number: 99, files: ['a.ts'] });
    expect(out).toHaveLength(10);
    expect(out.map((p) => p.pr_number)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(selectPriorPrs(all, { number: 99, files: ['a.ts'] }, 2)).toHaveLength(2);
  });
});
