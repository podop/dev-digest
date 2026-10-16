# Development Plan: Agent Performance dashboard + agent Stats tab
Packages: server, client, shared · Base: feat/agent-performance@b6fac37 · Spec: specs/2026-10-16-agent-performance.md
Context pack: docs/plans/2026-10-16-agent-performance.context.md
Execution: multi-agent, 4 implementers, 3 waves (user)
Paths: `perf/` = `server/src/modules/performance/`; `ap/` = `client/src/app/agent-performance/_components/AgentPerformanceView/`; `ed/` = `client/src/app/agents/[id]/_components/`; `am/` = `client/src/components/agent-metrics/`

## Goal
`/agent-performance` and agent `?tab=stats` from one read-only aggregation of runs + findings (1d / 30d / custom); costs are estimates; a dashboard row equals the agent's Stats tab.

## Out of scope
- Spec §3; migrations; MCP / reviewer-core; new tests + e2e (user → backlog [TB])

## Decisions
- ≤ 5 implementers, disjoint files, contracts in W1; no new tests, minimal edit of an existing test an intended change breaks [I8]; review architecture-reviewer → plan-verifier, fix loop ≤ 2 rounds / ≤ 2 subagents — user

## Planner decisions — for user review
- P1 New onion module `performance` owns both routes — [F4][F6]
- P2 Repo returns per-run facts + grouped finding counts; pure domain folds them; stats = same pipeline for one agent → AC10 by construction — [R1]
- P3 Period rules in the querystring schema (`superRefine`) → 422 `validation_error` — [I6][F5]
- P4 `CostSegment.runs` = priced runs in the segment
- P5 "No agents yet" only when no current agent AND `summary.runs = 0`
- P6 Client span check on local-midnight instants (`to − from ≤ 366 × 24 h`); "start in the future" is form-only
- P7 Stats 404 → editor load-error copy `agents.editor.loadErrorTitle/Body` — [F8]
- P8 sort/dir/period via `router.replace`; open row = local state — [C1]
- P9 Edit vendored `nav.ts` (GLOBAL only); keep `StatPoint`

## Steps
### S1 — Shared contracts [shared]
- Files: M `server/src/vendor/shared/contracts/observability.ts`, `…/productionize.ts`; then `cp -r server/src/vendor/shared/. client/src/vendor/shared/`
- Change: observability: add `PeriodInfo`, `AgentPeriodMetrics`, `CostSegment`, replace `AgentStats`; productionize: `AgentPerfRow`/`AgentPerf` import them from `./observability.js`, drop `PerfCostSegment`. Per §7; `.nullable()` not `.optional()`
- Rules: [I2][I3] · Covers: AC8, AC10 · Tests: [TB]
- Done when: `./scripts/check-shared-drift.sh && (cd server && pnpm typecheck) && (cd client && pnpm typecheck)`

### S2 — Domain [server]
- Files: A `perf/domain/{constants,period,metrics}.ts`
- Change: `MIN_DECISIONS` 5, `MAX_CUSTOM_SPAN_DAYS` 366, presets 24 h / 720 h. `resolveWindow(q, now) → {key, from, to, toInclusive}`, `toPeriodInfo`; `agentMetrics` (FR2/FR3, §7 invariants), `summarize` (FR6), `mostActive` (EC9), `costByAgent`, `costByModel` (FR7), `roundMoney` (6 dp), `byName` — [I5]
- Covers: AC2, AC3, AC6, AC7, AC9, AC11 · Tests: [TB]
- Done when: `cd server && pnpm typecheck && pnpm arch:check`

### S3 — Port + repository [server]
- Files: A `perf/application/ports.ts`, `perf/infrastructure/repository.ts`
- Change: `PerformanceReader`: `listAgents`, `findAgent`, `countedRuns(ws, win, agentId?)`, `findingCounts(ws, win, agentId?)`. One filter: workspace, status done/failed/cancelled, source local/ci, `ran_at >= from`, `<= to` (preset) / `< to` (custom), optional agent. Findings ⋈ reviews ⋈ agent_runs (`reviews.run_id`), GROUP BY run `agent_id`, `count(*) filter (…)::int` [F3]. SELECT only
- Rules: [I1][R2] · Covers: AC1, AC4, AC5, AC8, AC11, AC13 · Tests: [TB]
- Done when: `cd server && pnpm typecheck && pnpm arch:check && pnpm lint`

### S4 — Use case, routes, wiring [server]
- Files: A `perf/application/performance-service.ts`, `perf/http/{schemas,routes}.ts`, `perf/composition.ts`; M `server/src/modules/{index,composition}.ts`, `server/test/composition.test.ts` (add `'performance'`), `server/README.md` (API map)
- Change: `PerformanceService({ reader, clock })`: `overview` = row per current agent (0 runs too) + deleted row if null-agent runs, name order, summary, segments; `agentStats` = `findAgent` or `NotFoundError`, same row builder + `costByModel`. `PeriodQuery` (default 30d, `z.string().datetime({ offset: true })`, superRefine §7). `GET /agents/performance`, `GET /agents/:id/stats` (`IdParams`); responses = shared schemas; handler `getContext` → service; no LLM/job/write
- Rules: [I2][I6][I7]; NFR4 · Covers: AC6, AC10, AC12–AC15, AC33 · Tests: [TB]
- Done when: `cd server && pnpm typecheck && pnpm lint && pnpm arch:check && pnpm exec vitest run test/composition.test.ts --reporter=dot`

### S5 — Period lib + hooks [client]
- Files: A `client/src/lib/stats-period.ts`, `client/src/lib/hooks/performance.ts`; M `client/src/lib/hooks/{keys,index}.ts`
- Change: `StatsPeriod` (preset | custom YYYY-MM-DD); `resolveStatsPeriod` (invalid → 30d), `customRangeError` (P6), `periodApiQuery` (local midnights, EC14), `periodSearch`, `formatPeriodRange` [C7], `agentStatsHref`. `useAgentPerformance(p)`, `useAgentStats(id, p)`: key = URL period, ISO built in `queryFn`; no `placeholderData`/polling
- Rules: [C2] · Covers: AC17, AC18, AC23, AC28 · Tests: [TB]
- Done when: `cd client && pnpm typecheck && pnpm lint`

### S6 — Shared UI + copy [client]
- Files: A `client/src/components/stats-period-picker/` (index, PeriodPicker.tsx, styles); A `am/` (index, StatCard, AcceptRateText, RunBreakdown, CostBreakdownList, EstimateNote, helpers, styles); M `client/messages/en/agentPerformance.json` (replace leftovers: `period.*`, `metrics.*`, `breakdown.*`)
- Change: PeriodPicker = Select (Calendar) + custom form (2 labelled `TextInput type="date"`, inline errors, Apply disabled) + label (FR11). `am/`: `formatDurationS`/`formatPercent`/`sharePercent`; FR13 accept text, FR15 breakdown, FR17 list (`CostText`) + note; presentational
- Rules: [C5][C6][C9] · Covers: AC17, AC18, AC20, AC22, AC24, AC31, AC32 · Tests: [TB]
- Done when: `cd client && pnpm typecheck && pnpm lint`

### S7 — Dashboard + nav [client]
- Files: M `client/src/vendor/ui/nav.ts`; A `client/src/app/agent-performance/page.tsx`; A `ap/` (index, View, helpers, styles, `_components/{SummaryCards,AgentTable (+AgentRow),CostBreakdown}/`); M `agentPerformance.json` (`dashboard.*`)
- Change: nav `agent-performance` (Activity) between multi-agent and ci-runs [F9][C3][C4]. Page → `resolveStatsPeriod` + `resolveSort` → View [C1][C8]. `sortRows` (FR14). §9 states + P5 + NFR8; FR12 cards; FR13 table, `<button aria-sort>` headers, row toggle [C10]; View `Link` → `agentStatsHref`
- Covers: AC16, AC19–AC24, AC26–AC32 · Tests: [TB]
- Done when: `cd client && pnpm typecheck && pnpm lint`

### S8 — Stats tab [client]
- Files: M `client/src/app/agents/[id]/page.tsx`, `ed/AgentEditorView/{AgentEditorView.tsx,constants.ts}`, `ed/AgentEditor/{constants.ts,AgentEditor.tsx}`; A `ed/AgentEditor/_components/StatsTab/`; M `client/messages/en/agents.json` (`editor.tabs.stats`), `agentPerformance.json` (`statsTab.*`), `client/README.md` (route map)
- Change: page resolves `period/from/to` → View → Editor → StatsTab; `stats` between evals and ci. StatsTab: `useAgentStats`; picker → `router.replace`; skeleton; 404 → P7; error + Retry; `runs = 0` → empty; else 5 StatCards (FR18) + breakdown + model list + note
- Covers: AC25–AC27, AC29, AC31–AC33 · Tests: [TB]
- Done when: `cd client && pnpm typecheck && pnpm lint`, then `./scripts/gates.sh --integration`

## Execution
- Mode: multi-agent — 2 packages + contracts, ~45 files
- W1: I1 = S1, S5, S6 · W2: I2 = S2–S4 (server) ∥ I3 = S7 (client), disjoint · W3: I4 = S8
- Each wave ends with `./scripts/gates.sh` (`--integration` after W2 and at the end)

## Contracts & migrations
- S1 only; no migration

## Verification
- `./scripts/gates.sh --integration`; drift check; manual AC33 (seed + mock review [I9]), AC15 (throwaway DB [I10])
- Review risk: high (shared contracts, aggregation invariants)

## Open questions / assumptions
- [TB] incl. AC30 e2e — default: later test-writer pass
- Server + browser share a TZ (local-first)
