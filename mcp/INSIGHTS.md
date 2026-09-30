# Insights — mcp

Lessons learned in `mcp/` that the code doesn't tell you. Written by the
`engineering-insights` skill via `.claude/skills/engineering-insights/scripts/append_insight.py`.
**Append only** — new bullets go on top of a section; existing lines are never changed by agents.
Format: `- YYYY-MM-DD — <where>: <fact> → <action>`.
Reviewed monthly: stale entries are removed in a dedicated commit.

## What Works
<!-- approaches and solutions that worked here -->

## What Doesn't Work
<!-- dead ends and anti-patterns — the most valuable section -->
- 2026-09-30 — src/exactly.ts (TS 5.9): an exhaustiveness check written as 'const X = [...] as const satisfies ExactTuple<U, readonly U[]>' can't reference the tuple being declared, so Exclude<U, U[number]> is never: it still rejects an extra value (readonly U[]) but silently accepts a MISSING one — verified 2026-09-30 with a probe (missing 'c' compiled clean, extra 'd' failed TS2322); 'exactly<U>()([...])' with a <const T extends readonly U[]> parameter typed T & (missing-check) rejects both (TS2345 { missing: 'c' } / TS2322) → prove a type-level guard with a throwaway failing probe before trusting it; an explicit return type on the inner generic arrow needs a named type alias (inline, tsc reports TS2719 'two different types with this name')

## Codebase Patterns
<!-- conventions and architectural decisions not obvious from the code -->
- 2026-09-30 — @modelcontextprotocol/sdk 1.31 McpServer (dist/esm/server/mcp.js CallTool handler): a throw inside a tool callback becomes {isError:true, content:[text: err.message]}, and validateToolOutput skips outputSchema checks when isError is set, so error results need no structuredContent; input schema failures come back the same way ('Input validation error: …') → throw ToolError inside guarded() for a '[code] … Next step: …' text, never return a success-shaped object on failure

## Tool & Library Notes
<!-- dependency quirks, versions, flags -->
- 2026-09-30 — @modelcontextprotocol/inspector 2.8 --cli tools/call: the per-request timeout defaults to the SDK's 60 s (requestTimeout 0), so a real run_agent_on_pr (~45 s + resolve) was aborted at 1m00s, the server saw the client cancel and cancelled the DevDigest run ('Cancelled by user'); adding "requestTimeout": 180000 to the server entry of the --config file fixed it (verified 2026-09-30 on PR #6, done in 50 s); .mcp.json's "timeout" is ignored by the Inspector → for real-LLM Inspector CLI runs use a config copy with requestTimeout above the 120 s run limit
- 2026-09-30 — @modelcontextprotocol/inspector 2.8 --cli: 'inspector --cli -e K=V <cmd> --method …' fails with 'No servers found in config file' or 'Method is required' (the variadic -e swallows the rest); '--config <file> --server <name> --method …' works, and the repo-root .mcp.json doubles as that config (run from the repo root) → use the config form for scripted Inspector checks, plus --strict for schema portability
- 2026-09-30 — mcp/tsconfig.json paths (@modelcontextprotocol/sdk 1.31 + zod 3.25): copying reviewer-core's 'zod/*' alias made tsc run >100 s at 2.7 GB on a single registerTool call (killed; a bare-'zod'-only alias checks the same file in 3 s, the whole package in 7 s) because the SDK imports zod/v3 + zod/v4 subpaths and the wildcard alias bypasses zod's exports map → alias only the bare 'zod'; if typecheck hangs, bisect with a one-file tsconfig that extends the main one

## Recurring Errors & Fixes
<!-- error message → cause → fix -->
- 2026-09-30 — mcp/test/tools.test.ts cancel test (@modelcontextprotocol/sdk 1.31 Client.callTool with {signal}): the client promise rejects the moment the local AbortSignal fires, before the server has handled notifications/cancelled, so asserting a server-side effect (e.g. api.cancelRun called) right after 'await expect(...).rejects' is flaky → wrap such assertions in vi.waitFor

## Session Notes
<!-- YYYY-MM-DD — one-line summary of a meaningful session -->

## Open Questions
<!-- what is still unresolved -->
