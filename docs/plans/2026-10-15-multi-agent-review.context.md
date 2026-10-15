# Context pack: Multi-Agent Review (worktree A)
## INSIGHTS that apply
- [I1] `server/INSIGHTS.md:44` — "p-queue as a FRAMEWORK for the application ring … inject bounded concurrency from composition.ts" → `runBounded`.
- [I2] `server/INSIGHTS.md:43` — "application may not import db/rows … infrastructure may import only application/ports.ts" → place files under `domain/`, `application/`, `repository/`.
- [I3] `server/INSIGHTS.md:33` — "a PR's current findings = the newest kind='review' row PER AGENT" → the read model takes the review by `run_id`, never `reviews[0]`.
- [I4] `server/INSIGHTS.md:49` — "terminal 'done' write … conditional on status='running'" → per-run persist and cancel stay unchanged.
- [I6] `server/INSIGHTS.md:69-71` — "z.string().safeParse(new Date()) fails … keys missing from the schema are silently stripped" → use ISO strings and shared response schemas.
- [I7] `server/INSIGHTS.md:72` — "a POST with no payload reaches the zod body validator as null" → keep the preprocess.
- [I8] `server/INSIGHTS.md:46,99` — request validation answers 422.
- [I9] `server/INSIGHTS.md:88` — "calls IndexWriter.lockRepo(repoId) FIRST (pg_advisory_xact_lock)" → the Learn lock.
- [I10] `server/INSIGHTS.md:67` — "ORDER BY name ignores dashes" → sort columns in JS.
- [I11] `server/INSIGHTS.md:81` — "rows.map(toFindingRecord) passes the array INDEX" → write `(r) => …`.
- [I12] `server/INSIGHTS.md:82` — "pnpm typecheck never checks test/ files" → do not break `FakeStore`.
- [I13] `server/INSIGHTS.md:13` — "LLM_PROVIDER_OVERRIDE=mock … key-free review".
- [C1] `client/INSIGHTS.md:44` — "any new host of RunTraceDrawer must know running before mounting it".
- [C2] `client/INSIGHTS.md:45` — "routes … await params/searchParams … URL state changes go through router.replace".
- [C4] `client/INSIGHTS.md:48` — "every query key comes from the factories … mutations own invalidation".
- [C5] `client/INSIGHTS.md:42` — "the global MutationCache toasts EVERY mutation error" → no second toast.
- [C6] `client/INSIGHTS.md:27` — sidebar labels are English literals.
- [C7] `client/INSIGHTS.md:35` — "new dropdowns import @/components/select".
- [C8] `client/INSIGHTS.md:46` — prReview is shared → "change only route-owned subkeys".
- [C9] `client/INSIGHTS.md:63` — Markdown prints raw HTML as escaped text (NFR6).
- [C10] `client/INSIGHTS.md:90` — a route file that renders `@devdigest/ui` needs "use client" or a client View.
- [C12] `client/INSIGHTS.md:39` — Drawer renders in place → mount it beside the columns, not inside a card.
- [C13] `client/INSIGHTS.md:73` — filter vitest by substring, not by `[id]` paths.
## Verified facts
- [F1] `reviews/application/review-service.ts:82-93` — `resolveTargets`: `all` or `agentId`, else 400 `invalid_run_request`.
- [F2] `reviews/application/run-executor.ts:116-131` — a sequential loop; per-agent try/catch; no shared mutable state.
- [F3] `vendor/shared/contracts/platform.ts:260` — `agentIds .min(1).max(20)`; `http/error-handler.ts:60-64` → 422.
- [F5] `server/test/reviews-service.test.ts:319` — exact `toEqual` on the response; `:322-330` expects `actOnFinding('learn')` → `invalid_action`.
- [F6] `reviews/repository/run.repo.ts` — `createAgentRun` writes `source:'local'`.
- [F7] db09602 — `agent_runs.multi_agent_run_id` (FK SET NULL, indexed); `multi_agent_runs.pr_id` ON DELETE CASCADE.
- [F8] `db/schema/knowledge.ts:22-50` — `memory` has no unique key on `sources`.
- [F9] `evals/composition.ts:54` — runBounded via PQueue; `BoundedRunner` is at `evals/application/ports.ts:164`.
- [F10] `platform/config.ts:33-36` — the `REVIEW_MAP_CONCURRENCY` env pattern.
- [F11] `reviews/repository/review.repo.ts:52-59` — `evalCaseIdsByFinding` (private).
- [F12] The RunTraceDrawer folder is self-contained; its only consumer is `PrDetailView.tsx:23,125`.
- [F13] EvalCaseButton's only consumer is `FindingsPanel.tsx:11,111`.
- [F14] RunReviewDropdown's only consumer is `PrDetailHeader.tsx:5,84`.
- [F15] `vendor/ui/nav.ts:21-39`; `app-shell/helpers.ts:28` already maps `/multi-agent`.
- [F16] `lib/hooks/reviews.ts:180` already types `{finding, memoryId?}`.
- [F18] `e2e/flows/09-*.json` and `11-*.json` click "Run Review" → an agent item.
- [F20] `server/test/composition.test.ts:21` asserts the exact list of module keys.
## Mirrors
- `server/src/modules/evals/composition.ts` — runBounded wiring.
- `server/src/modules/repo-intel/infrastructure/repository.ts:42` — the advisory-lock SQL.
- `client/src/app/eval/page.tsx` + `helpers.ts` — a thin page that resolves searchParams.
- `pr/PrDetailView` — hosting the drawer; `pr/FindingCard` — the finding-detail layout.
## Skill map (from routing.json)
| Step | Files | Skills | Key rules |
|---|---|---|---|
| S1–S4 | `server/src/modules/reviews/**`, `platform/config.ts` | onion-architecture, typescript-expert, security, zod | rings; schemas on the route; ports, not Container |
| S2–S4 | `reviews/routes.ts`, `reviews/http/**` | fastify-best-practices | schema-first; response schemas |
| S5–S9 | `client/src/**` | frontend-ui-architecture, react-best-practices, typescript-expert, security | thin routes; data via lib/hooks; strings in messages |
| S7–S9 | `client/src/app/**` | next-best-practices | async searchParams |
| S8 | `vendor/ui/nav.ts` | — (vendored; the spec allows this edit) | one group only |
## Risks
- R1 Shared intent pre-work under parallel runs → keep the one `RunLogger` fan-out and the batch intent abort.
- R2 SQL `avg`/`sum`/`count` come back as strings or bigint → cast (`::float8`, `::int`) or use `Number()`.
- R3 Concurrent Learn → the lock, the select and the insert run in one tx.
## Notes for reviewers
- Missing tests are an accepted gap the user decided, not a FAIL. ACs are verified by gates + manual AC42.
- Architecture: no new module; nothing in forbidden paths. Security: every new query is workspace-scoped; no finding text in logs.
