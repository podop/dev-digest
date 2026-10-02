import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { toVerdict, untrustedError, UNTRUSTED_TEXT_NOTE, UntrustedTextField, VerdictSchema } from '../present.js';
import { resolveAgent, resolvePull, resolveRepo } from '../resolve.js';
import { isRunning, waitForRun } from '../run-review.js';
import { guarded, ok, PrArgs, type ToolDeps, type ToolExtra } from './shared.js';

const RunResult = {
  ...UntrustedTextField,
  repo: z.string(),
  pr_number: z.number().int(),
  run_id: z.string(),
  agent: z.string(),
  status: z.enum(['done', 'running']).describe('"running" = still in progress when the wait limit was hit'),
  duration_ms: z.number().int().optional(),
  cost_usd: z.number().optional(),
  result: VerdictSchema.optional().describe('Verdict of this run; absent while status is "running"'),
  next_step: z.string(),
};

export function registerRunAgentOnPr(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'run_agent_on_pr',
    {
      title: 'Run a DevDigest review on a PR',
      description:
        'Call when the user asks DevDigest to review a PR. Starts one paid LLM review (agent from list_agents) and waits up to 120 s; returns run_id, verdict and counts per severity, or status "running". Then call get_findings. Not for re-reading a finished review.',
      inputSchema: z
        .object({
          ...PrArgs,
          agent: z.string().min(1).describe('Agent name (as in list_agents) or agent id.'),
        })
        .strict(),
      outputSchema: RunResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async ({ repo: repoRef, pr_number, agent: agentRef }, extra: ToolExtra) => {
      const deadline = deps.now() + deps.runWaitMs;
      const { api } = deps;
      const agent = await resolveAgent(api, agentRef, extra.signal);
      const repo = await resolveRepo(api, repoRef, extra.signal);
      const pr = await resolvePull(api, repo, pr_number, extra.signal);

      const started = await api.startReview(pr.id, agent.id, extra.signal);
      const runId = started.runs.find((r) => r.agent_id === agent.id)?.run_id ?? started.runs[0]?.run_id;
      if (!runId) {
        throw new ToolError('run_not_started', 'DevDigest accepted the request but created no run.', 'Check the API log; then call run_agent_on_pr again.');
      }

      const base = { untrusted_text: UNTRUSTED_TEXT_NOTE, repo: repo.full_name, pr_number, run_id: runId, agent: agent.name } as const;
      let run: Awaited<ReturnType<typeof waitForRun>>;
      try {
        run = await waitForRun(deps, pr.id, runId, deadline, extra);
      } catch (err) {
        // The client cancelled the tool call: don't leave a paid LLM run behind.
        if (extra.signal.aborted) await api.cancelRun(runId).catch(() => undefined);
        throw err;
      }

      if (!run || isRunning(run)) {
        return ok(RunResult, {
          ...base,
          status: 'running',
          next_step: `Still running after 120 s. Call get_findings with run_id "${runId}" in ~30 s; do not start another run.`,
        });
      }
      if (run.status !== 'done') {
        throw new ToolError(
          `run_${run.status}`,
          `Review run ${runId} (${agent.name}) ended as "${run.status}"${run.error ? `: ${untrustedError(run.error)}` : ''}. No findings were produced — do not report the PR as clean.`,
          run.status === 'cancelled'
            ? 'The run was cancelled in DevDigest; call run_agent_on_pr again if a review is still wanted.'
            : 'Fix the cause if it is a config problem (e.g. missing LLM key in DevDigest Settings), then call run_agent_on_pr again.',
        );
      }

      const review = (await api.listReviews(pr.id, extra.signal)).find((r) => r.run_id === runId);
      if (!review) {
        throw new ToolError('review_missing', `Run ${runId} finished but its review is not stored.`, 'Call get_findings for the PR without run_id to see the current reviews.');
      }
      return ok(RunResult, {
        ...base,
        status: 'done',
        ...(run.duration_ms !== null ? { duration_ms: run.duration_ms } : {}),
        ...(run.cost_usd !== null ? { cost_usd: run.cost_usd } : {}),
        result: toVerdict(review),
        next_step: `Call get_findings with run_id "${runId}" for the individual findings (file, lines, rationale).`,
      });
    }),
  );
}
