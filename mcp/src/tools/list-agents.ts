import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CiFailOn } from '@devdigest/shared';
import { z } from 'zod';
import { exactly } from '../exactly.js';
import { guarded, ok, type ToolDeps } from './shared.js';

const BLOCKS_ON = exactly<CiFailOn>()(['never', 'critical', 'warning', 'any']);

const AgentView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string(),
  enabled: z.boolean(),
  blocks_on: z.enum(BLOCKS_ON).describe('Severity at which this reviewer blocks a PR'),
});

const Output = { agents: z.array(AgentView) };

export function registerListAgents(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_agents',
    {
      title: 'List DevDigest reviewers',
      description:
        'Call first when the user names a DevDigest reviewer (e.g. "Security Reviewer") or asks which exist. Returns enabled reviewer agents with the name/id run_agent_on_pr needs. Does not list repos or PRs.',
      inputSchema: z
        .object({
          include_disabled: z.boolean().default(false).describe('Also return disabled agents (they cannot be run).'),
        })
        .strict(),
      outputSchema: Output,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ include_disabled }, extra) => {
      const agents = await deps.api.listAgents(extra.signal);
      return ok(Output, {
        agents: agents
          .filter((a) => include_disabled || a.enabled)
          .map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            provider: a.provider,
            model: a.model,
            enabled: a.enabled,
            blocks_on: a.ci_fail_on,
          })),
      });
    }),
  );
}
