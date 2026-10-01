import { describe, it, expect } from 'vitest';
import { MAX_CALLERS_PER_SYMBOL } from '../src/modules/repo-intel/constants.js';
import { getBlastRadius } from '../src/modules/repo-intel/application/blast-radius.js';
import type { QueryDeps } from '../src/modules/repo-intel/application/ports.js';
import type { ResolvedCallerRow } from '../src/modules/repo-intel/domain/model.js';

/**
 * Persistent blast path — the caller cap is PER changed symbol (not global), and
 * endpoints/facts are reported only through the callers that were kept.
 * In-memory reader fake; no Postgres.
 */

const DECL = 'src/lib.ts';

function callersOf(symbol: string, n: number, rankBase = 1): ResolvedCallerRow[] {
  return Array.from({ length: n }, (_, i) => ({
    fromPath: `src/${symbol}-caller-${i}.ts`,
    toSymbol: symbol,
    line: 5,
    // rank desc by index: caller-0 is the highest-ranked.
    rank: rankBase + (n - i) / 1000,
  }));
}

function build(
  symbols: string[],
  callers: ResolvedCallerRow[],
  endpointsByFile: Record<string, string[]> = {},
  opts: { enabled?: boolean; state?: Record<string, unknown> | null } = {},
) {
  const factsRequested: string[][] = [];
  const reader = {
    tryGetIndexState: async () => (opts.state === undefined ? { status: 'full' } : opts.state),
    getRepoBasics: async () => null, // no clone → the ripgrep fallback is empty but still tagged
    getSymbolRows: async (_r: string, paths: string[]) =>
      paths.includes(DECL)
        ? symbols.map((name) => ({ path: DECL, name, kind: 'function', line: 1, endLine: 2, exported: true, signature: null }))
        : [],
    getResolvedCallers: async () => callers,
    getFileFacts: async (_r: string, files: string[]) => {
      factsRequested.push(files);
      return files.map((filePath) => ({ filePath, endpoints: endpointsByFile[filePath] ?? [], crons: [] }));
    },
  };
  const deps = { enabled: opts.enabled ?? true, reader } as unknown as QueryDeps;
  return { deps, factsRequested };
}

describe('getBlastRadius — per-symbol caller cap (persistent path)', () => {
  it('keeps only MAX_CALLERS_PER_SYMBOL callers of one symbol, the highest-ranked', async () => {
    const all = callersOf('a', MAX_CALLERS_PER_SYMBOL + 5);
    const { deps } = build(['a'], all);
    const res = await getBlastRadius(deps, 'r1', [DECL]);

    expect(res.callers).toHaveLength(MAX_CALLERS_PER_SYMBOL);
    expect(res.callers.map((c) => c.file)).toEqual(all.slice(0, MAX_CALLERS_PER_SYMBOL).map((c) => c.fromPath));
  });

  it('keeps every caller when each of several symbols is within the cap (a global cap would drop some)', async () => {
    const a = callersOf('a', MAX_CALLERS_PER_SYMBOL, 1);
    const b = callersOf('b', MAX_CALLERS_PER_SYMBOL, 2);
    const { deps } = build(['a', 'b'], [...a, ...b]);
    const res = await getBlastRadius(deps, 'r1', [DECL]);

    expect(res.callers).toHaveLength(2 * MAX_CALLERS_PER_SYMBOL);
    // overall rank-desc order preserved
    const ranks = res.callers.map((c) => c.rank);
    expect(ranks).toEqual([...ranks].sort((x, y) => y - x));
    expect(res.callers.filter((c) => c.viaSymbol === 'a')).toHaveLength(MAX_CALLERS_PER_SYMBOL);
    expect(res.callers.filter((c) => c.viaSymbol === 'b')).toHaveLength(MAX_CALLERS_PER_SYMBOL);
  });

  it('does not report endpoints (or facts) that only dropped callers reach', async () => {
    const all = callersOf('a', MAX_CALLERS_PER_SYMBOL + 1);
    const keptFile = all[0]!.fromPath;
    const droppedFile = all[MAX_CALLERS_PER_SYMBOL]!.fromPath;
    const { deps, factsRequested } = build(['a'], all, {
      [keptFile]: ['GET /kept'],
      [droppedFile]: ['GET /dropped'],
    });
    const res = await getBlastRadius(deps, 'r1', [DECL]);

    expect(res.impactedEndpoints).toEqual(['GET /kept']);
    expect(res.factsByFile).toBeDefined();
    expect(Object.keys(res.factsByFile ?? {})).not.toContain(droppedFile);
    expect(factsRequested[0]).not.toContain(droppedFile);
  });
});

describe('getBlastRadius — degraded reasons from the index state', () => {
  const callers = callersOf('a', 2);
  const run = (opts: Parameters<typeof build>[3]) => {
    const { deps } = build(['a'], callers, {}, opts);
    return getBlastRadius(deps, 'r1', [DECL]);
  };

  it('flag off → degraded flag_off', async () => {
    const res = await run({ enabled: false });
    expect(res).toMatchObject({ degraded: true, reason: 'flag_off', callers: [] });
  });

  it('no state row → degraded no_data', async () => {
    expect(await run({ state: null })).toMatchObject({ degraded: true, reason: 'no_data' });
  });

  it('failed index → degraded index_failed', async () => {
    const res = await run({ state: { status: 'failed', degraded: true, degradedReason: 'index_failed' } });
    expect(res).toMatchObject({ degraded: true, reason: 'index_failed' });
  });

  it("degraded row → its stored degradedReason, else no_data", async () => {
    expect(await run({ state: { status: 'degraded', degradedReason: 'repo_too_large' } })).toMatchObject({
      degraded: true,
      reason: 'repo_too_large',
    });
    expect(await run({ state: { status: 'degraded' } })).toMatchObject({ degraded: true, reason: 'no_data' });
  });

  it('partial index → keeps its callers, degraded index_partial', async () => {
    const res = await run({ state: { status: 'partial' } });
    expect(res.degraded).toBe(true);
    expect(res.reason).toBe('index_partial');
    expect(res.callers).toHaveLength(2);
    expect(res.changedSymbols).toHaveLength(1);
  });

  it('bounded > 0 → keeps data, repo_too_large wins over index_partial', async () => {
    for (const status of ['full', 'partial']) {
      const res = await run({ state: { status, bounded: 7 } });
      expect(res).toMatchObject({ degraded: true, reason: 'repo_too_large' });
      expect(res.callers).toHaveLength(2);
    }
  });

  it('full index (bounded 0) → not degraded, no reason', async () => {
    const res = await run({ state: { status: 'full', bounded: 0 } });
    expect(res.degraded).toBe(false);
    expect(res.reason).toBeUndefined();
    expect(res.callers).toHaveLength(2);
  });

  it('usable index with no declared symbols still carries the degraded flags', async () => {
    const { deps } = build([], [], {}, { state: { status: 'partial' } });
    const res = await getBlastRadius(deps, 'r1', [DECL]);
    expect(res).toMatchObject({ degraded: true, reason: 'index_partial', callers: [], changedSymbols: [] });
  });
});
