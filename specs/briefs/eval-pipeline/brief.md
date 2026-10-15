# Brief — Eval Pipeline (L06 homework) → input for `claude --agent specreator`

Status: brief (not a spec). Prepared 2026-10-14 on branch `feat/evals` @ `c836e47`.

## 0. Output the user requires

- **Spec path: `specs/eval-pipeline.md`** (exact path — required by the course submission
  checklist; overrides the dated-name convention, see specreator Hard rules exception).
- Process: SDD as in L05 — spec (this session) → `claude --agent implementation-planner` →
  `/implement <plan>`.
- **`pnpm verify:l06` does not exist anywhere** (no `verify*` script in any package or
  upstream branch). The user decided: **we create it ourselves**; it is part of this
  feature and its green run is an acceptance criterion.

## 1. Request (homework text, translated; original in Ukrainian)

Build a regression harness for the product's review agents: change a system prompt,
model or linked skill → run evals → see in numbers whether the agent got better or worse.
Cases live in Postgres next to the findings they are born from; the user's accept/dismiss
decisions from L01–L05 are the dataset.

User stories:
1. Create an eval case from a real finding in one click: accepted → "must find X at
   file:line"; dismissed → "must NOT flag Y".
2. See all cases of an agent's set.
3. Run the agent over all cases of the set.
4. See run metrics: **recall / precision / citation_accuracy**.
5. Open run history and compare two runs side by side — "old prompt vs new".

Suggested implementation (from the assignment — treat as requirements/constraints):
- Tables `eval_cases`, `eval_runs` and Zod contracts are "given ready" (they exist, see §3).
- A **"Turn into eval case"** button on FindingCard saves the diff fragment + expectation;
  expectation type from the decision: accepted → `must_find`, dismissed → `must_not_flag`.
- **`POST /agents/:id/eval-runs`** — run the agent on all cases of its set. **Inputs are
  fixed** so runs of different agent versions are comparable.
- **Scoring is code only, no model**: a finding matches when the file is the same and the
  line ranges overlap. recall = share of expected found; precision = share of findings that
  are not noise (dismissed cases count here); citation_accuracy = share of findings that
  survived the grounding gate.
- UI: **Evals tab in AgentEditor** — case list + run history.
- A separate page in the left sidebar — **Eval Dashboard** for agents: latest eval runs.
- Experiment: two runs with old vs new system prompt → metrics visibly move; then break the
  prompt on purpose → precision drops (sensitivity test).

Acceptance criteria from the course:
- the set has **≥ 8 cases**;
- a case is created from a finding in one click; **both** expectation types work;
- changing the system prompt visibly moves recall/precision between two runs;
- scoring makes **no LLM call**;
- `pnpm verify:l06` is green.

Submission (not spec scope, but the spec must make them possible): spec file present;
`verify:l06` green; screenshot of comparing two runs with different prompts; screencast
of the end-to-end flow (case from finding → run → metrics → second run with changed
prompt → comparison).

## 2. Design sources (screenshots in this folder — read each once)

| File | Shows |
|---|---|
| `01-pr-finding-card.png` | PR detail → Review runs → expanded FindingCard; action row Accept · Dismiss · Learn · **Turn into eval case** · Reply to author |
| `02-eval-dashboard.png` | Sidebar "Skills Lab → **Eval Dashboard**". Agent rows: name, model chip, "Last run v7 · date · 17/20 pass", sparkline, RECALL/PREC/CITE %. "Recent eval runs · all agents" table: agent, time, version, 3 metric bars, pass x/y. Button "Run all agents" |
| `03-agent-eval-runs.png` | Dashboard → one agent: header (model, "5 runs on the 20-trace gold set"), agent picker, "30 days" range, **Run eval**; alert banner "Precision dipped 2pts on v7 …"; 3 metric tiles with delta vs previous + sparkline; **Metric trend** line chart; **Recent runs** table with checkboxes (ran at, version, recall, precision, citation, pass, cost) + **Compare** (2 selected) |
| `04-compare-runs.png` | Modal "Compare runs · v6 → v7": recall/precision/citation/cost old → new with deltas; **System prompt diff** (old/new lines highlighted); Close · **Promote v7** |
| `05-agent-evals-tab.png` | Agents → Security Reviewer → tabs Config · Skills · Context · **Evals** · Stats · CI. Eval metrics tiles (recall, precision, citation, traces passed 17/20) + "View full dashboard →"; "Eval cases 3/5 passing"; Run all evals · New eval case; case rows: name, "expected 1 finding, got 1", pass/fail/never-run icon, severity·category chip, run/edit/delete |
| `06-eval-case-modal.png` | Modal "Eval case · stripe-key-leak": name; input tabs Diff / Files / PR meta; **Expected output** JSON (severity, category, title, file, start_line) with "valid JSON" + "Finding skeleton"; "Last run passed · expected 1 finding, got 1 · 1.8s · $0.02"; Run on save · Cancel · Run case · Save |

Mockups go beyond the course minimum (Promote, Run all agents, 30-day range, per-case run,
manual "New eval case", Stats/CI tabs). Specreator: ask which are in scope.

## 3. Current system — facts with sources

Research report: researcher subagent, 2026-10-14 (paths relative to repo root).

**Already given**
- `eval_cases` (`server/src/db/schema/eval.ts`): `workspace_id, owner_kind ('skill'|'agent'),
  owner_id (uuid, no FK), name, input_diff, input_files jsonb, input_meta jsonb,
  expected_output jsonb, notes`. In migration `0000_init.sql`.
- `eval_runs`: **one row per case execution** — `case_id (FK cascade), ran_at, actual_output
  jsonb, pass, recall, precision, citation_accuracy, duration_ms, cost_usd numeric(12,6)`.
- Contracts: `knowledge.ts:35-69` (`EvalPerTrace`, `EvalRun` aggregate with `per_trace`,
  `EvalOwnerKind`, `EvalCase`); `eval-ci.ts` (`EvalCaseInput`, `EvalRunRecord`,
  `EvalRunResult`, `EvalTrendPoint`, `EvalDashboard {cases_total, current, delta, trend,
  recent_runs, alert}`). `expected_output` is `z.unknown()`.
- Client stubs: `messages/en/eval.json` (dashboard strings), `shell.json nav.eval`,
  `agents.json editor.tabs.evals`, `/eval` → active key in `components/app-shell/helpers.ts:36`.
  Missing: `eval` item in `vendor/ui/nav.ts` NAV, `app/eval` route, Evals tab (unknown tab
  falls back to ConfigTab, `AgentEditor.tsx:27`), FindingCard button.
- No eval routes/module/repository on the server; only skill delete cleans skill-owned cases
  (`modules/skills/...repository.ts:224-233`).

**Findings and decisions**
- `findings` (`server/src/db/schema/reviews.ts:80-115`): `file, start_line, end_line,
  severity, category, title, rationale, suggestion, confidence, kind, …`.
- Accept/dismiss = two nullable timestamps `accepted_at` / `dismissed_at`, mutually
  exclusive (`reviews/repository/review.repo.ts:96-118`); routes `POST /findings/:id/accept|dismiss`;
  no un-accept route. A finding can flip state later.
- Finding → agent via `reviews.agent_id` (nullable; null for the seed review / deleted agent).
- Diff source: `pr_files.patch` per file (nullable; hunk-only body) — the fragment cut does
  not exist yet; grounding needs valid `@@` headers. Finding lines are new-side numbers.

**Engine**
- `reviewPullRequest(input)` (`reviewer-core/src/review/run.ts:195`) runs on any parsed
  `UnifiedDiff` with `systemPrompt, model, llm` (+ optional skills, strategy, temperature
  default 0, memory/specs/callers/repoMap/intent). No DB/git/fs → usable with a case's diff.
- Grounding gate `groundFindings` (`reviewer-core/src/grounding.ts:59-90`): keeps a finding
  iff its file is in the diff and its lines intersect a hunk's new-side lines.
  `ReviewOutcome.dropped` is returned **in memory only**; the server persists just the
  string `agent_runs.grounding` ("3/4 passed") → citation_accuracy must be computed during
  the eval run.
- `ReviewOutcome.costUsd`, `tokensIn/Out` available.

**Agent versions**
- `agent_versions(agent_id, version, config_json{provider, model, system_prompt, strategy,
  …, skills[] ids})`; every config change except `enabled` bumps `agents.version`
  (`modules/agents/repository.ts:105-160`; comment "reproducibility for eval").
  `GET /agents/:id/versions[/:version]` exist.
- **Seeded agents have no `agent_versions` row** (`seed.ts:242`; `server/INSIGHTS.md:38`) —
  v1 prompt is not recoverable until the first edit.

**Execution / tests**
- PR review runs are fire-and-forget + SSE (`RunBus`); `JobRunner` (p-queue, concurrency 3,
  timeout 120 s, 2 retries). `agent_runs.source` enum is `local|ci` (no `eval`).
- Tests: `*.it.test.ts` with testcontainers; the LLM is faked via `overrides.llm`
  (`RecordingLLM`, `test/skills-executor.it.test.ts`). Without the override the container uses
  the developer's real keys → paid calls (`server/INSIGHTS.md:21`).
  `LLM_PROVIDER_OVERRIDE=mock` gives a deterministic mock grounded only on seed PR #482.
- Seed: 1 PR (#482), **2 findings, none accepted/dismissed**, 4 agents; only 4 of 9
  `pr_files` have patches (`server/INSIGHTS.md:13`) → seed yields 0 cases.
- Gates: no `verify` script; aggregate is `./scripts/gates.sh` (drift, typecheck, lint,
  server arch:check + test:unit, client test; `--integration` needs Docker).

## 4. Gaps the spec must resolve (ask the user; proposed defaults in brackets)

1. **Run grouping + version.** `eval_runs` is per case; comparing "run v6 vs v7" needs a
   run-level entity (batch) carrying agent id, agent version and a snapshot of the config
   used (system prompt, model, skills). [default: a run entity with config snapshot; per-case
   results stay rows linked to it — needs a migration, "given" schema is extended, not replaced]
2. **`expected_output` shape.** [default: `{kind: must_find|must_not_flag, file, start_line,
   end_line, severity?, category?, title?, source_finding_id}`]
3. **Case input = fragment or whole PR diff?** Fragment = cheap, but precision only sees that
   fragment; whole diff = realistic, more tokens. [default: the finding's file patch with valid
   hunk headers, plus PR title/description as meta]
4. **Snapshot vs reference.** Finding may later flip or be deleted with its review.
   [default: snapshot the finding into the case; keep source id for traceability; one case per
   finding per agent — second click → 409/"already a case"]
5. **Which agent owns a case** when `reviews.agent_id` is null. [default: button disabled with a
   reason]
6. **"Fixed inputs".** Which engine inputs are included (skills? memory, specs, intent,
   repo-intel are live-repo dependent). [default: system prompt + model + strategy + linked
   skills + case diff + meta; temperature 0; no memory/intent/repo-intel]
7. **Scoring definitions** (code only): match = same file && line ranges overlap. Per case:
   must_find hit/miss; must_not_flag violated if any finding overlaps it. Run-level recall,
   precision (what counts as noise — only findings overlapping must_not_flag, or every
   finding not matching a must_find?), citation_accuracy = kept/(kept+dropped); 0/0 values;
   case pass rule.
8. **Execution model** of `POST /agents/:id/eval-runs`: sync vs async (+ progress), per-case
   failure isolation, concurrency, cost, rate limit, an agent with 0 cases, disabled agent.
9. **≥ 8 cases**: from real accept/dismiss on imported PRs vs a seed. [default: both — the
   flow works on real findings; a seeded demo set of ≥ 8 cases for the dashboard/verify]
10. **Compare**: two runs of one agent; metric deltas + system prompt diff (mockup 04).
    "Promote" in or out? [default: out]
11. **Dashboard scope**: all agents + per-agent page with trend/runs/compare (mockups 02–03);
    "Run all agents", 30-day filter, alert banner in or out?
12. **Evals tab** (mockup 05): list + run + history; manual "New eval case" / edit modal
    (mockup 06) in or out? Delete case?
13. **Cleanup**: agent delete leaves orphan cases (no FK on `owner_id`).
14. **`pnpm verify:l06`**: which package owns it and what it runs. [default: one command that
    runs the relevant typecheck/lint/unit + eval-specific tests incl. a test proving scoring
    makes no LLM call (LLM double that fails on any call during scoring) and the ≥ 8 seeded
    cases check; integration tests with Docker optional]
15. **Untrusted text**: case names/expectations copy LLM- and PR-derived text → rendering rules
    (`client/INSIGHTS.md:30` sanitization precedent).

## 5. Modules touched

server (routes, run orchestration, scoring, migration, seed), client (FindingCard button,
Evals tab, Eval Dashboard page + nav, compare view), reviewer-core (consumed as is — grounding
`dropped` already returned), shared contracts in **both** vendored copies. → root `specs/`.
