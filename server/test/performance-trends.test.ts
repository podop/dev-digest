import { describe, expect, it } from 'vitest';
import type { RunFact } from '../src/modules/performance/domain/metrics.js';
import { previousWindow, type PeriodWindow } from '../src/modules/performance/domain/period.js';
import {
  findingsByCategory,
  findingsBySeverity,
  runsTrend,
  topMemories,
  topSkills,
} from '../src/modules/performance/domain/trends.js';

const DAY = 24 * 60 * 60 * 1000;
const to = new Date('2026-10-16T12:00:00.000Z');
const win30: PeriodWindow = { key: '30d', from: new Date(to.getTime() - 30 * DAY), to, toInclusive: true };
const win1: PeriodWindow = { key: '1d', from: new Date(to.getTime() - DAY), to, toInclusive: true };

const run = (ranAt: Date): RunFact => ({
  agentId: 'a',
  status: 'done',
  source: 'local',
  model: 'm',
  durationMs: 1,
  costUsd: 0.01,
  ranAt,
});

describe('performance trends', () => {
  it('previousWindow is the equally long window ending where the period starts', () => {
    const prev = previousWindow(win30);
    expect(prev.to).toEqual(win30.from);
    expect(prev.from.getTime()).toBe(win30.from.getTime() - 30 * DAY);
    expect(prev.toInclusive).toBe(false);
  });

  it('runsTrend slices 30d per day and 1d per hour; a run at `to` lands in the last slice', () => {
    const trend = runsTrend([run(win30.from), run(to), run(to)], win30);
    expect(trend).toHaveLength(30);
    expect(trend[0]).toEqual({ label: win30.from.toISOString(), value: 1 });
    expect(trend[29]!.value).toBe(2);
    expect(runsTrend([], win1)).toHaveLength(24);
  });

  it('findingsBySeverity sums counts into 6 equal slices; findingsByCategory drops nothing but zeros', () => {
    const facts = [
      { ranAt: win30.from, severity: 'CRITICAL', category: 'security', count: 2 },
      { ranAt: win30.from, severity: 'SUGGESTION', category: 'style', count: 1 },
      { ranAt: to, severity: 'WARNING', category: 'security', count: 3 },
    ];
    const sev = findingsBySeverity(facts, win30);
    expect(sev).toHaveLength(6);
    expect(sev[0]).toMatchObject({ critical: 2, warning: 0, suggestion: 1 });
    expect(sev[5]).toMatchObject({ critical: 0, warning: 3, suggestion: 0 });
    expect(findingsByCategory(facts)).toEqual([
      { category: 'security', count: 5 },
      { category: 'style', count: 1 },
    ]);
  });

  it('topSkills keeps the 5 most-used; topMemories counts a text once per run and skips malformed items', () => {
    const skills = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => ({ skillId: name, name, runs: i + 1 }));
    expect(topSkills(skills).map((s) => s.label)).toEqual(['f', 'e', 'd', 'c', 'b']);
    const memories = topMemories([
      [{ text: 'x' }, { text: 'x' }, { text: 'y' }],
      [{ text: 'x' }, { nope: 1 }, null],
      null,
      'not-an-array',
    ]);
    expect(memories).toEqual([
      { key: 'x', label: 'x', runs: 2 },
      { key: 'y', label: 'y', runs: 1 },
    ]);
  });
});
