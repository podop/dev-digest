# Development Plan: Case Editor — manual eval cases for agents and skills
Packages: server, client · Base: feat/evals@f385adc + uncommitted reviewed work (eval-metric-trends, commit-gate) · Spec: specs/2026-10-15-eval-case-editor.md
Context pack: docs/plans/2026-10-15-eval-case-editor.context.md
Execution: multi-agent (planner default, Open q. 1) · Size: ~11.5 KB, over the 8 KB budget (34 ACs, 2 packages, migration)

## Goal
Authors create cases from scratch and fully edit any case. The editor has a live diff preview and inline checks, on the agent Evals tab and on a new skill Evals tab. Manual agent cases join the agent run. Skill cases run on a chosen host agent with only that skill attached. Metrics and history show on the skill page.

## Out of scope
Spec §3. No MCP or e2e change [F20].

## Decisions
- D1 The create schema does not cap `input_diff` at 200 000. The service throws `patch_too_large` on the stored length, so AC3 holds; §7's "1–200 000" is read as the semantic limit.
- D2 Both run-start routes use ONE limiter built once: `app.rateLimit({max:10, timeWindow:'1 minute', keyGenerator: workspaceId via getContext})`, only if decorated. Per-route `groupId` does not share counters [F2][F3]. Run-all keeps its own config.
- D3 `eval_suite_runs` gains `owner_kind` (CHECK [I-s59]), `skill_id` (FK skills, cascade), `skill_version` and `agent_name text NOT NULL DEFAULT ''`. A backfill UPDATE from agents is hand-appended to the generated SQL [F12]. Also an owner-consistency CHECK. Per-owner partial unique "running" indexes replace `eval_suite_runs_one_running_uq` [F1].
- D4 Skill snapshot = host `AgentRunSnapshot` with `config.skills=[skill]`. The skill comes through a `SkillDirectory` port wired to `c.modules.skills.service.get` [I-s37][F19]. Deletes rely on the FK cascades, so skills-service is unchanged [F10][F11].
- D5 Content checks are pure domain code over `UnifiedDiff`; `parseUnifiedDiff` is injected via the `DiffParser` port [F5].
- D6 An edit is re-checked when it carries `input_diff`, `file` or lines. `content_edited_at` is set only when a content value really differs.
- D7 `RunsTable` gets an explicit `variant:'agent'|'skill'`. It now auto-shows Agent whenever `agent_name` is present [F4].
- D8 `EvalCaseRow`, `DeleteCaseConfirm`, a new `EvalCaseEditor` and `EvalCasesSection` move to `client/src/components/eval-cases/` because both tabs use them (frontend-ui-architecture §1.2). `followedRunId`/`runningRun` move to `eval-run-history`.
- D9 Limits move to the zod-free `constants/evals.ts` and are re-exported; the client imports that subpath [I-c67].

## Steps
SH=`server/src/vendor/shared` EV=`server/src/modules/evals` T=`server/test` C=`client/src` ECS=`C/components/eval-cases` AT=`C/app/agents/[id]/_components/AgentEditor/_components/EvalsTab` ST=`C/app/skills/[id]/_components/SkillEditor/_components/EvalsTab` MSG=`client/messages/en`. Done = `pnpm exec vitest run <args> --reporter=dot` in the package.

### S1 — Shared contracts [server, client]
- Files: M `SH/contracts/eval-pipeline.ts`, `SH/constants/evals.ts`, `SH/index.ts`; copy to `client/src/vendor/shared/`; M `T/eval-contracts.test.ts`, `C/test/eval-fixtures.ts`, `AT/_components/EvalCaseModal/EvalCaseModal.tsx` (null repo/pr_number → `—`)
- Change: spec §7 verbatim, with `EvalOwnerKind` and `EvalCaseOrigin`. Create input: name `trim().min(1).max(120)`, end≥start refine, `Severity`/`FindingCategory` nullish [F17], D1. Add `EvalSkillRunStartInput {agent_id: uuid}`, D9, `EVAL_DIFF_FILES_DETAIL_MAX=50`. Keep `EvalRecentRun` [F16].
- Rules: [I-s68]; both copies + drift check
- Covers: AC5 (shape), AC13 (codes) · Tests: "   " name / end<start / bad severity fail; a 200 001-char diff parses
- Done: `test/eval-contracts.test.ts` + `../scripts/check-shared-drift.sh`

### S2 — Schema, migration, run owner [server]
- Files: M `server/src/db/schema/eval.ts`; A `server/src/db/migrations/0019_eval_case_editor.sql` (+meta) via `pnpm db:generate --name eval_case_editor`; M `EV/infrastructure/{mappers,run-queries,agent-snapshots}.ts`, `EV/domain/types.ts`, `EV/application/{ports,eval-runs-service}.ts`, `T/eval-runs.it.test.ts`
- Change: `eval_cases.content_edited_at` (timestamptz, null). D3, plus idx `(skill_id, started_at)`. Mappers: `agent_id` (null unless the owner is an agent), `origin`, `owner_*`, run owner fields. `AgentRunSnapshot.name`. `NewSuiteRun`/`RunJob` gain `ownerKind`, `skillId`, `skillVersion`, `agentName`.
- Rules: [I-s59] [I-s62] [I-s78] [I-s79] [I-s80]; never edit 0018
- Covers: AC30 (cascades) · Tests: an agent run returns `owner_kind:'agent'`, `skill_id:null`, `agent_name`
- Done: `test/eval-runs.it.test.ts test/eval-contracts.test.ts`; after that `pnpm db:generate` reports no changes

### S3 — Case-content domain [server]
- Files: A `EV/domain/case-input.ts`, `T/eval-case-input.test.ts`; M `EV/domain/{run-input,compare,types}.ts`, `T/eval-domain.test.ts`
- Change: `normalizeCaseDiff(raw, file)` converts CRLF→LF and wraps text with no `diff --git`/`+++ ` line via `buildSingleFileDiff`. `checkCaseContent` checks in FR3 order and throws `ValidationError` + details [I-s29]: `files` ≤50 with exact path match; `ranges` = the file's contiguous new-side runs. `buildManualCase` (FR4). `mergeCaseEdit(stored, patch)` → `{values, recheck, contentChanged}`, 400 on merged end<start, blank `pr_title` → name. `evalTaskLine` drops `#n` when null. `assertComparable` checks the owner.
- Rules: onion §1 (domain pure; tests use the real `parseUnifiedDiff`)
- Covers: AC6, AC3 (unit), AC11 (task line) · Tests: EC1–EC6, EC12, the content-change matrix
- Done: `test/eval-case-input.test.ts test/eval-domain.test.ts`

### S4 — Case use cases, repo, routes [server]
- Files: M `EV/application/{eval-cases-service,ports}.ts`, `EV/infrastructure/{repository,mappers}.ts`, `EV/http/{routes,schemas}.ts`, `EV/composition.ts`, `T/helpers/eval-fixtures.ts`; A `T/eval-case-editor.it.test.ts`
- Change: `create(ws, owner, input, log)`: owner 404 → normalize → check → ≥200 `eval_case_limit` → insert. One info log `{caseId, ownerKind, ownerId, diffLength}`, on from-finding too. `list(ws, owner)`. `update` locks a case of any owner, merges, re-checks (D6) and never clears `content_edited_at`. Owner-generic repository [F6]. Routes POST `/agents/:id/eval-cases` and `/skills/:id/eval-cases`, GET `/skills/:id/eval-cases`, extended PATCH.
- Rules: [I-s68] [I-s46] [I-s23] [I-s12] [I-s21] [I-s91]; schema-first
- Covers: AC1–AC5, AC7–AC13, AC24 · Tests: AC10/AC11 ScriptedLLM recording; AC12 gated run; AC13 throwing LLM + log recorder
- Done: `test/eval-case-editor.it.test.ts test/eval-cases.it.test.ts test/eval-links.it.test.ts`

### S5 — Skill runs [server]
- Files: M `EV/application/{eval-runs-service,ports,run-executor}.ts`, `EV/infrastructure/{run-queries,repository}.ts`, `EV/http/routes.ts`, `server/README.md` (Evals table); A `T/eval-skill-runs.it.test.ts`
- Change: `startSkill`: skill 404 → `host_agent_not_found` → `no_eval_cases` → D4 snapshot → insert (409) → launch. `listSkillRuns`. `tryStart` is owner-aware. FR21: agent reads and run-all use `owner_kind='agent'` [F7]. `loadCase` accepts any owner. Start/end logs add `ownerKind`, `skillId` and `skillVersion`, never the body. POST/GET `/skills/:id/eval-runs` + D2.
- Rules: [I-s22] [I-s44] [I-s71] [I-s57]
- Covers: AC25–AC31 · Tests: AC25 one `### <skill>` block + host prompt/model; AC29 gated
- Done: `test/eval-skill-runs.it.test.ts test/eval-runs.it.test.ts test/eval-dashboard.it.test.ts`

### S6 — Client data layer [client]
- Files: M `C/lib/hooks/{keys.ts,evals.ts,evals.test.tsx}`, `C/components/eval-run-history/{RunsTable.tsx,RunsTable.test.tsx,helpers.ts,index.ts}`, `AT/{EvalsTab.tsx,helpers.ts}`
- Change: `evalKeys.skill/skillCases/skillRuns`. Hooks: `useSkillEvalCases`, `useCreateManualEvalCase(owner)` (quiet), owner invalidation in update/delete [F13], `useSkillEvalRuns`, `useStartSkillEvalRun` (`{agent_id}`), and `useEvalRun` invalidating by `owner_kind`. D7 (skill: `v{skill_version}` + host column). Move the run helpers (D8).
- Rules: [I-c48] [I-c42] [I-c15] [I-c11] [I-c26]
- Covers: AC32, AC33 (data) · Done: `evals.test RunsTable`

### S7 — EvalCaseEditor [client]
- Files: A `ECS/index.ts`, `ECS/EvalCaseEditor/{EvalCaseEditor.tsx,EvalCaseEditor.test.tsx,helpers.ts,helpers.test.ts,useCaseEditor.ts,styles.ts,index.ts}`, `ECS/EvalCaseEditor/_components/{ExpectationFields,InputTabs,DiffPreview,DiscardConfirm}/`; M `MSG/eval.json` (`caseEditor.*`)
- Change: FR9–FR11, FR13, FR14, in new and edit modes. helpers mirror [F5]: `splitPastedDiff(text, file)` → `PrFile[]` + ranges, validation, create/patch builders, error code→field. Preview = `DiffViewer` [F14], 300 ms debounce + `useDeferredValue`, highlighted range. Themed Selects; File is a Select when the diff has headers. Own Escape listener. Focus goes to Name, then back to the opener. Save is disabled while pending. Plain text only.
- Rules: [I-c28] [I-c35] [I-c59] [I-c67] [I-c78]; derive state, no effect sync
- Covers: AC15–AC17, AC19–AC22 (editor parts) · Done: `EvalCaseEditor`

### S8 — Agent Evals tab [client]
- Files: A `ECS/{EvalCaseRow,DeleteCaseConfirm,EvalCasesSection}/` (moved + new, with tests); M `ECS/index.ts`, `AT/{EvalsTab.tsx,EvalsTab.test.tsx,helpers.ts}`, `MSG/eval.json` (`agentEvals.emptyCases/runAllNoCases`, `caseRow.manual/edited`); D `AT/_components/{EvalCaseRow,EvalCaseModal,DeleteCaseConfirm}/`
- Change: the section owns the header (run slot, then "New eval case", disabled at 200 with a tooltip), list states, rows (manual tag on agent rows, edited marker), and the editor + confirm as siblings [I-c39].
- Covers: AC14, AC18, AC19 (row), AC23 (manual) · Tests: stub the GET to change [I-c22] · Done: `EvalsTab EvalCaseRow EvalCasesSection`

### S9 — Skill Evals tab [client]
- Files: M `C/app/skills/constants.ts`, `C/app/skills/[id]/_components/SkillEditor/SkillEditor.tsx`, `MSG/skills.json` (`editor.tabs.evals`), `MSG/eval.json` (`skillEvals.*`), `client/README.md`; A `ST/{EvalsTab.tsx,EvalsTab.test.tsx,helpers.ts,helpers.test.ts,styles.ts,index.ts}`, `ST/_components/HostAgentPicker/`
- Change: FR23/FR24. Tiles = `MetricTiles` over finished skill runs. "Run with" default is derived. Run all is disabled with a reason, shows "Running x / N". `variant='skill'` history.
- Rules: [I-c45] [I-c55] [I-c56] [I-c19]
- Covers: AC21, AC22 (tab), AC32–AC34 · Done: `SkillEditor EvalsTab`

## Execution
- Mode: multi-agent. The change spans 2 packages, contracts, a migration and ~70 files.
- W1: S1, S2 — contracts + DB first (with client shims)
- W2: S3, S4 [server] ∥ S6 [client] — disjoint packages
- W3: S5 [server] ∥ S7 [client]
- W4: S8 [client] (needs S7) · W5: S9 [client] (needs ECS from S8)
- Each wave ends with `./scripts/gates.sh` green (`--integration` in W1–W3).

## Contracts & migrations
- Both `vendor/shared` copies + `./scripts/check-shared-drift.sh`.
- `0019_eval_case_editor` (generated, backfill appended); `cd server && pnpm db:migrate` before manual checks.

## Verification
- Review scope: before W1 run `./scripts/review-delta.sh save ece-base`. Reviewers read `diff ece-base --patch`, only the Files above; older uncommitted work is already reviewed.
- `./scripts/gates.sh --integration` per wave and at the end.
- AC23 manual: migrate, then `LLM_PROVIDER_OVERRIDE=mock ./scripts/dev.sh` [I-s13]. Create a manual case (Security Reviewer), run all, compare. Repeat on a skill tab run.
- Review risk: high (migration, contracts, unique-index concurrency, untrusted diff) → round 1 on opus.

## Open questions / assumptions
1. Execution mode not given — default: multi-agent, 5 waves.
2. NFR8 key — default: workspace id (D2); run-all is not in the shared bucket.
3. The 200-case limit stays count-then-insert (not atomic), as on the from-finding path.
4. `/eval` recent runs keep the live agent name from the join; summaries carry the snapshot.
5. Unused `caseEditor` keys stay. Finding cases show repo/PR read-only next to "From a finding".
6. The client counter counts the pasted text. A server `patch_too_large` after wrapping shows on the Diff field.
