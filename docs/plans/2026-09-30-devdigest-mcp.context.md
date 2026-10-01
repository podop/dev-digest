# Context pack: devdigest-mcp — 120 s blocking run + MCP best practices
## INSIGHTS that apply (mcp/INSIGHTS.md; server/ untouched)
- [I1] `:17` — "a throw inside a tool callback becomes {isError:true, content:[text: err.message]}, and validateToolOutput skips outputSchema checks when isError is set … → throw ToolError inside guarded() for a '[code] … Next step: …' text, never return a success-shaped object on failure" → timeout is NOT a failure (success `running`); every other failure stays ToolError.
- [I2] `:21` — "'--config <file> --server <name> --method …' works, and the repo-root .mcp.json doubles as that config (run from the repo root) → use the config form for scripted Inspector checks, plus --strict for schema portability" → verification form; adding `timeout` to .mcp.json must keep it a valid Inspector config.
- [I3] `:22` — "alias only the bare 'zod'; if typecheck hangs, bisect with a one-file tsconfig that extends the main one" → do not touch tsconfig paths; if `z.object().strict()` in registerTool slows tsc, bisect as stated.
## Verified facts
- [F1] `mcp/src/tools/run-agent-on-pr.ts:13-14,41-47` — `DEFAULT_WAIT_S=600`, `MAX_WAIT_S=1800`, model-settable `wait_seconds`.
- [F2] same `:66-71,74-83,115-133` — deadline starts after resolve+start (not call start); abort → `cancelRun`; timeout → `status:'running'`.
- [F3] `test/helpers.ts:125-132` — `connect()` hardcodes `now: Date.now`, `sleep` no-op → needs deps override for a fake clock.
- [F4] SDK 1.31 `server/mcp.d.ts:150` — `registerTool` accepts `ZodRawShapeCompat | AnySchema` → a `.strict()` object works. `zod-to-json-schema/…/object.js:54-62` — strip already emits `additionalProperties:false`; `.strict()` changes runtime only (reject vs silent drop).
- [F5] `zod-to-json-schema/…/nullable.js:11-16` — nullable primitive → `type:[x,"null"]` (the `--strict` warning).
- [F6] nullable sites: `present.ts:41-45`, `run-agent-on-pr.ts:22-24`, `get-conventions.ts:27,48-49`.
- [F7] `server/src/modules/reviews/routes.ts:36,39,79,92,108`, `pulls/routes.ts:21`, `conventions/http/routes.ts:27`, `agents/routes.ts:61`, `repos/routes.ts:34` — all 8 calls exist; review POST returns at once, rate limit 10/min. `app.ts:91` `/health/ready`. `scripts/dev.sh` has no mcp reference.
## Compliance evidence (P# = caller's list)
P1 5 tools resolve names inside (`resolve.ts`) · P2 descriptions lack when-not (`list-agents.ts:21`, `run-agent-on-pr.ts:34`) · P3 `get-conventions.ts:43` limit w/o describe, no `.strict()` · P4 finding/convention `id` unused (`present.ts:24`, `get-conventions.ts:22`) · P5 `shared.ts:21-23` · P6 `get-findings.ts:55` omitted w/o hint, `get-conventions.ts:65` no omitted, no char budget · P7 reads lack `destructiveHint` (`list-agents.ts:27`, `get-findings.ts:39`, `get-conventions.ts:55`, `get-blast-radius.ts:31`) · P8 `api.ts:12-29`, `resolve.ts:81`, `config.ts:28` · P9 `shared.ts:30-40` · P10 `shared.ts:36-37` echoes raw `err.message` · P11 `run-agent-on-pr.ts:123-131` · P12 `.mcp.json` no `timeout`; signal passed to every call · P13 no Tasks · P14/P15 no budget, `server.ts:12-16` · P16 `.mcp.json` `type: stdio`, `index.ts:21` · P17 `index.ts:22,26` stderr · P18 `api.ts`, `config.ts:28-30` · P19 no injection note · P20 `test/helpers.ts` · P21 `mcp/README.md:69-79`; `--strict` warns (F5).
## Architecture (onion-architecture scope: server/, reviewer-core — not routed for mcp)
- Port `DevDigestApi` + its only adapter `createHttpApi` (`api.ts`); errors translated in the adapter (`httpError`).
- Edge = `tools/*.ts`: schema on registration, no parse in handlers, errors thrown, mapped once in `guarded()`.
- Application = `resolve.ts`, new `run-review.ts` (polling/deadline); pure projections = `present.ts`.
- Composition root = `index.ts`; `config.ts` is the only `process.env` reader. No depcruise (proportionality §5).
## Mirrors
- Tests: existing `mcp/test/tools.test.ts` style (real McpServer, InMemoryTransport, `fakeApi` overrides).
## Skill map (routing.json)
| Step | Files | Skills | Key rules |
|---|---|---|---|
| S1–S4 | `mcp/src/**/*.ts`, `mcp/test/**/*.ts` | zod (content rule) | strict vs strip; optional vs nullable; enums |
| S5 | `*.md`, `.mcp.json`, `routing.json` | none | — |
No path rule covers `mcp/` today (→ plan Q2).
## Risks
- Claude Code auto-backgrounds calls > ~2 min (medium) — 120 s cap + deadline from call start.
- One in-flight HTTP call can overshoot the deadline (≤ request timeout 30 s) — covered by `.mcp.json` 180 s.
- Inspector UI default request timeout 10 s / total 60 s — raise both before a real run.
- Removing `wait_seconds`, finding `id`, `rejected` changes the contract — no consumers outside tests/README.
## Notes for reviewers
- Architecture: `api.ts` stays the only outbound path; no generic request.
- Security: loopback check untouched; injection note in instructions; `internal_error` no longer echoes raw text.
