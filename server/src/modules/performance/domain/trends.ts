/**
 * Pure folds behind the charts: the runs trend, findings by severity slice and
 * by category, and the top skills / memories. Every slice is an equal-width cut
 * of the window starting at `from` (no time zone: the client sends none).
 */
import type { CategoryCount, SeverityBucket, StatPoint, UsageCount } from '@devdigest/shared';
import { HOURLY_TREND_MAX_HOURS, MS_PER_DAY, MS_PER_HOUR, SEVERITY_SLICES, TOP_USAGE } from './constants.js';
import type { RunFact } from './metrics.js';
import { byName } from './order.js';
import type { PeriodWindow } from './period.js';

/** Findings of one counted run, grouped by severity and category. */
export interface FindingFact {
  ranAt: Date;
  severity: string;
  category: string;
  count: number;
}

/** Skill usage row as stored: counted runs that had the skill in the prompt. */
export interface SkillFact {
  skillId: string;
  name: string;
  runs: number;
}

interface Slices {
  from: number;
  width: number;
  count: number;
}

function slices(win: PeriodWindow, count: number): Slices {
  const from = win.from.getTime();
  return { from, width: (win.to.getTime() - from) / count, count };
}

/** Hourly slices up to 48 h, daily beyond; always at least 2 (a line needs two points). */
export function trendSlices(win: PeriodWindow): Slices {
  const span = win.to.getTime() - win.from.getTime();
  const unit = span <= HOURLY_TREND_MAX_HOURS * MS_PER_HOUR ? MS_PER_HOUR : MS_PER_DAY;
  return slices(win, Math.max(2, Math.ceil(span / unit)));
}

/** The slice an instant falls in; `to` itself (inclusive presets) belongs to the last one. */
function sliceIndex(s: Slices, at: Date): number {
  const i = Math.floor((at.getTime() - s.from) / s.width);
  return Math.min(Math.max(i, 0), s.count - 1);
}

const sliceStart = (s: Slices, i: number) => new Date(s.from + i * s.width).toISOString();

export function runsTrend(runs: RunFact[], win: PeriodWindow): StatPoint[] {
  const s = trendSlices(win);
  const values = new Array<number>(s.count).fill(0);
  for (const r of runs) {
    const i = sliceIndex(s, r.ranAt);
    values[i] = (values[i] ?? 0) + 1;
  }
  return values.map((value, i) => ({ label: sliceStart(s, i), value }));
}

export function findingsBySeverity(facts: FindingFact[], win: PeriodWindow): SeverityBucket[] {
  const s = slices(win, SEVERITY_SLICES);
  const out: SeverityBucket[] = Array.from({ length: s.count }, (_, i) => ({
    from: sliceStart(s, i),
    critical: 0,
    warning: 0,
    suggestion: 0,
  }));
  for (const f of facts) {
    const b = out[sliceIndex(s, f.ranAt)]!;
    if (f.severity === 'CRITICAL') b.critical += f.count;
    else if (f.severity === 'WARNING') b.warning += f.count;
    else if (f.severity === 'SUGGESTION') b.suggestion += f.count;
  }
  return out;
}

/** Most findings first, then category ascending; empty categories are dropped. */
export function findingsByCategory(facts: FindingFact[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const f of facts) counts.set(f.category, (counts.get(f.category) ?? 0) + f.count);
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || byName(a.category, b.category));
}

function top(items: UsageCount[]): UsageCount[] {
  return items
    .filter((u) => u.runs > 0)
    .sort((a, b) => b.runs - a.runs || byName(a.label, b.label))
    .slice(0, TOP_USAGE);
}

export function topSkills(facts: SkillFact[]): UsageCount[] {
  return top(facts.map((f) => ({ key: f.skillId, label: f.name, runs: f.runs })));
}

/**
 * Top memories from the runs' `trace.memory_pulled` arrays (one entry per
 * counted run that has a trace). A memory counts once per run; entries are
 * keyed by their text. Malformed entries are skipped.
 */
export function topMemories(pulledPerRun: unknown[]): UsageCount[] {
  const runs = new Map<string, number>();
  for (const pulled of pulledPerRun) {
    if (!Array.isArray(pulled)) continue;
    const seen = new Set<string>();
    for (const item of pulled) {
      const text = typeof item === 'object' && item !== null ? (item as { text?: unknown }).text : undefined;
      if (typeof text !== 'string' || text.trim() === '' || seen.has(text)) continue;
      seen.add(text);
      runs.set(text, (runs.get(text) ?? 0) + 1);
    }
  }
  return top([...runs].map(([text, n]) => ({ key: text, label: text, runs: n })));
}
