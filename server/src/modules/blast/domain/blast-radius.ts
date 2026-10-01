/**
 * Pure mapping of the repo-intel blast read to the `BlastRadius` contract
 * (server/specs/07-blast-radius.md, AC 2-4). No I/O, no model call.
 */
import type { BlastCaller, BlastRadius, DownstreamImpact } from '@devdigest/shared';
import type { BlastResult } from './types.js';

interface RankedCaller extends BlastCaller {
  rank: number;
}

function compareCallers(a: RankedCaller, b: RankedCaller): number {
  return b.rank - a.rank || a.name.localeCompare(b.name) || a.file.localeCompare(b.file) || a.line - b.line;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Groups the flat callers by `viaSymbol`. A caller whose file is the file that
 * declares that symbol (name + file) is dropped. A group's endpoints / crons
 * are the de-duplicated union of `factsByFile[file]` over its caller files
 * (empty when the read is degraded: no facts). Groups are ordered by their
 * highest caller rank (desc), callers by rank (desc); ties fall back to
 * name / file / line so the output is deterministic.
 */
export function buildBlastRadius(result: BlastResult): BlastRadius {
  const declaredIn = new Set(result.changedSymbols.map((s) => `${s.name}\u0000${s.file}`));
  const facts = result.factsByFile ?? {};

  const groups = new Map<string, RankedCaller[]>();
  for (const c of result.callers) {
    if (declaredIn.has(`${c.viaSymbol}\u0000${c.file}`)) continue;
    const list = groups.get(c.viaSymbol) ?? [];
    if (!list.some((x) => x.name === c.symbol && x.file === c.file && x.line === c.line)) {
      list.push({ name: c.symbol, file: c.file, line: c.line, rank: c.rank });
    }
    groups.set(c.viaSymbol, list);
  }

  const ordered = [...groups.entries()]
    .map(([symbol, callers]) => ({
      symbol,
      callers: [...callers].sort(compareCallers),
      maxRank: Math.max(...callers.map((c) => c.rank)),
    }))
    .sort((a, b) => b.maxRank - a.maxRank || compareText(a.symbol, b.symbol));

  const downstream: DownstreamImpact[] = ordered.map(({ symbol, callers }) => {
    const endpoints = new Set<string>();
    const crons = new Set<string>();
    for (const file of new Set(callers.map((c) => c.file))) {
      for (const e of facts[file]?.endpoints ?? []) endpoints.add(e);
      for (const cr of facts[file]?.crons ?? []) crons.add(cr);
    }
    return {
      symbol,
      callers: callers.map(({ name, file, line }) => ({ name, file, line })),
      endpoints_affected: [...endpoints],
      crons_affected: [...crons],
    };
  });

  const out: BlastRadius = {
    changed_symbols: result.changedSymbols.map(({ name, file, kind }) => ({ name, file, kind })),
    downstream,
    summary: blastSummary(result.changedSymbols.length, downstream),
  };
  if (result.degraded !== undefined) out.degraded = result.degraded;
  if (result.reason !== undefined) out.reason = result.reason;
  return out;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Deterministic one-line summary from distinct counts, e.g.
 * "3 changed symbols · 7 callers · 2 endpoints · 1 cron". A caller that reaches
 * several symbols counts once.
 */
export function blastSummary(changedSymbolCount: number, downstream: readonly DownstreamImpact[]): string {
  const callers = new Set<string>();
  const endpoints = new Set<string>();
  const crons = new Set<string>();
  for (const d of downstream) {
    for (const c of d.callers) callers.add(`${c.file}\u0000${c.name}\u0000${c.line}`);
    for (const e of d.endpoints_affected) endpoints.add(e);
    for (const cr of d.crons_affected) crons.add(cr);
  }
  return [
    plural(changedSymbolCount, 'changed symbol', 'changed symbols'),
    plural(callers.size, 'caller', 'callers'),
    plural(endpoints.size, 'endpoint', 'endpoints'),
    plural(crons.size, 'cron', 'crons'),
  ].join(' · ');
}
