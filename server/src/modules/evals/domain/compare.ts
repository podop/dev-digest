/**
 * Comparing two finished runs of one agent (FR13): metric deltas (B − A), per-case
 * status flips and the config diff — the system prompt as a line diff. Pure.
 */
import type {
  EvalCaseStatus,
  EvalCompare,
  EvalCompareCaseStatus,
  EvalPromptDiffLine,
  EvalRunSummary,
} from '@devdigest/shared';
import { ValidationError } from '../../../platform/errors.js';
import { COST_DECIMALS, LINE_DIFF_MAX_CELLS } from './constants.js';
import { metricDelta } from './scoring.js';
import type { EvalRunConfig } from './types.js';

const lines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/**
 * Line diff by longest common subsequence. The common head and tail are trimmed first;
 * a changed middle too big for the LCS table degrades to "delete all, add all".
 */
export function lineDiff(before: string, after: string): EvalPromptDiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const same = (line: string): EvalPromptDiffLine => ({ op: 'same', line });
  const out: EvalPromptDiffLine[] = a.slice(0, head).map(same);
  out.push(...diffMiddle(midA, midB));
  out.push(...a.slice(a.length - tail).map(same));
  return out;
}

function diffMiddle(a: string[], b: string[]): EvalPromptDiffLine[] {
  const del = (line: string): EvalPromptDiffLine => ({ op: 'del', line });
  const add = (line: string): EvalPromptDiffLine => ({ op: 'add', line });
  if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) > LINE_DIFF_MAX_CELLS) {
    return [...a.map(del), ...b.map(add)];
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const out: EvalPromptDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', line: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      out.push(del(a[i]!));
      i++;
    } else {
      out.push(add(b[j]!));
      j++;
    }
  }
  while (i < a.length) out.push(del(a[i++]!));
  while (j < b.length) out.push(add(b[j++]!));
  return out;
}

/** One finished run with what compare reads from it. */
export interface CompareSide {
  run: EvalRunSummary;
  config: EvalRunConfig;
  results: ReadonlyArray<{ case_id: string; case_name: string; status: EvalCaseStatus }>;
}

/** Two runs are comparable when they belong to one agent and both finished (EC12). */
export function assertComparable(a: EvalRunSummary, b: EvalRunSummary): void {
  if (a.agent_id !== b.agent_id) {
    throw new ValidationError('Runs of different agents cannot be compared', undefined, 'runs_not_comparable');
  }
  if (a.status === 'running' || b.status === 'running') {
    throw new ValidationError('A run that has not finished cannot be compared', undefined, 'runs_not_comparable');
  }
}

/** `provider/model` only when the provider changed, so a plain model bump reads as the model ids. */
function modelLabels(a: EvalRunConfig, b: EvalRunConfig): { a: string; b: string } | null {
  if (a.provider === b.provider) return a.model === b.model ? null : { a: a.model, b: b.model };
  return { a: `${a.provider}/${a.model}`, b: `${b.provider}/${b.model}` };
}

/**
 * Compare run A (older) with run B (newer). A case present in only one run has status
 * `absent` on the other side and counts as flipped (the statuses differ).
 */
export function compareRuns(a: CompareSide, b: CompareSide): EvalCompare {
  assertComparable(a.run, b.run);
  const byCase = new Map<string, { name: string; a: EvalCompareCaseStatus; b: EvalCompareCaseStatus }>();
  for (const r of a.results) byCase.set(r.case_id, { name: r.case_name, a: r.status, b: 'absent' });
  for (const r of b.results) {
    const row = byCase.get(r.case_id);
    if (row) row.b = r.status;
    else byCase.set(r.case_id, { name: r.case_name, a: 'absent', b: r.status });
  }
  const skillNames = (c: EvalRunConfig) => c.skills.map((s) => s.name);
  const namesA = new Set(skillNames(a.config));
  const namesB = new Set(skillNames(b.config));
  return {
    a: a.run,
    b: b.run,
    delta: {
      recall: metricDelta(a.run.recall, b.run.recall),
      precision: metricDelta(a.run.precision, b.run.precision),
      citation_accuracy: metricDelta(a.run.citation_accuracy, b.run.citation_accuracy),
      cost_usd: metricDelta(a.run.cost_usd, b.run.cost_usd, COST_DECIMALS),
    },
    cases: [...byCase].map(([case_id, row]) => ({
      case_id,
      case_name: row.name,
      a: row.a,
      b: row.b,
      flipped: row.a !== row.b,
    })),
    config_diff: {
      system_prompt: lineDiff(a.config.system_prompt, b.config.system_prompt),
      model: modelLabels(a.config, b.config),
      strategy:
        a.config.strategy === b.config.strategy ? null : { a: a.config.strategy, b: b.config.strategy },
      skills_added: skillNames(b.config).filter((n) => !namesA.has(n)),
      skills_removed: skillNames(a.config).filter((n) => !namesB.has(n)),
    },
  };
}
