# Development Plan: Eval Pipeline
Packages: server, client · Base: feat/evals@c836e47 · Spec: specs/eval-pipeline.md
Context pack: docs/plans/2026-10-14-eval-pipeline.context.md
Execution: multi-agent (chosen by the user)

## Goal
Decided finding -> eval case (1 click); background runs of the case set; code-only metrics, history, compare, regression banner (Evals tab, Eval Dashboard).

## Out of scope
Spec §3; e2e; InlineFindingCard action (no agent id).

## Decisions
- Module `evals` [F18]; run table `eval_suite_runs`; `eval_runs` = per-case result; add-only (ctx Data model) [F1][I12]
- Unique idx = one running run/agent, one case/finding [I15]
- Agent delete drops its cases in-tx (like [F10]); runs cascade
- `FindingRecord.eval_case_id` nullish [F15]; server always sets it
- `reviewPullRequest` direct, fixed inputs [F6][F7]; background + PQueue(3) [I5]; raceAbort timeout [I4]; reap/abort in `app.ts` [F9][I26]
- Edit `client/src/vendor/ui/nav.ts` despite client/AGENTS.md: only NAV source [F11]
- `/eval?agent=<id>` per-agent view [C4]; metrics/deltas rounded to 4 dp

## Steps
S=`server/`, T=`server/test/`, EV=`S/src/modules/evals/`, C=`client/src/`, PR=`C/app/repos/[repoId]/pulls/[number]/_components/`, AE=`C/app/agents/[id]/_components/AgentEditor/`, M=`client/messages/en/`. Done = `pnpm exec vitest run <args> --reporter=dot`. Rules: ctx Skill map.

### S1 Shared contracts [server]
- Files: A `S/src/vendor/shared/contracts/eval-pipeline.ts`; M `…/review-api.ts`, `…/shared/index.ts`; copy to client
- Change: §7 shapes + enums; update input optional (name 1-120, lines >= 1); FindingRecord += `eval_case_id`
- Covers: FR19 · Tests: A `T/eval-contracts.test.ts` · Done: same + drift script

### S2 Schema + migration [server]
- Files: M `S/src/db/schema/eval.ts`, `S/src/db/schema.ts`, `T/schema-enums.test.ts`; A migration (`pnpm db:generate --name eval_pipeline`)
- Change: ctx Data model
- Covers: FR3, FR11 · Tests: enum pairs · Done: `test/schema-enums.test.ts test/db-integrity.it.test.ts`

### S3 Domain [server]
- Files: A `EV/domain/{constants,types,scoring,case-builder,compare,dashboard}.ts`
- Change: pure scoring (Glossary), case builder (header [F5]), LCS lineDiff, compare, regression alert
- Covers: FR2, FR9, FR10, FR13, FR15, EC3, EC11, AC12, AC16 · Tests: A `T/eval-domain.test.ts` (AC12 per ctx, AC18 math) · Done: same

### S4 Cases module [server]
- Files: A `EV/application/{ports,eval-cases-service}.ts`, `EV/infrastructure/{repository,mappers}.ts`, `EV/http/{routes,schemas}.ts`, `EV/composition.ts`; M `S/src/modules/{index,composition}.ts`, `T/composition.test.ts`
- Change: 4 case routes (§7), workspace-scoped; + `eval_case_limit`; end < start vs stored -> InvalidInputError `validation_error`
- Covers: FR1-FR5, EC1-EC5, EC16, AC1-AC5, AC8, AC6 · Tests: A `T/eval-cases.it.test.ts` (+ double POST) · Done: same + `test/composition.test.ts`

### S5 Finding link, agent delete [server]
- Files: M `S/src/modules/reviews/repository/{review.repo,mappers}.ts`, `S/src/modules/agents/repository.ts`
- Change: reviewsForPull one IN-query -> eval_case_id; deleteById tx: cases, agent
- Covers: FR17, FR19, AC20, AC22 · Tests: A `T/eval-links.it.test.ts` · Done: same + `test/reviews.it.test.ts`

### S6 Run use cases + executor [server]
- Files: A `EV/application/{eval-runs-service,run-executor}.ts`; M `EV/application/ports.ts`
- Change: start, list, get, reapInterrupted, shutdown; executor per ctx Executor
- Covers: FR6-FR12, FR18, NFR1, NFR2, NFR5, NFR6, EC7-EC10, EC14, AC13, AC36 · Tests: A `T/eval-run-executor.test.ts` (fakes) · Done: same

### S7 Runs infra + HTTP + boot [server]
- Files: M `EV/infrastructure/{repository,mappers}.ts`, `EV/http/{routes,schemas}.ts`, `EV/composition.ts`, `S/src/app.ts`
- Change: 3 run routes, POST rateLimit 10/min [F2]; wiring per ctx; app.ts reap + preClose
- Covers: NFR3, NFR4, AC6, AC7, AC9-AC11, AC14, AC15, AC21, AC23, AC35-AC38, AC40 · Tests: A `T/eval-runs.it.test.ts` (AC37: NODE_ENV=development) · Done: same

### S8 Compare, dashboards, run-all [server]
- Files: M `EV/application/eval-runs-service.ts`, `EV/infrastructure/repository.ts`, `EV/http/{routes,schemas}.ts`, `S/README.md`
- Change: compare (422 `runs_not_comparable`), both dashboards, run-all (202, rateLimit)
- Covers: FR13-FR16, EC12, AC17-AC19 · Tests: A `T/eval-dashboard.it.test.ts` · Done: same

### S9 Demo seed [server]
- Files: A `S/src/db/seed-eval-demo.ts`; M `S/src/db/seed.ts`
- Change: demo PR + patches; Security Reviewer review, 10+ findings (6+ acc, 4+ dis) in hunks; idempotent
- Covers: FR26, AC24, AC39 · Tests: A `T/eval-seed.it.test.ts` (seed x2) · Done: same

### S10 verify:l06 [server]
- Files: A `S/scripts/verify-l06.sh`; M `S/package.json`
- Change: FR27 order; `vitest run test/eval-` (`.it` only if `docker info` ok, else print skipped); stop on first failure
- Covers: FR27, AC25 · Tests: manual · Done: `pnpm verify:l06` -> 0; temp type error -> non-zero

### S11 Hooks + test helper [client]
- Files: A `C/lib/hooks/{evals.ts,evals.test.tsx}`; M `C/lib/hooks/{keys,index}.ts`, `C/test/render.tsx`
- Change: `evalKeys`, hook per route; `useEvalRun` polls 2 s while running, then invalidates; create 409 = success; quiet codes [C3]; render `messages` + `pseudoMessages()`
- Covers: AC28, AC34 · Tests: polling stop, 409 · Done: `hooks/evals`

### S12 Turn into eval case [client]
- Files: A `PR/EvalCaseButton/`; M `PR/FindingCard/FindingCard.tsx` (`extraActions` slot), `PR/FindingsPanel/FindingsPanel.tsx` (agentId), `PR/ReviewRunAccordion/ReviewRunAccordion.tsx`, `M/prReview.json`
- Change: §9 row 1; span tooltip [C8]; link `?tab=evals`
- Covers: FR20, AC26 · Tests: AC26, 422 inline · Done: `EvalCaseButton FindingCard FindingsPanel`

### S13 Shared eval UI [client]
- Files: A `C/components/eval-metrics/` (MetricTiles, helpers), `C/components/eval-run-history/` (RunsTable); M `M/eval.json`
- Change: tiles (whole %, "—", signed pt); RunsTable, optional labelled selection
- Covers: NFR8, AC33 · Tests: helpers, keyboard select · Done: `eval-metrics eval-run-history`

### S14 Evals tab + case modal [client]
- Files: A `AE/_components/EvalsTab/` (+ `_components/{EvalCaseRow,EvalCaseModal}/`); M `AE/AgentEditor.tsx`, `AE/constants.ts`, `C/app/agents/[id]/_components/AgentEditorView/{constants.ts,helpers.test.ts}`, `M/eval.json`
- Change: FR21 + §9; FR22 modal, plain text, confirm as sibling [C9]
- Covers: FR21, FR22, NFR7, NFR9, AC27-AC29, AC32, AC34 · Tests: those · Done: `EvalsTab EvalCaseModal AgentEditor`

### S15 Dashboard page + nav [client]
- Files: A `C/app/eval/page.tsx`, `C/app/eval/_components/{EvalDashboardView,AgentsOverview}/`; M `C/vendor/ui/nav.ts`, `C/components/app-shell/helpers.test.ts`, `M/eval.json`, `client/README.md`
- Change: thin page -> View [C4][C5]; rows, recent runs, Run all; §9 states; NAV `eval`
- Covers: FR23, AC30, AC34 · Tests: states, run all, NAV · Done: `EvalDashboardView AgentsOverview app-shell`

### S16 Per-agent view + compare [client]
- Files: A `C/app/eval/_components/AgentEvalView/` (+ `RegressionBanner`, `TrendChart`, `CompareModal`); M `EvalDashboardView.tsx`, `M/eval.json`
- Change: picker [C18], Run eval, tiles, banner, trend, RunsTable; Compare iff 2 finished
- Covers: FR24, FR25, EC15, AC31-AC34 · Tests: those · Done: `AgentEvalView CompareModal`

## Execution
- Mode: multi-agent (2 packages, contracts, DB, ~70 files)
- W1: S1, S2 · W2: S3, S4 || S11, S12 · W3: S5, S6 || S13, S14 · W4: S7, S8 || S15, S16 · W5: S9, S10
- Client needs only S1. Wave end: `./scripts/gates.sh --integration`

## Contracts & migrations
- S1 (both copies, drift) · S2 add-only migration; `pnpm db:migrate` manual

## Verification
- gates per wave; `pnpm verify:l06`; AC39 manual (seed, 8+ cases, run, edit prompt, rerun, Compare)
- Review risk: high (background concurrency, contracts, DB, untrusted text)

## Open questions / assumptions
1. Error codes lower snake (`eval_case_exists`) like [F3], not UPPER_CASE
2. PATCH shape errors 422 [F3]; end < start 400 (AC8)
3. Rate limit per route by IP (one workspace)
4. AC36 timeout: unit test
5. Run-all includes disabled agents
