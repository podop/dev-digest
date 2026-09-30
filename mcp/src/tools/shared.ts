import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DevDigestApi } from '../api.js';
import { ToolError, toolErrorText } from '../errors.js';

export interface ToolDeps {
  api: DevDigestApi;
  /** run_agent_on_pr status poll interval. */
  pollIntervalMs: number;
  /** run_agent_on_pr wait budget in ms, from the tool call's entry. Not model-settable. */
  runWaitMs: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The `extra` argument the SDK passes to every tool callback. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Arguments every PR-scoped tool takes: what a user actually says ("PR #3 in owner/repo"). */
export const PrArgs = {
  repo: z.string().min(3).describe('Repository as "owner/name" (a GitHub URL also works).'),
  pr_number: z.number().int().positive().describe('GitHub pull request number, e.g. 3 for PR #3.'),
};

/** The structured payload a tool's `outputSchema` shape describes. */
export type OutputOf<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

/**
 * Success: structured content for the client + the same JSON as text for
 * clients without outputSchema support. Takes the tool's `outputSchema` shape
 * so a payload that does not match it fails typecheck, not the SDK's runtime
 * output validation (after a paid run, for run_agent_on_pr).
 */
export function ok<S extends z.ZodRawShape>(_outputSchema: S, data: OutputOf<S>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

export function fail(err: ToolError): CallToolResult {
  return { content: [{ type: 'text', text: toolErrorText(err) }], isError: true };
}

/**
 * Turn a ToolError into a tool-level error result with its next step; anything
 * else becomes a generic `internal_error` — the real message goes to stderr
 * only, never back to the client (it may be a raw Node/HTTP error).
 */
export function guarded<A, E>(fn: (args: A, extra: E) => Promise<CallToolResult>): (args: A, extra: E) => Promise<CallToolResult> {
  return async (args: A, extra: E): Promise<CallToolResult> => {
    try {
      return await fn(args, extra);
    } catch (err) {
      if (err instanceof ToolError) return fail(err);
      console.error('devdigest-mcp: unexpected tool error:', err);
      return fail(new ToolError('internal_error', 'Unexpected devdigest-mcp error.', 'Check the MCP server log (stderr) for details; retry once, then report it.'));
    }
  };
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
