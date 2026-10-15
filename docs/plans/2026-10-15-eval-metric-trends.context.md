# Context pack: Eval metric trends
Mockups (UI steps), dir `/tmp/claude-1000/-home-ypodop-IdeaProjects-dev-digest/9fd29b4f-c988-4525-ad1a-28e3ab726eb9/images/`: `3.png` [M3] overview · `4.png` [M4] agent view · `5.png` [M5] picker open. Icons (`vendor/ui/icons.tsx`): agent `Cpu`, back `ChevronLeft`, trend `TrendingUp`, period `Calendar`, runs `History`, run `Play`.

## INSIGHTS that apply
- [I-s68] `server/INSIGHTS.md:68` "a mismatch … becomes 500 internal_error … → build response schemas from the @devdigest/shared contract" → trend max 100 first
- [I-s78] `:78` "passes the array INDEX as the new optional 2nd param … → (r) => mapper(r)"
- [I-s79] `:79` "pnpm typecheck never checks test/ files … run the tests that fake it"
- [I-s90] `:90` "set createdAt explicitly whenever a test depends on ORDER BY" (here startedAt)
- [I-c19] `client/INSIGHTS.md:19` "ToastProvider … renders a role="status" live region … → scope with within(…)"
- [I-c20] `:20` "user-event's hover dispatches mouseout with relatedTarget=null" → test via focus
- [I-c27] `:27` "the vendored Modal has no Escape/keydown handling and vendor/ui is off-limits" → own Escape handler
- [I-c29] `:29` "Select render ~43px tall … → alignItems:stretch" (check heights in the app)
- [I-c34] `:34` "new dropdowns import @/components/select; tests pick values with pickOption(user, combobox, label) … query options via screen"
- [I-c37] `:37` "Badge's props are a closed list … → wrap … in a plain <span title=...>"
- [I-c44] `:44` "URL state changes go through router.replace(<helper>Href(...)) … no view reads useSearchParams"
- [I-c47] `:47` "every query key comes from the factories … never write a key literal"
- [I-c56] `:56` "there is no --danger … → use --crit"
- [I-c58] `:58` "build aria-activedescendant widgets from <div role=listbox>/<div role=option tabIndex={-1}>"
- [I-c62] `:62` "useFormatter().dateTime without a configured timeZone logs ENVIRONMENT_FALLBACK"
- [I-c65]/[I-c68] `:65`,`:68` "add it under vendor/shared/constants/ (both copies)"; "Importing any value pulls zod … into that route"
- [I-c77] `:77` "a Response instance can be read only once … → register a factory"
- [I-c81] `:81` "a position:absolute descendant with NO positioned ancestor (e.g. srOnly …) … → position:relative"
- [I-c83] `:83` "importing the @devdigest/ui barrel pulls recharts into the RSC graph" → not in page.tsx

## Verified facts
- [F1] `server/src/modules/evals/application/eval-runs-service.ts:141-157`: dashboard = `finishedRuns(20)`, latest=[0], previous=[1]
- [F2] `…/infrastructure/run-queries.ts:35-48,111-130`: ordered `started_at desc, id desc`; FINISHED = completed|failed
- [F3] `…/http/routes.ts:89-95,132-139`: the list route has `EvalRunListQuery`, the dashboard route has no querystring; 422 `validation_error` (`src/http/error-handler.ts:61`)
- [F4] `server/src/db/schema/eval.ts:100`: index `(agent_id, started_at)`
- [F5] `…/application/run-executor.ts:27-28,56`: injectable `now`
- [F6] `server/test/eval-run-executor.test.ts:129-166`: FakeStore implements EvalRunsStore
- [F7] `eval-pipeline.ts:163-165,255`: `limit` 1–100, `trend.max(20)`
- [F8] `client/src/lib/hooks/evals.ts:122-129,201-207`: EvalsTab (`EvalsTab.tsx:26-27`) calls them without a period
- [F9] no e2e/MCP reads `/eval`
- [F10] `client/src/components/eval-metrics/helpers.ts:19`: `deltaPoints` = difference of the shown percents; `metricOf`/`sparkSeries` are not exported yet
- [F11] `client/src/components/select/Select.tsx:17-34`: no icon prop; options already hold a Check svg
- [F12] `client/src/lib/format-usage.ts:18`: `formatUsd(0.23)`="$0.23", null → "—"
- [F13] `client/src/test/pseudo.ts` `strayText` (AC21)
- [F14] `Agent.model` (`knowledge.ts:423`), `useAgents()`

## Specs per step
- Service (S3): no period → today's path. With a period: `Promise.all([finishedRuns(…,2), finishedRuns(…,100, since), caseIds])`; trend = `trendOf(list,100)`
- Chart (S8): props `{runs, period}`. Header: TrendingUp + "METRIC TREND" on the left, legend with line swatches on the right. Bottom = 0.6, or floor(min×10)/10 ≥ 0 (FR6); ticks every 0.1 as `toFixed(1)`; a dot only on each series' newest defined point. One button per run column, roving tabIndex, ←/→/Home/End, Escape hides, aria-label = tooltip text, `aria-describedby`. The active run gets a guide line, dots and `role="tooltip"`: v, stamp, 3 percents or "—", cost or "—", "Failed"
- Header (S10): "All agents"; name with ellipsis + `title`; mono model badge, hidden when unknown; subtitle R = runs list length ("100+" at the limit); configure link in the title block. Toolbar, `alignItems: stretch`: picker `icon="Cpu" chevron="down"`, period `icon="Calendar" chevron="none"`, Run eval (Play, "Running x / N")
- Dates: local `YYYY-MM-DD HH:mm`; fixtures `new Date(2026,4,29,9,14)`

## Mirrors
- `server/test/eval-dashboard.it.test.ts:20-64`: Testcontainers app + `insertRun`
- `server/src/vendor/shared/constants/skills.ts` + `client/src/app/skills/helpers.ts:1`: zod-free subpath
- `AgentEvalView.test.tsx`: mockFetch, `next/navigation` mock

## Skill map (routing.json)
| Step | Files | Skills | Key rules |
|---|---|---|---|
| S1 | `*/src/vendor/shared/**` | drift_check, zod | both copies; z.enum |
| S2–S3 | `server/src/modules/evals/**` | onion-architecture, typescript-expert, security, fastify-best-practices (http/), zod | pure domain; schema-first; workspace scope |
| S4–S11 | `client/src/**` (not vendor) | frontend-ui-architecture, react-best-practices, typescript-expert, security | colocate; data via lib/hooks; strings in messages |
| S4, S6–S11 | `client/src/app/**` | next-best-practices | thin server page, async searchParams |
| tests | `client/**/*.test.tsx` | react-testing-library | by role/label |

## Risks
- Trend max left at 20 → 500 (S1 first; S3 it-test with 25 and 100 runs)
- Evals tab regression → shared components/keys untouched

## Notes for reviewers
- Architecture: days in domain, clock in application, `gte` in infrastructure · Security: zod enum (422), workspace filter kept
