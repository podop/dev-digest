import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { guarded, PrArgs, type ToolDeps } from './shared.js';

/**
 * Honest stub: the interface is final (so clients can already see and plan
 * for it), the implementation lands with the Blast Radius homework (reads
 * repo-intel's getBlastRadius). It never pretends there is no impact.
 */
export function registerGetBlastRadius(server: McpServer, _deps: ToolDeps): void {
  server.registerTool(
    'get_blast_radius',
    {
      title: 'Get the blast radius of a PR (not implemented yet)',
      description:
        'Do not call yet: not implemented, always returns a not_implemented error (never means "no impact"). Will return a PR\'s changed symbols, their callers and impacted endpoints; until then find callers with grep.',
      inputSchema: z
        .object({
          ...PrArgs,
          max_callers: z.number().int().min(1).max(200).default(50).describe('Cap on caller rows returned (1-200, default 50).'),
        })
        .strict(),
      outputSchema: {
        repo: z.string(),
        pr_number: z.number().int(),
        changed_symbols: z.array(z.object({ file: z.string(), name: z.string(), kind: z.string() })),
        callers: z.array(z.object({ file: z.string(), symbol: z.string(), via_symbol: z.string(), line: z.number().int() })),
        impacted_endpoints: z.array(z.string()),
        degraded: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ repo, pr_number }) => {
      throw new ToolError(
        'not_implemented',
        `Blast radius is not implemented in devdigest-mcp yet (asked for ${repo} PR #${pr_number}). This is NOT a statement that the PR has no impact.`,
        'Do not retry. Tell the user blast radius is unavailable; if needed, find callers of the changed symbols with grep instead.',
      );
    }),
  );
}
