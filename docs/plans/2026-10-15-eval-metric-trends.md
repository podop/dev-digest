# Development Plan: Eval metric trends and dashboard mockup parity
Packages: server, client · Base: feat/evals@f385adc · Spec: specs/2026-10-15-eval-metric-trends.md
Context pack: docs/plans/2026-10-15-eval-metric-trends.context.md
Execution: multi-agent (planner default, Open q. 1)

## Goal
Period filter end to end. Trend chart redesign with a tooltip per run (version, date, metrics, cost). The agent view and the overview match [M3]–[M5].

## Out of scope
Spec §3. The Evals tab, the shared `MetricTiles`/`RunsTable` and the keys `metricTiles`/`runsTable`/`agentEvals` stay untouched. No e2e [F9].

## Decisions
- Zod-free `SH/constants/evals.ts` (`EVAL_PERIODS`, `EVAL_PERIOD_TREND_MAX=100`) [I-c65]
- Window = injectable `now` in the service [F5]; repo gets `since`; no migration [F4]
- With period: latest/previous/alert come from an unbounded `finishedRuns(…,2)`, trend from a read bounded by `since` (FR2)
- New /eval-only components, no caller flags (frontend-ui-architecture §1.2, D7)
- `@/components/select` gets `icon` + `chevron` props [I-c34]
- Chart cursor = roving native `<button>`s, one per run [I-c58]
- `E/constants.ts` (`METRIC_COLOR`, `DEFAULT_EVAL_PERIOD`, `AGENT_RUNS_LIMIT=100`) and `E/helpers.ts` (`resolvePeriod`, `evalHref`, `formatRunStamp`)
- Only the /eval message namespaces change; headers are uppercase literals

## Steps
SH=`server/src/vendor/shared/` EV=`server/src/modules/evals/` T=`server/test/` C=`client/src/` E=`C/app/eval/` AV=`E/_components/AgentEvalView/` AVC=`AV/_components/` MSG=`client/messages/en/eval.json`. Done = `pnpm exec vitest run <args> --reporter=dot` in the package.

### S1 Shared contracts [server]
- Files: A `SH/constants/evals.ts`; M `SH/contracts/eval-pipeline.ts`, `SH/index.ts`; copy to `client/src/vendor/shared/`; M `T/eval-contracts.test.ts`
- Change: `EvalPeriod` enum; `EvalRunListQuery.period?`; new `EvalAgentDashboardQuery {period?}`; trend max 100
- Rules: [I-s68] · Covers: AC2, AC5 · Tests: 4 periods ok, `14d` fails; trend 100 ok, 101 fails
- Done: `test/eval-contracts.test.ts` + `../scripts/check-shared-drift.sh`

### S2 Domain [server]
- Files: M `EV/domain/{constants,dashboard}.ts`, `T/eval-domain.test.ts`
- Change: `PERIOD_DAYS`; `periodStart(period, now): Date|null`; `trendOf(list, max = TREND_POINTS)`
- Covers: AC1, AC2 · Tests: 7d exact ms; all → null; 120 → newest 100, oldest first
- Done: `test/eval-domain.test.ts`

### S3 Use cases, queries, routes [server]
- Files: M `EV/application/{ports,eval-runs-service}.ts`, `EV/infrastructure/{run-queries,repository}.ts`, `EV/http/routes.ts`, `server/README.md:153,157`; A `T/eval-period.it.test.ts`
- Change: `since?` on `listRuns`/`finishedRuns`; service `period?`; dashboard `querystring`; list forwards `period`
- Rules: [I-s68] [I-s78] [I-s79] [F6]; keep the workspace filter
- Covers: AC1–AC5, AC22 (manual) · Tests: mirror `T/eval-dashboard.it.test.ts`; `startedAt` relative to now [I-s90]
- Done: `test/eval-period.it.test.ts test/eval-dashboard.it.test.ts test/eval-run-executor.test.ts`

### S4 Hooks + URL state [client]
- Files: M `C/lib/hooks/{keys,evals,evals.test}.ts(x)`, `E/{helpers,helpers.test}.ts`, `E/page{,.test}.tsx`, `E/_components/EvalDashboardView/EvalDashboardView.tsx`, `AV/AgentEvalView.tsx`; A `E/constants.ts`
- Change: keys + hooks take `period?` (without it the URL is unchanged [F8]); unknown → 30d; local `YYYY-MM-DD HH:mm`; page → View → hooks; picker keeps `period`
- Rules: [I-c44] [I-c47] [I-c62] [I-c68] [I-c83]
- Covers: AC6 (URL), EC6 · Tests: URLs ± period; `bogus`; local stamp
- Done: `src/lib/hooks/evals.test.tsx src/app/eval/helpers.test.ts src/app/eval/page.test.tsx`

### S5 Select icon + chevron [client]
- Files: M `C/components/select/{Select.tsx,styles.ts,Select.test.tsx}`
- Change: `icon?` (aria-hidden, trigger + options, testid `select-option-icon`); `chevron?: "updown"|"down"|"none"`
- Rules: [I-c34] [I-c58] · Covers: AC14 · Tests: icons; `none`
- Done: `src/components/select`

### S6 Run cells [client]
- Files: A `E/_components/RunCells/{RunCells.tsx,index.ts,styles.ts,RunCells.test.tsx}`; M MSG
- Change: `MetricBarCell` (bar + %, null → "—"); `PassCell` ("17/20" · "Running x / N" · "Failed" `--crit` [I-c56])
- Covers: AC15, AC17 · Tests: 82 %; null; statuses
- Done: `RunCells`

### S7 Tiles + banner [client]
- Files: A `AVC/AgentMetricTiles/{AgentMetricTiles.tsx,index.ts,styles.ts,helpers.ts,helpers.test.ts,AgentMetricTiles.test.tsx}`, `AVC/RegressionBanner/{helpers.ts,helpers.test.ts,RegressionBanner.test.tsx}`; M `AVC/RegressionBanner/{RegressionBanner.tsx,styles.ts}`, `C/components/eval-metrics/index.ts`, MSG
- Change: FR9 delta = |`deltaPoints`|/100 [F10]; sparkline ≥ 2; banner `{alert, latest, previous}` per FR10
- Covers: AC11, AC12 · Tests: AC11/AC12; flat; no others
- Done: `AgentMetricTiles RegressionBanner`

### S8 Trend chart [client]
- Files: M `AVC/TrendChart/{TrendChart.tsx,constants.ts,helpers.ts,helpers.test.ts,styles.ts}`; A `AVC/TrendChart/{useChartCursor.ts,TrendChart.test.tsx}`; M MSG
- Change: FR5–FR8 (ctx Chart); empty text per period
- Rules: [I-c27] [I-c20] · Covers: AC7–AC10 · Tests: AC7–AC10; a single run
- Done: `TrendChart`

### S9 Agent runs table [client]
- Files: A `AVC/AgentRunsTable/{AgentRunsTable.tsx,index.ts,styles.ts,AgentRunsTable.test.tsx}`; M MSG
- Change: FR13 columns + heading row + Compare; running row disabled; "No runs in this period"
- Covers: AC15, EC9 · Tests: headers; bar; caption
- Done: `AgentRunsTable`

### S10 Header + view wiring [client]
- Files: A `AVC/AgentHeader/{AgentHeader.tsx,index.ts,styles.ts}`; M `AV/{AgentEvalView.tsx,styles.ts,helpers.ts,helpers.test.ts,AgentEvalView.test.tsx}`, MSG
- Change: FR11/FR12 (ctx Header); body: banner, tiles if `latest`, chart, table; independent errors
- Rules: [I-c29] [I-c37] [I-c19] [I-c77]
- Covers: AC6, AC13, AC14, AC18, AC21, AC20 (manual) · Tests: `pickOption`, order, "100+", strayText [F13]
- Done: `AgentEvalView`

### S11 Overview [client]
- Files: M `E/_components/AgentsOverview/{AgentsOverview.tsx,styles.ts,helpers.ts,helpers.test.ts,AgentsOverview.test.tsx}`, `E/_components/EvalDashboardView/{EvalDashboardView.tsx,styles.ts,EvalDashboardView.test.tsx}`; A `…/EvalDashboardView/_components/RecentRunsTable/{RecentRunsTable.tsx,index.ts,styles.ts,RecentRunsTable.test.tsx}`; M MSG
- Change: FR14–FR16; card = one `Link`, name in full contrast
- Rules: [I-c81] [I-c37]; NFR4 · Covers: AC16, AC17, AC19, AC21, AC20 (manual)
- Tests: AC16, AC17, AC19, strayText · Done: `AgentsOverview EvalDashboardView RecentRunsTable`

## Execution
- Mode: multi-agent. Two packages, a shared contract, about 50 files
- W1: S1–S3 · W2: S4–S6 · W3: S7–S8 · W4: S9–S10 · W5: S11. Nothing runs in parallel: the client needs S1, and the client steps share MSG

## Contracts & migrations
- S1, both copies + drift. No migration.

## Verification
- `./scripts/gates.sh --integration` after W1; `./scripts/gates.sh` after W2–W5
- Manual: AC20 in dark and light; AC22 `curl -w '%{time_total}'` on `?period=all` ≤ 0.3 s
- Review risk: high (shared contract)

## Open questions / assumptions
1. Mode not asked: multi-agent
2. Several dipped metrics: "<M> dipped <N>pts" joined by " and ", all bold
3. Running/failed rows on the overview use `PassCell`
4. "All time" with an empty chart: "No finished runs yet"
5. Controls always write `period`; a missing one means 30d
6. Compare icon `GitMerge` (no GitCompare in the registry); "clock" icon = `History`
7. Other banner metrics: sign of `deltaPoints`; a drop under 2 pts reads "down"
