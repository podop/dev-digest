# Context pack: Blast Radius (L04 homework)
## INSIGHTS that apply
- [I1] `server/INSIGHTS.md:38` — "pass req.log into service methods as a request-scoped Logger port" → Logger port.
- [I2] `server/INSIGHTS.md:40` — "throw platform/errors.ts subclasses … unknown routes get the same {error:{code:'not_found'}} envelope"
- [I3] `server/INSIGHTS.md:31` — "reach a sibling module only via c.modules.<name>.<method>(...) inside a composition.ts, never a direct file import of its application/ports.ts" → local port, no repo-intel imports.
- [I4] `server/INSIGHTS.md:41` — "to rewire a module, edit its composition.ts, never container.ts"
- [I5] `server/INSIGHTS.md:59` — "build response schemas from the @devdigest/shared contract the client types against, and cover each route with an inject test that reads the fields"
- [I6] `server/INSIGHTS.md:45` — "name/place it under a ring folder so depcruise sees it"
- [I7] `server/INSIGHTS.md:19` — "always inject overrides.llm … for every provider id in tests"
- [I8] `server/INSIGHTS.md:71` — "pulls/:n/files lists a file<->symlink type change as TWO entries with the same filename" → dedupe paths.
- [I9] `server/INSIGHTS.md:21` — "a changed port signature breaks test fakes only at runtime … grep test/ for its fakes" → S8.
- [I10] `server/INSIGHTS.md:65` — "run `docker pull pgvector/pgvector:pg16` once first"
- [C1] `client/INSIGHTS.md:14` — "renderWithProviders … + mockFetch … stub fetch/EventSource, do not vi.mock('@/lib/hooks/*')".
- [C2] `client/INSIGHTS.md:29` — "Badge's props are a closed list … wrap the Badge in a plain <span title=...>".
- [C3] `client/INSIGHTS.md:39` — "every query key comes from the factories there … mutations own invalidation".
- [C4] `client/INSIGHTS.md:33` — "the global MutationCache toasts EVERY mutation error" → no own toast.
- [C5] `client/INSIGHTS.md:37` — "a real <button aria-expanded> is the keyboard toggle → … don't wrap a header that contains a link in one <button>".
- [C6] `client/INSIGHTS.md:57` — "Importing any value pulls zod … → import values only where the route already needs zod, otherwise use types".
- [C7] `client/INSIGHTS.md:51` — "format dates with toLocaleString like the rest of the codebase".
- [C8] `client/INSIGHTS.md:13` — PrDetailView.test setup (RepoProvider + next/navigation mock)
- [M1] `mcp/INSIGHTS.md:18` — "throw ToolError inside guarded() … never return a success-shaped object on failure".
- [M2] `mcp/INSIGHTS.md:14` — "'exactly<U>()([...])' … rejects both"
- [M3] `mcp/INSIGHTS.md:24` — "alias only the bare 'zod'".
## Verified facts
- [F1] `server/src/modules/repo-intel/types.ts:63-87` — `BlastCallerRow{file,symbol,viaSymbol,line,rank}`, `BlastResult{changedSymbols,callers,factsByFile?,degraded?,reason?,…}`; `factsByFile` only on the persistent path (`application/blast-radius.ts:99-110`); never throws.
- [F2] `server/src/platform/container.ts:200-201` — `repoIntel` = `overrides.repoIntel ?? modules.repoIntel.service`; same use in `conventions/composition.ts:21`, `reviews/composition.ts:20-23`.
- [F3] `repo-intel/constants.ts:30,49` limits; `application/blast-radius.ts:107` caps callers at 20 total (not per symbol) — untouched.
- [F4] `modules/_shared/schemas.ts:11` `IdParams` = uuid; smart-diff-service: pullExists → NotFoundError.
- [F5] `vendor/shared/adapters.ts:168` `GitHubClient`; `container.ts:237-243` `github()` throws `ConfigError` with no token; `octokit.ts:96-127` `pulls.list` + `withRetry(withTimeout)`.
- [F6] `server/AGENTS.md:38-40` — cp procedure + drift script; `brief.ts` copies identical now.
- [F7] `client/src/lib/hooks/repo-intel.ts` `useResyncRepoIntel` invalidates only `repoKeys.intelState`; `keys.ts:31-43` prKeys.
- [F8] `mcp/test/tools.test.ts:40-68` — description ≤260 chars, starts "Call"; startup catalog ≤5 200 (measured 5 190), whole ≤11 200.
- [F9] `PrDetailView.tsx:33,92` has `repoId`, renders OverviewTab; no OverviewTab test.
- [F10] `client/messages/en/blast.json` has `stat.*`, `view.*`, `callerCount`, `noDownstream`, `graph.*`; render.tsx loads all namespaces; icons Globe/Clock/Chevron*/Code exist.
## Mirrors
- `server/src/modules/smart-diff/` + `test/smart-diff.it.test.ts` — layout, wiring, it setup.
- `server/test/github-octokit.test.ts` — Octokit stubs.
- `…/OverviewTab/_components/IntentCard/` — card states, styles.ts.
- `client/src/lib/hooks/smart-diff.ts` — hook; `mcp/src/tools/get-conventions.ts` — tool, `trimToBudget`.
- MCP description draft: "Call before reviewing or changing a PR to see what it can break: changed symbols, their callers (file:line), affected endpoints and crons from DevDigest's index. degraded=true means unknown, not 'no impact'."
## Skill map (from routing.json)
| Step | Files (glob) | Skills | Key rules |
|---|---|---|---|
| S1, S8 | `*/src/vendor/shared/**` | drift_check, zod | both copies identical |
| S2, S3, S8 | `server/src/modules/**`, `server/src/adapters/**`, `**/composition.ts` | onion-architecture, typescript-expert, security, zod | rings §1, DI §4, workspace-scoped read (A01) |
| S3, S8 | `server/src/modules/**/http/**` | fastify-best-practices | schema-first, inject tests |
| S4 | `mcp/src/**/*.ts` | typescript-expert, security, zod | strict input, ToolError, no raw errors |
| S5–S7, S9 | `client/src/**` | frontend-ui-architecture, react-best-practices, typescript-expert, security, next-best-practices | hooks-only data, folder anatomy, messages, noopener |
| S6, S7, S9 | `client/**/*.test.tsx` | react-testing-library | getByRole, userEvent, fetch-boundary mocks |
| S10 | `e2e/flows/*.json` | — | e2e/README flow format |
## Risks
- GitHub rate limits on history — cap 30, small concurrency, staleTime.
- Same symbol name in several files — self-exclusion by name+file.
## Notes for reviewers
- Architecture: no ES import from `modules/repo-intel/**` in `modules/blast/**`; `pnpm arch:check` baseline unchanged; facade called once per request.
- Security: workspace-scoped PR lookup; GitHub paths/titles as text only; links `noopener noreferrer`.
