/**
 * Multi-agent read-model rules (pure; specs/multi-agent-review.md FR5–FR7):
 * column order, run totals and the location groups where agents agree or differ.
 */
import type { AgentColumn, Conflict, ConflictTake, FindingRecord, Severity } from '@devdigest/shared';

/** The parent multi-agent run row joined with its PR. */
export interface MultiAgentRunHeader {
  id: string;
  prId: string;
  repoId: string;
  prNumber: number | null;
  prTitle: string | null;
  ranAt: Date;
}

/** One row of the repo's multi-agent run list (counts already aggregated). */
export interface MultiAgentRunListRow {
  id: string;
  prId: string;
  prNumber: number | null;
  prTitle: string | null;
  ranAt: Date;
  agentCount: number;
  runningCount: number;
  totalCostUsd: number | null;
}

/** Average duration / cost of an agent's last done runs. */
export interface AgentEstimateRow {
  agentId: string;
  sampleSize: number;
  avgDurationMs: number | null;
  avgCostUsd: number | null;
}

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 3, WARNING: 2, SUGGESTION: 1 };

/** Columns by agent name ascending, ties by run id. Sorted here: the DB collation ignores dashes in ORDER BY name. */
export function orderColumns(columns: readonly AgentColumn[]): AgentColumn[] {
  return [...columns].sort(
    (a, b) => a.agent_name.localeCompare(b.agent_name, 'en') || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0),
  );
}

/** Wall clock of a parallel fan-out (longest column) and the summed cost (null when no column has one). */
export function runTotals(columns: readonly AgentColumn[]): { total_duration_ms: number; total_cost_usd: number | null } {
  const costs = columns.flatMap((c) => (c.cost_usd === null ? [] : [c.cost_usd]));
  return {
    total_duration_ms: columns.reduce((max, c) => Math.max(max, c.duration_ms ?? 0), 0),
    total_cost_usd: costs.length === 0 ? null : costs.reduce((sum, c) => sum + c, 0),
  };
}

interface Located {
  finding: FindingRecord;
  columnIndex: number;
}

/** Highest-severity finding; ties keep the earlier one. */
function top(findings: readonly FindingRecord[]): FindingRecord | undefined {
  let best: FindingRecord | undefined;
  for (const f of findings) if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best.severity]) best = f;
  return best;
}

/**
 * Group the findings of the `done` columns by location: same file and
 * overlapping inclusive line ranges, transitively. Groups are ordered by file,
 * then first line; every group has one take per done column, in column order.
 */
export function groupFindings(columns: readonly AgentColumn[]): Conflict[] {
  const done = columns.filter((c) => c.status === 'done');
  const located: Located[] = done.flatMap((c, columnIndex) => c.findings.map((finding) => ({ finding, columnIndex })));
  located.sort(
    (a, b) =>
      (a.finding.file < b.finding.file ? -1 : a.finding.file > b.finding.file ? 1 : 0) ||
      a.finding.start_line - b.finding.start_line ||
      a.columnIndex - b.columnIndex,
  );

  const groups: Located[][] = [];
  let current: Located[] = [];
  let currentFile = '';
  let currentEnd = 0;
  for (const item of located) {
    const { file, start_line, end_line } = item.finding;
    if (current.length > 0 && file === currentFile && start_line <= currentEnd) {
      current.push(item);
      currentEnd = Math.max(currentEnd, end_line);
    } else {
      if (current.length > 0) groups.push(current);
      current = [item];
      currentFile = file;
      currentEnd = end_line;
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const bests: (FindingRecord | undefined)[] = [];
    const takes = done.map((column, columnIndex): ConflictTake => {
      const mine = group.filter((g) => g.columnIndex === columnIndex).map((g) => g.finding);
      const best = top(mine);
      bests.push(best);
      return {
        agent_id: column.agent_id,
        persona: column.agent_name,
        run_id: column.run_id,
        verdict: best ? best.severity : 'ignored',
        note: best ? best.title : '',
        finding_ids: mine.map((f) => f.id),
      };
    });
    const first = takes[0]!;
    return {
      file: group[0]!.finding.file,
      line: Math.min(...group.map((g) => g.finding.start_line)),
      end_line: Math.max(...group.map((g) => g.finding.end_line)),
      // Highest severity across the columns; ties → the first column.
      title: top(bests.flatMap((b) => (b ? [b] : [])))?.title ?? '',
      is_conflict: !takes.every((t) => t.verdict !== 'ignored' && t.verdict === first.verdict),
      takes,
    };
  });
}

/** The memory text Learn stores for a finding: title, blank line, rationale, optional suggested fix. */
export function learnedMemoryContent(finding: Pick<FindingRecord, 'title' | 'rationale' | 'suggestion'>): string {
  const parts = [finding.title, finding.rationale];
  if (finding.suggestion) parts.push(`Suggested fix: ${finding.suggestion}`);
  return parts.join('\n\n');
}

/** The memory `sources` context that identifies a learned finding (idempotency key). */
export function learnContext(findingId: string): string {
  return `finding:${findingId}`;
}
