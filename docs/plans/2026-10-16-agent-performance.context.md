# Context pack: Agent Performance dashboard + agent Stats tab
## INSIGHTS that apply
- [I1] `server/INSIGHTS.md:46` — "application may not import db/rows even type-only … infrastructure may import only application/ports.ts" → types in `perf/domain`, port in `application/ports.ts`.
- [I2] `server/INSIGHTS.md:75` — "keys missing from the schema are silently stripped and a mismatch … becomes 500" → responses = shared schemas.
- [I3] `server/INSIGHTS.md:74` — "z.string().safeParse(new Date()) fails" → timestamps as ISO strings.
- [I5] `server/INSIGHTS.md:72` — "ORDER BY name ignores dashes" → sort rows in JS.
- [I6] `server/INSIGHTS.md:49` — "never expect 422 from a service-side parse" → period rules on the route schema.
- [I7] `server/INSIGHTS.md:50` — "module services … are built ONLY by the module's build<Name>Module(container)".
- [I8] `server/INSIGHTS.md:96` — "test/composition.test.ts asserts the exact list of registered modules".
- [I9] `server/INSIGHTS.md:14` — "LLM_PROVIDER_OVERRIDE=mock … gives a key-free review" → AC33 data.
- [I10] `server/INSIGHTS.md:17` — "pg_dump … into a throwaway pgvector/pgvector:pg16 container" → AC15.
- [I11] `server/INSIGHTS.md:22` — "always inject overrides.llm … in tests" → AC14 spies.
- [I12] `server/INSIGHTS.md:99` — "set createdAt explicitly whenever a test depends on ORDER BY" → explicit `ran_at`.
- [C1] `client/INSIGHTS.md:47` — "routes are async Server Components that await params/searchParams … URL state changes go through router.replace(<helper>Href(...))".
- [C2] `client/INSIGHTS.md:50` — "every query key comes from the factories there".
- [C3] `client/INSIGHTS.md:29` — "sidebar labels (NAV[].label) are English literals in vendored nav.ts".
- [C4] `client/INSIGHTS.md:19` — "read the merged NAV array section by section" → item only in GLOBAL.
- [C5] `client/INSIGHTS.md:37` — "new dropdowns import @/components/select".
- [C6] `client/INSIGHTS.md:60` — Select beside a Button: "wrapping each toolbar item in a display:grid span".
- [C7] `client/INSIGHTS.md:69` — "format dates with toLocaleString".
- [C8] `client/INSIGHTS.md:94` — route files with @devdigest/ui need "use client" "or render a client View".
- [C9] `client/INSIGHTS.md:40` — Badge has no `title` → "wrap … in a plain <span title=...>".
- [C10] `client/INSIGHTS.md:48` — "whole-row click via onClick that skips targets inside a/button while a real <button aria-expanded> is the keyboard toggle".
- TB only, `client/INSIGHTS.md`: [C12] `:15` renderWithProviders + mockFetch · [C13] `:28` `api.requests()[i].search` · [C14] `:85` strayText allow-list · [C15] `:61` Tabs are buttons · [C16] `:76` vitest substring filter.
## Verified facts
- [F1] `vendor/shared/contracts/observability.ts:132-161`, `productionize.ts:135-186` — no consumer outside vendor/shared; copies identical at b6fac37; no import cycle.
- [F2] `db/schema/runs.ts:14-57` — `cost_usd` numeric `mode:'number'`; `status`, `model`, `agent_id` nullable; no `(workspace_id, ran_at)` index.
- [F3] `reviews/repository/review.repo.ts:111-133` — accept clears `dismissed_at` and vice versa.
- [F4] `modules/index.ts`, `modules/composition.ts` — static registries; `test/composition.test.ts:21-40` exact list.
- [F5] `http/error-handler.ts:58-64` — request validation → 422 `validation_error`.
- [F6] `agents/routes.ts:66` — `GET /agents/:id`; static `/agents/performance` wins over `:id`; agents is flat legacy.
- [F8] `AgentEditorView.tsx:33-44` — useAgent error → ErrorState `editor.loadErrorTitle/Body`; `page.tsx` passes only `tab`.
- [F9] `vendor/ui/nav.ts:39-45` GLOBAL; `app-shell/helpers.ts:37` + `shell.json` already know `agent-performance`; icon `Activity` exists.
- [F10] `messages/en/agentPerformance.json` — leftover keys, no consumer. `lib/providers.tsx:29-31` — retry 1, staleTime 30 s, no focus refetch.
## Mirrors
- `server/src/modules/skills/` — rings, composition, querystring schema + `getContext`.
- `client/src/app/eval/page.tsx` + `helpers.ts`; `AgentHeader.tsx:85-95` (Calendar Select).
- `app/ci-runs/_components/CiRunsView` — Skeleton / ErrorState / EmptyState; `components/eval-metrics/` — shared presentational folder.
## Skill map (from routing.json)
| Step | Files | Skills | Key rules |
|---|---|---|---|
| S1 | `*/src/vendor/shared/**` | drift_check, zod | copies identical |
| S2–S4 | `server/src/modules/**` | onion-architecture, typescript-expert, security; zod (http) | rings; ports; workspace from context |
| S4 | `perf/http/**` | fastify-best-practices | schema-first, response schemas |
| S5–S8 | `client/src/**` (not vendor) | frontend-ui-architecture, react-best-practices, typescript-expert, security | thin routes; data via lib/hooks; copy in messages; ≥ 2 routes → src/components |
| S7, S8 | `client/src/app/**` | next-best-practices | await searchParams |
| S7 | `client/src/vendor/ui/nav.ts` | — (vendor) | GLOBAL only |
## Risks
- [R1] NFR3: per-run facts (≤ 20k rows), no index → measure AC15; fallback GROUP BY in SQL, same fold.
- [R2] SQL `count`/`sum` arrive as string/bigint → `::int` or `Number()`.
- [R3] AC10 drift → one row builder for both endpoints. [R4] money sums → `roundMoney` after each sum.
- [R5] TZ → ISO instants built in the browser only.
## Test backlog [TB] (test-writer)
- `server/test/performance-domain.test.ts`: AC2, AC3, AC7, AC9, EC8, EC9, window edges (AC11).
- `server/test/performance.it.test.ts`: AC1, AC4–AC6, AC8, AC10–AC14 [I11][I12]; AC10 fixtures off window edges.
- Client: `lib/stats-period.test.ts` (AC17, AC18, EC14); agent-metrics + PeriodPicker (AC20, AC24, AC32); `ap/helpers.test.ts` (AC20, AC21); `AgentPerformanceView.test.tsx` (AC16, AC19, AC21–AC29, AC31); `StatsTab.test.tsx` (AC25–AC27, AC29, AC31); e2e (AC30). Manual AC15, AC33.
## Notes for reviewers
- Missing tests are a user decision, not FAIL. P1–P9 await user review.
- Architecture: one new read-only module + registries. Security: every query scoped by `getContext` workspace; foreign agent → 404; period validated first.
