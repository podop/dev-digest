# mcp — `@devdigest/mcp` (devdigest-mcp)

## Commands (npm, not pnpm)
- `npm test` · `npm run typecheck` · `npm run lint`
- `npm start` (stdio) · `npm run inspect` (MCP Inspector UI)

## Read when
- Adding or changing a tool, env var or the API calls → read `README.md` (tools table, rules)
- Start of every task here → read `INSIGHTS.md` first; at the end → `engineering-insights` wrap-up

## Conventions (non-default)
- Talks to DevDigest **only** through `src/api.ts` (explicit methods, no generic
  request). A new capability = a new named method there + a line in the README table.
- No DB, no secrets, no LLM: domain rules stay in the server; this package only
  resolves names → ids, waits, and projects compact results.
- Every tool: `inputSchema: z.object({...}).strict()` (unknown args are a validation
  error, never silently dropped), `outputSchema` + `structuredContent`, all 4
  annotations explicit (`readOnlyHint: true, destructiveHint: false, idempotentHint:
  true, openWorldHint: false` on reads), errors thrown as `ToolError(code, message,
  nextStep)` inside `guarded()`.
- Output fields that can be missing are `.optional()`, never `.nullable()` (present.ts):
  build the object with a conditional spread instead of assigning `null`.
- `run_agent_on_pr` waits up to `RUN_WAIT_MS` (120 s, `src/config.ts`) from the tool
  call's entry, not from when its HTTP calls happen to start — it is not a tool
  argument (`wait_seconds` was removed). `src/run-review.ts` owns the poll loop
  (`waitForRun`); it never sleeps past the deadline.
- Findings/conventions lists honour `limit` (max 100) and a hard
  `MAX_RESPONSE_CHARS` (24 000) response-size budget (`present.ts#trimToBudget`);
  either cut reports `omitted` + a `next_step`, unless a more specific one already won.
- `@devdigest/shared` is imported **type-only** (resolved to `../server/src/vendor/shared`).
  So: `api.ts` checks the fields the tools read (`list`/`object` → `api_contract`), and a
  copied shared enum is written as `exactly<SharedUnion>()([...])` (`src/exactly.ts`) so a
  missing or extra value fails typecheck.
- Each tool keeps its output shape in a `const Output = {...}` passed to both
  `outputSchema` and `ok(Output, payload)` — the payload is typed `OutputOf<typeof Output>`.

## Gotchas
- stdout is the MCP protocol: never `console.log`; diagnostics go to stderr.
- tsconfig aliases only the bare `zod`; a `zod/*` alias makes `tsc` hang on `registerTool`.
- An unexpected (non-`ToolError`) throw becomes a generic `internal_error`; log the
  real error to stderr in `guarded()`, never put it in the text sent back to the client.
- `.mcp.json`'s `timeout: 180000` is read by Claude Code, NOT by the MCP Inspector: the
  Inspector CLI cuts a call at 60 s and the server then cancels the DevDigest run. For
  real-LLM runs pass a config copy with `"requestTimeout": 180000` on the server entry
  (UI: raise both timeouts in Configuration). See `README.md` → MCP Inspector.
