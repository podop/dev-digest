import type { AgentEvalCase, EvalRunDetail, EvalRunSummary } from "@devdigest/shared";

/** Cases whose last run passed (the "n / m passing" header). */
export function countPassing(cases: readonly AgentEvalCase[]): number {
  return cases.filter((c) => c.last_result?.status === "passed").length;
}

/** The per-agent dashboard page for this agent. */
export function dashboardHref(agentId: string): string {
  return `/eval?agent=${encodeURIComponent(agentId)}`;
}

/** The run to follow: the one the runs list says is running, else the one this tab just started. */
export function followedRunId(runs: readonly EvalRunSummary[] | undefined, startedId: string | undefined): string | undefined {
  return runs?.find((r) => r.status === "running")?.id ?? startedId;
}

/** The run that is currently executing, from the freshest data we have (the polled detail beats the list). */
export function runningRun(detail: EvalRunDetail | undefined, runs: readonly EvalRunSummary[] | undefined): EvalRunSummary | null {
  const fromList = runs?.find((r) => r.status === "running") ?? null;
  const run = detail?.run ?? fromList;
  return run?.status === "running" ? run : null;
}
