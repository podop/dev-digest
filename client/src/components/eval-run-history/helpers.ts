import type { EvalRunSummary } from "@devdigest/shared";

/** A run row; the cross-agent "recent runs" table also carries the agent's name. */
export type RunsTableRow = EvalRunSummary & { agent_name?: string };

export function formatRunDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Only a finished run can be compared; a running run has no metrics yet. */
export function isSelectable(run: EvalRunSummary): boolean {
  return run.status !== "running";
}

/** Toggle `id` in the selection, keeping click order. */
export function toggleSelected(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** Whether any row names its agent (then the table shows an Agent column). */
export function hasAgentColumn(runs: readonly RunsTableRow[]): boolean {
  return runs.some((r) => r.agent_name != null);
}
