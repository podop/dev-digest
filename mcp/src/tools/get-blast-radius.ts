import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BlastDegradedReason } from '@devdigest/shared';
import { z } from 'zod';
import { exactly } from '../exactly.js';
import { MAX_RESPONSE_CHARS, trimToBudget, UNTRUSTED_TEXT_NOTE, UntrustedTextField } from '../present.js';
import { resolvePull, resolveRepo } from '../resolve.js';
import { guarded, ok, type OutputOf, PrArgs, type ToolDeps } from './shared.js';

const DEGRADED_REASONS = exactly<BlastDegradedReason>()(['flag_off', 'index_failed', 'index_partial', 'repo_too_large', 'no_data']);

const Output = {
  ...UntrustedTextField,
  repo: z.string(),
  pr_number: z.number().int(),
  summary: z.string().describe('Counts of changed symbols, callers, endpoints and crons'),
  degraded: z.boolean().describe('true = the index could not answer fully: the result is unknown, NOT "no impact"'),
  reason: z.enum(DEGRADED_REASONS).optional().describe('Why the result is degraded'),
  changed_symbols: z.array(z.object({ file: z.string(), name: z.string(), kind: z.string() })).describe('First changed symbols only (capped); the true total is in summary'),
  downstream: z
    .array(
      z.object({
        symbol: z.string(),
        callers: z.array(z.object({ name: z.string(), file: z.string(), line: z.number().int() })),
        endpoints_affected: z.array(z.string()),
        crons_affected: z.array(z.string()),
      }),
    )
    .describe('Symbols with callers, highest-ranked first; endpoints/crons per symbol are capped'),
  omitted_callers: z.number().int().describe('Callers cut by max_callers, response size or dropped groups'),
  omitted_symbols: z.number().int().optional().describe('Changed symbols not listed in changed_symbols (summary has the true total)'),
  omitted_endpoints: z.number().int().optional().describe('Endpoints and crons cut from downstream groups (per-group cap or dropped groups)'),
  omitted_groups: z.number().int().optional().describe('Lowest-ranked downstream groups dropped to fit the response size'),
  next_step: z.string().optional(),
};

const TEXT_SYMBOLS = 10;
const TEXT_CALLERS = 5;
const TEXT_ENDPOINTS = 5;
/** Changed-symbol rows kept in the payload (the summary line has the true total). */
const MAX_SYMBOLS = 50;
/** Endpoints, and separately crons, kept per downstream group (one hub symbol can reach ~90 endpoints). */
const MAX_ENDPOINTS_PER_GROUP = 10;
/** Room kept for the fields and next_step added after trimming. */
const RESERVE_CHARS = 1_000;

export function registerGetBlastRadius(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_blast_radius',
    {
      title: 'Get the blast radius of a PR',
      description:
        'Call before reviewing or changing a PR to see what it can break: changed symbols, their callers (file:line), affected endpoints and crons from DevDigest\'s index. degraded=true means unknown, not "no impact".',
      inputSchema: z
        .object({
          ...PrArgs,
          max_callers: z.number().int().min(1).max(200).default(50).describe('Cap on caller rows returned (1-200, default 50).'),
        })
        .strict(),
      outputSchema: Output,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ repo: repoRef, pr_number, max_callers }, extra) => {
      const repo = await resolveRepo(deps.api, repoRef, extra.signal);
      const pr = await resolvePull(deps.api, repo, pr_number, extra.signal);
      const blast = await deps.api.getBlastRadius(pr.id, extra.signal);

      // Cap the caller rows in the server's group order, and the per-group endpoint/cron lists.
      let budget = max_callers;
      let omittedCallers = 0;
      let omittedEndpoints = 0;
      const downstream = blast.downstream.map((d) => {
        const callers = d.callers.slice(0, budget);
        budget -= callers.length;
        omittedCallers += d.callers.length - callers.length;
        const endpoints = d.endpoints_affected.slice(0, MAX_ENDPOINTS_PER_GROUP);
        const crons = d.crons_affected.slice(0, MAX_ENDPOINTS_PER_GROUP);
        omittedEndpoints += d.endpoints_affected.length - endpoints.length + (d.crons_affected.length - crons.length);
        return { symbol: d.symbol, callers, endpoints_affected: endpoints, crons_affected: crons };
      });
      const changedSymbols = blast.changed_symbols.slice(0, MAX_SYMBOLS);

      const degraded = blast.degraded === true;
      const payload: OutputOf<typeof Output> = {
        untrusted_text: UNTRUSTED_TEXT_NOTE,
        repo: repo.full_name,
        pr_number,
        summary: blast.summary,
        degraded,
        ...(blast.reason ? { reason: blast.reason } : {}),
        changed_symbols: changedSymbols,
        downstream,
        omitted_callers: omittedCallers,
      };

      // Over budget: cut in the order of least value. First whole groups from the tail (lowest
      // rank), then, only when a single group is left, its callers.
      const limit = MAX_RESPONSE_CHARS - RESERVE_CHARS;
      let omittedGroups = 0;
      while (payload.downstream.length > 1 && JSON.stringify(payload).length > limit) {
        const gone = payload.downstream.pop()!;
        omittedGroups += 1;
        payload.omitted_callers += gone.callers.length;
        omittedEndpoints += gone.endpoints_affected.length + gone.crons_affected.length;
      }
      trimToBudget(
        payload,
        payload.downstream.map((d) => ({ items: d.callers, onDrop: () => (payload.omitted_callers += 1) })),
        limit,
      );

      const omittedSymbols = blast.changed_symbols.length - changedSymbols.length;
      if (omittedSymbols > 0) payload.omitted_symbols = omittedSymbols;
      if (omittedEndpoints > 0) payload.omitted_endpoints = omittedEndpoints;
      if (omittedGroups > 0) payload.omitted_groups = omittedGroups;

      if (degraded) {
        payload.next_step = `DevDigest's index could not answer fully (${blast.reason ?? 'unknown reason'}), so this is NOT proof of no impact. Ask the user to click Resync on the PR's Blast radius card in DevDigest (this MCP server does not re-index), then call again; meanwhile find callers with grep.`;
      } else {
        const cut = [
          payload.omitted_callers > 0 ? `${payload.omitted_callers} callers` : '',
          omittedGroups > 0 ? `${omittedGroups} low-ranked groups` : '',
          omittedEndpoints > 0 ? `${omittedEndpoints} endpoints/crons` : '',
          omittedSymbols > 0 ? `${omittedSymbols} changed symbols` : '',
        ].filter(Boolean);
        if (cut.length > 0) {
          const more = payload.omitted_callers > 0 ? 'Call again with a higher max_callers (max 200) for more callers; the' : 'The';
          payload.next_step = `Cut to fit: ${cut.join(', ')}. ${more} DevDigest UI (PR > Blast radius card) shows everything.`;
        }
      }

      return ok(Output, payload, renderText(payload));
    }),
  );
}

/** A short human rendering of the payload (the structured content stays the source of truth). */
function renderText(p: OutputOf<typeof Output>): string {
  const lines = [`Blast radius of ${p.repo} PR #${p.pr_number}: ${p.summary}.`, p.untrusted_text];
  if (p.degraded) {
    lines.push(`DEGRADED (${p.reason ?? 'unknown reason'}): the index could not answer fully; callers may be missing. This is NOT 'no impact'.`);
  }
  for (const d of p.downstream.slice(0, TEXT_SYMBOLS)) {
    const shown = d.callers.slice(0, TEXT_CALLERS).map((c) => `${c.name} (${c.file}:${c.line})`);
    const more = d.callers.length - shown.length;
    const tail = [list('endpoints', d.endpoints_affected), list('crons', d.crons_affected)].filter(Boolean);
    lines.push(`- ${d.symbol} <- ${shown.join(', ') || 'no callers listed'}${more > 0 ? `, +${more} more` : ''}${tail.length > 0 ? `; ${tail.join('; ')}` : ''}`);
  }
  if (p.downstream.length > TEXT_SYMBOLS) lines.push(`(+${p.downstream.length - TEXT_SYMBOLS} more symbols in structuredContent)`);
  if (p.next_step) lines.push(`Next step: ${p.next_step}`);
  return lines.join('\n');
}

function list(label: string, items: string[]): string {
  if (items.length === 0) return '';
  const more = items.length - TEXT_ENDPOINTS;
  return `${label}: ${items.slice(0, TEXT_ENDPOINTS).join(', ')}${more > 0 ? `, +${more} more` : ''}`;
}
