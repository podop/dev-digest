import type { RunSummary } from '@devdigest/shared';
import type { ToolDeps, ToolExtra } from './tools/shared.js';

export function isRunning(run: RunSummary): boolean {
  return run.status === 'running' || run.status === null;
}

/**
 * Poll the PR's run history until the run leaves "running" or `deadline`
 * (an absolute `deps.now()` timestamp, set at the tool call's entry) passes.
 * Never sleeps past the deadline, so the caller's elapsed time never exceeds
 * the wait budget it was given.
 */
export async function waitForRun(deps: ToolDeps, prId: string, runId: string, deadline: number, extra: ToolExtra): Promise<RunSummary | undefined> {
  const startedAt = deps.now();
  const totalS = Math.round(deps.runWaitMs / 1000);
  const progressToken = extra._meta?.progressToken;
  for (;;) {
    const run = (await deps.api.listRuns(prId, extra.signal)).find((r) => r.run_id === runId);
    if (run && !isRunning(run)) return run;
    const remaining = deadline - deps.now();
    if (remaining <= 0) return run;
    if (progressToken !== undefined) {
      const elapsed = Math.round((deps.now() - startedAt) / 1000);
      await extra
        .sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: elapsed, total: totalS, message: `review running for ${elapsed}s` },
        })
        .catch(() => undefined);
    }
    await deps.sleep(Math.min(deps.pollIntervalMs, remaining), extra.signal);
  }
}
