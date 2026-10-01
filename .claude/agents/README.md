# Agents

Project subagents for DevDigest. Each `*.md` here (except this README) is one agent:
YAML frontmatter (name, description, model, tools) + its system prompt. The agent file
is the source of truth — this README is only the map. Project agents override
same-named agents in `~/.claude/agents/`.

## Catalog

| Agent | Role | Model | Writes files? | Input | Output |
|---|---|---|---|---|---|
| [specreator](specreator.md) | Writes the spec: design/gap analysis, questions to the user, traceable ACs. Main session: `claude --agent specreator` | opus (effort high) | spec files only (`<module>/specs/`, root `specs/`) | request + design sources | `<date>-<slug>.md` spec · `Status: ready-for-planning` |
| [researcher](researcher.md) | Finds facts in the repo or outside, with evidence | sonnet | no | a concrete question | Research report · or *Clarification needed* |
| [implementation-planner](implementation-planner.md) | Checks requirements, recommends, asks single/multi-agent, plans. Main session: `claude --agent implementation-planner` | opus (effort high) | `docs/plans/` only (2 new files) | spec (or a small task) | `docs/plans/<date>-<slug>.md` + `.context.md` · short summary |
| [implementer](implementer.md) | Executes an approved plan, verifies own diff | sonnet (effort high) | yes | `docs/plans/*.md` (or inline plan) | code + tests + Implementation Report |
| [test-writer](test-writer.md) | Writes tests red-first or backfill, never production code — **paused** (not used by `/implement`) | sonnet (effort high) | tests/fixtures only | plan (+ spec, reports), mode | tests + Test Report |
| [architecture-reviewer](architecture-reviewer.md) | Checks the diff against architectural boundaries | sonnet (effort high; opus on `--opus-review`) | own report in `.devdigest/review/` | branch diff (+ plan base) | short Architecture Review · PASS / BLOCK / INCOMPLETE |
| [plan-verifier](plan-verifier.md) | Checks code against every plan item and acceptance criterion | sonnet (effort high; opus on `--opus-review`) | own report in `.devdigest/review/` | plan (+ spec, reports), mode full/delta | short Plan Verification · PASS / FAIL / INCOMPLETE |
| [delta-reviewer](delta-reviewer.md) | Fix rounds: re-checks findings, regressions and architecture on the delta only | sonnet (effort high) | own report in `.devdigest/review/` | plan, previous reports, delta label | short Delta Review · PASS / FAIL / ESCALATE |
| [doc-writer](doc-writer.md) | Documents implemented features, with diagrams | sonnet (effort medium) | README.md, docs/** only | plan / reports / notes | docs + Documentation Report |

Security review is **not** in this set — a separate agent (not built yet).

## Pipeline

Three manual phases, each in its own session; artifacts pass by path.

```
1. claude --agent specreator          request + designs ──► <module>/specs/ or specs/<date>-<slug>.md
     │  researcher subagents (parallel) for facts       user approves (Status: ready-for-planning)
     ▼
2. claude --agent implementation-planner   spec ──► requirements check, recommendations,
     │  "single- or multi-agent?"               docs/plans/<date>-<slug>.md + .context.md
     │  spec change requests ──► back to 1      user approves
     ▼
3. /implement docs/plans/<…>.md  (.claude/skills/implement)
     implementer  (single pass | one fresh implementer per wave)  ──► ./scripts/gates.sh
          ▼
     round 1: plan-verifier ∥ architecture-reviewer   (sonnet; opus on --opus-review / high risk)
          │  review-delta.sh save r1 · FAIL/CRITICAL/HIGH ──► one implementer fix brief
          ▼
     round N≥2: delta-reviewer (delta since r<N-1>) · ESCALATE ──► full round again
          ▼ PASS (or max rounds ──► ask the user)
     wrap-up: summary · engineering-insights WRAP-UP · next: doc-writer, /pr-self-review, commit
```

test-writer is paused to save tokens: the implementer writes the tests the plan lists,
and plan-verifier's `Sx.tests` rows check them. Re-enable it as a backfill step between
round 1 and the fix brief (see the skill's Notes).

Agents that write run sequentially so the reviewers read a stable snapshot — the only
exception is the implementers of one parallel wave, which edit different packages. doc-writer's
output is not re-verified by plan-verifier; `/pr-self-review` covers it.

Subagents cannot ask the user and return only their final message, so every hand-off
is a fixed-format artifact; open questions come back in it (`Clarification needed`,
`Open questions / assumptions`, `STATUS: BLOCKED`).

## Token budget

A full feature run (Intent Layer, 2026-09-24) cost ~1.66M subagent tokens: implementer
52 %, plan-verifier 20 %, planner 14 %, architecture-reviewer 10 %. The waste was
repetition, not checks: the same gates ran 2–3× per state, every agent re-read the plan,
specs, three `INSIGHTS.md` and the whole 70-file diff in every round, and long reports
were relayed through the lead session. The rules below keep every check and drop the
repetition. The lead session (caller) follows them when orchestrating:

1. **One gates run per state.** `./scripts/gates.sh` runs drift, typecheck, lint,
   `arch:check` and tests for the changed packages and caches them in
   `.devdigest/gates/<state>.json` (state = HEAD + diff + untracked, `*.md` excluded).
   Agents cite `gates <state>:<id>` instead of re-running; `--show` prints the report.
2. **Hand over paths, not content.** Plan, context pack, previous report, delta label,
   gates state. Never paste a diff, a plan or a report into a delegation prompt.
3. **Short artifacts.** Plan ≤ 8 KB (what to follow) + context pack ≤ 6 KB (what to
   know: applicable INSIGHTS lines quoted with ids, verified facts, skill map). Specs
   (≤ ~15 KB) are read whole only by the planner; plan-verifier reads just their "Out of
   scope", "Contracts" and "Acceptance criteria" sections. Downstream agents read the
   pack instead of whole `INSIGHTS.md` files.
4. **Short hand-backs.** Reviewers write the full tables to
   `.devdigest/review/<plan-slug>/<agent>-r<N>.md` and return ≤ 40 lines (verdict,
   counts, non-PASS rows); implementer ≤ 60 lines. The caller relays only non-PASS rows.
5. **Delta rounds.** After each review round: `./scripts/review-delta.sh save r<N>`.
   The next round gets `diff r<N>` only. Round 1 = both full reviewers (opus); rounds ≥ 2
   = one `delta-reviewer` (sonnet), which escalates to a full round when the delta is
   big or touches contracts, DB, depcruise config or packages.
6. **Skip what cannot find anything.** No import changes and no new files in the delta
   + green `server:arch` → no architecture pass for that round (delta-reviewer records it).
7. **Continue, don't respawn, a reviewer** with SendMessage when it will review the same
   feature again and its context is still small (≲ 150k): its history is a cached
   prefix. Prompt caching is prefix-based, so different agent types never share a cache
   — only a continued agent (or a fork of the lead) reuses one. Implementer fix rounds
   are the exception: a fresh agent with a precise brief (`file:line`, expected
   behaviour) is cheaper than continuing a context of several hundred thousand tokens.
8. **Batch fixes.** Collect all findings of a round (including LOW ones you intend to
   fix) into one implementer brief; one delta round per batch.
9. **Models by task.** opus: specreator and implementation-planner (judgement, run once
   per feature). sonnet: implementer, both reviewers, delta-reviewer, researcher,
   doc-writer; `/implement --opus-review` (or plan `Review risk: high`) puts round-1
   reviewers on opus. No model: gates, drift, snapshots, spec-lint (scripts). Cheaper models cut cost, not always tokens —
   compare `subagent_tokens` in task notifications per run.
10. **Fresh contexts and quiet tests.** A turn re-reads the whole context, so a long
    implementer run costs far more per step than a short one: multi-agent plans split
    steps into waves, one fresh implementer each. Per step the implementer runs only the
    step's tests (`vitest run <file> --reporter=dot | tail`); whole suites only through
    `gates.sh` (`--only <id>` to re-run one), which logs to a file and prints only
    failure tails.
11. **Lead session hygiene.** `grep` INSIGHTS for the relevant paths instead of `cat`
    of whole files; don't re-read files an agent already summarised.

## Agents

### researcher
- **Responsible for:** repo research (where/how/why, traced flows, git history) and
  external research (library docs pinned to our version, advisories). Every claim has a
  `file:line`, commit or numbered source; unverified items go to "Not found / unverified".
- **Not responsible for:** making changes, using skills, recommending beyond the question.
- **Permissions:** `Read, Grep, Glob, Bash, WebSearch, WebFetch`; `Write, Edit,
  NotebookEdit, Skill` disallowed. Bash read-only by prompt.
- **Input:** a question that can be answered yes/no/found; mode repo | external | both.
- **Output:** `# Research: …` report (Answer · Findings · Sources · Not found / unverified).

### specreator
- **Responsible for:** one spec per feature: intake of the design sources the user gives
  (text, Figma exports/screenshots, code, another repo); reading only the touched
  modules' docs and INSIGHTS lines; `researcher` subagents in parallel for facts; a gap
  register (missing states, corner cases, module communication, UX, security NFRs);
  blocking questions first (AskUserQuestion, ≤ 3 rounds), the rest inline with
  defaults; revisions from the planner's spec change requests.
- **Not responsible for:** plans, code, docs, INSIGHTS (exempt from WRAP-UP),
  implementation skills (onion, fastify, drizzle, react, …).
- **Permissions:** `Read, Grep, Glob, Bash, Write, Edit, AskUserQuestion,
  Agent(researcher), WebFetch` — Write/Edit only for spec files, WebFetch only for
  user-given URLs, Bash read-only + `scripts/spec-lint.sh`; all by prompt (no hook).
  Runs as the main session so it can ask the user.
- **Input:** request + design sources; or an existing spec + change requests.
- **Output:** `<module>/specs/<date>-<slug>.md` (one module) or `specs/<date>-<slug>.md`
  (several), English: Goal · Context · Scope · Scenarios · FR · Workflow & communication
  (Mermaid) · Contracts · Data model (logical) · States & UX · Edge cases · NFR ·
  Dependencies & rollout · AC (`Traces`, `Verify`) · Traceability · Design review ·
  Decisions · Open questions. Stable IDs; `spec-lint.sh` clean.

### implementation-planner
- **Responsible for:** checking the spec (plannable, testable, consistent with code /
  INSIGHTS / skills, complete) → blocking questions, recommendations, spec change
  requests; asking single- vs multi-agent; then a Development Plan the implementer can
  follow without guessing: reads the touched packages' `AGENTS.md`, `INSIGHTS.md`,
  `README.md`, `specs/`; maps planned files to skills via
  [`routing.json`](../skills/pr-self-review/routing.json) and reads those `SKILL.md`s;
  checks standing constraints (shared-contract copies, migrations, onion rings, client
  data/i18n rules, do-not-touch list); groups steps into waves.
- **Not responsible for:** writing or editing specs, writing code, running
  tests/scripts, reviewing diffs.
- **Permissions:** `Read, Grep, Glob, Bash, Write, AskUserQuestion` — Write only for the
  two plan files in `docs/plans/` (by prompt), no `Edit`, no `Skill`, no `Agent`.
  Bash read-only by prompt. As a subagent (no AskUserQuestion) it returns
  *Clarification needed* instead of asking.
- **Input:** spec path (or a small, clear task).
- **Output:** `docs/plans/<date>-<slug>.md` (≤ 8 KB: header with `Execution` ·
  Goal · Out of scope · Decisions · Recommendations not adopted · Steps with files,
  rules, `Covers: AC…`, tests, targeted "Done when" · Execution (mode, waves) ·
  Contracts & migrations · Verification + Review risk · Open questions) +
  `<slug>.context.md` (≤ 6 KB); a ≤ 25-line summary; after approval the user runs
  `/implement <plan>`.

### implementer
- **Responsible for:** executing the plan step by step in `server/`, `client/`,
  `reviewer-core/` (and `e2e/` when planned); loading skills per touched file via
  `routing.json`; tests with each step; running package gates (typecheck, lint, tests,
  `arch:check`, `check-shared-drift.sh`); self-checking its own diff against the plan.
- **Not responsible for:** planning or redesign (→ `STATUS: BLOCKED`), architecture or
  security review, commits, writing `INSIGHTS.md`.
- **Permissions:** `Read, Edit, Write, Grep, Glob, Bash, Skill` — no `Agent`, no web,
  no worktree isolation (it would branch from `main`). Forbidden commands and
  do-not-touch paths are listed in the prompt; the most dangerous are also denied in
  settings (below).
- **Input:** approved plan (`docs/plans/*.md` path or inline) and its context pack;
  in a fix round, the plan path plus findings (`file:line`, expected behaviour).
- **Output:** uncommitted code + tests, a gates report for the final state, and a
  ≤ 60-line `# Implementation Report` — STATUS (DONE / PARTIAL / BLOCKED) · Gates ·
  Skills · Steps · Changed files · Deviations · Scenarios (concurrency/caching changes) ·
  Blockers · Insight candidates · For reviewers.

### test-writer
- **Responsible for:** tests in `server/`, `client/`, `reviewer-core/` (e2e flows only
  when planned). Mode `red-first` (before implementer, each test proven red for the
  right reason) or `backfill` (after implementer, for untested items). Expected values
  come from spec/plan/contract, each test states "would fail if …". Skills via
  `routing.json` plus a table for `server/test/**` and `reviewer-core/test/**`; project
  conventions override skill examples (Vitest not `node:test`, `mockFetch` not MSW).
- **Not responsible for:** production code, fixing the bugs its tests reveal (→
  `STATUS: BLOCKED` + "Suspected bugs"), reviews.
- **Permissions:** `Read, Edit, Write, Grep, Glob, Bash, Skill`; write scope (test files,
  fixtures, additive helper changes) and forbidden commands (`vitest -u`, `.skip/.only`,
  installs, state-changing git) are in the prompt.
- **Input:** mode + plan (+ spec, Implementation Report, plan-verifier FAIL rows).
- **Output:** `# Test Report` — STATUS · Tests written (source, would fail if) · Red
  evidence · Verification · Suspected bugs · Not covered · Skills applied · Helpers
  touched · Insight candidates · Next.

### architecture-reviewer
- **Responsible for:** architectural boundaries on changed lines: onion rings and
  dependency-cruiser rules (server, reviewer-core), module wiring, reviewer-core purity
  and public surface, client layer map and server/client boundary, shared-contract
  copies. Deterministic checks first (`arch:check`, typecheck, shared drift, RSC barrel
  grep) as ground truth; judgement only where they don't reach; each candidate verified
  (re-read, re-trace import chain, line in diff, quoted rule, confidence ≥ 80).
- **Not responsible for:** security, lint/style, hook correctness, performance, plan
  compliance, fixes.
- **Permissions:** `Read, Grep, Glob, Bash`; `Write, Edit, NotebookEdit, Skill`
  disallowed (skills read as files). Never `next build` or the baseline command.
- **Input:** branch diff; base from the plan or `git merge-base HEAD main`; `round`
  and a delta label for a later full round.
- **Output:** full `# Architecture Review` in `.devdigest/review/<slug>/arch-r<N>.md` —
  VERDICT PASS / BLOCK / INCOMPLETE · Deterministic checks (cached gates cited) ·
  Findings (severity on the `pr-self-review` scale, rule source, file:line, import
  chain, evidence, confidence, fix) · Pre-existing · Dropped · Not checked · Next;
  returns a ≤ 40-line short form.

### plan-verifier
- **Responsible for:** one row per plan item (`Sx.files/change/tests/done-when/rules`,
  contracts, out-of-scope) and per spec acceptance criterion, each with quoted item,
  method, evidence it read or ran itself, and verdict PASS / FAIL-missing|partial|wrong /
  CANNOT_VERIFY; plus scope check (changed − planned files).
- **Not responsible for:** general review or advice (no "Recommendations"), architecture,
  security, fixes.
- **Permissions:** as architecture-reviewer; may re-run the plan's hermetic "Done when"
  commands; integration tests only with the `run-integration` flag.
- **Input:** plan (required), spec, context pack, Implementation / Test Report
  (pointers, not evidence); mode `full` or `delta` (+ previous report, delta label).
- **Output:** full `# Plan Verification` in `.devdigest/review/<slug>/verify-r<N>.md` —
  VERDICT PASS / FAIL / INCOMPLETE · Plan items · Acceptance criteria · Scope · Commands
  run · Next (delta: re-verified rows + carried PASS IDs); returns a ≤ 40-line short
  form with the non-PASS rows only.

### delta-reviewer
- **Responsible for:** fix rounds after a full review: re-verifies the previous non-PASS
  rows and findings, re-checks PASS rows whose evidence touches the delta, runs one
  adversarial scenario per other caller of changed shared code, applies the
  architecture lens to delta import changes. Replaces both full reviewers for that round.
- **Not responsible for:** the first review of a feature, big or risky deltas (→
  `ESCALATE`: > 15 files, new module/package, shared contracts, DB, depcruise config,
  `package.json`), fixes, security.
- **Permissions:** as plan-verifier; the only file it creates is its report.
- **Input:** plan path, `round`, delta label, previous report paths, IDs being fixed.
- **Output:** `# Delta Review` in `.devdigest/review/<slug>/delta-r<N>.md` — findings
  being fixed · regression checks · architecture on the delta · new findings · commands;
  returns ≤ 30 lines. VERDICT PASS / FAIL / ESCALATE / INCOMPLETE.

### doc-writer
- **Responsible for:** documenting implemented features in the slot the conventions
  assign (package/module README, `<pkg>/docs/`, root `docs/` + README Architecture),
  every claim checked against current code, Mermaid diagrams in the repo's existing
  styles (no C4 syntax), links from README and one "Read when" line per new page.
- **Not responsible for:** `specs/`, `INSIGHTS.md`, plans, ADRs unless asked, code comments.
- **Permissions:** `Read, Edit, Write, Grep, Glob, Bash, Skill` (`mermaid-diagram`);
  write scope in the prompt.
- **Input:** subject + plan / reports / notes.
- **Output:** `# Documentation Report` — STATUS · Changed files · Placement · Claims
  verified · Diagrams · Pointers updated · Gaps · Open questions.

## Shared guardrails

[`../settings.json`](../settings.json) `permissions.deny` applies to every agent and the
main session: `docker compose down -v`/`--volumes`, `biome check --write|--fix`,
`biome format`, `git push`. Command-level bans live there because `disallowedTools:
Bash(...)` in frontmatter removes all of Bash.

## Sources behind the agents

| Source | Rules taken from it | Applied in |
|---|---|---|
| [Sub-agents](https://code.claude.com/docs/en/sub-agents) | `description` = what + when, "use proactively"; `tools` allowlist for least privilege; omit `Agent` to stop nested spawning; `permissionMode` is ignored under auto/acceptEdits; `memory` enables Write/Edit; `skills` preload injects full text; `isolation: worktree` branches from default branch; subagent can't ask the user and returns only its final message | both frontmatters; planner without Edit/memory, Write limited to `docs/plans/` by prompt; no preload, no isolation; fixed output formats; `Clarification needed` / `BLOCKED` |
| [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | the cache matches an exact prompt prefix; cached reads cost a fraction of fresh input | Token budget rule 7: continue a reviewer instead of respawning; no reliance on cross-agent caching |
| [Permissions](https://code.claude.com/docs/en/permissions) | `permissions.deny` applies to subagents, beats allow, matches any subcommand of a compound command | `../settings.json` |
| [Skills](https://code.claude.com/docs/en/skills) · [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) | progressive disclosure (load references only when needed); deterministic steps belong to scripts/data, not model judgement | on-demand skill loading; skill choice via `routing.json`; planner reads `references/` only when a step depends on it |
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | explore → plan → code; give Claude a way to verify and demand evidence; fix root causes, don't suppress errors; independent reviewer in fresh context; nothing outside task scope | planner/implementer split; "Done when" commands; Verification table with exit codes; ban on `@ts-ignore`/`.skip`; review left to separate agents |
| [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (2024-12) | prompt chaining with gates; ground truth from the environment at each step | user approval between plan and code; per-step "Done when" run before the next step |
| [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (2025-06) | delegation states objective, output format, boundaries; large outputs go through files, not the lead agent | Goal / Out of scope / "Not for…"; plan saved to `docs/plans/` and passed by path |
| [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (2025-09) | subagents return a condensed summary (~1–2k tokens); keep context lean | plan size target; no skill preload |
| [Model configuration](https://code.claude.com/docs/en/model-config) | `opusplan`: Opus for planning, Sonnet for execution (main session alias) | opus for planner, sonnet for implementer — by analogy |
| [Anthropic code-review plugin](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md) · [README](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md) | verify each finding separately; confidence threshold; "if you are not certain an issue is real, do not flag it"; skip pre-existing and linter-catchable issues | architecture-reviewer |
| [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions) | bare-name `disallowedTools` removes the tool in every mode; a subagent's `permissionMode` is honoured only under default/dontAsk/plan | architecture-reviewer, plan-verifier |
| [The Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) (2012) · [Fitness functions](https://www.oreilly.com/library/view/building-evolutionary-architectures/9781491986356/ch02.html) · [dependency-cruiser rules](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md) | dependencies point inwards; objective checks first, judgement for the rest | architecture-reviewer |
| [Next.js: Server and Client Boundary](https://nextjs.org/docs/app/guides/server-and-client-boundary) | the compiler catches client code in the server graph, not server code leaking into the client | architecture-reviewer |
| [Google eng-practices: comments](https://google.github.io/eng-practices/review/reviewer/comments.html) · [Conventional Comments](https://conventionalcomments.org) | required vs nit severity labelling | mapped onto the `pr-self-review` severity scale |
| [Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations) · [Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests) | allow "can't verify"; claim needs a quote or is retracted; specific, measurable criteria | plan-verifier (`CANNOT_VERIFY`, quoted items, no generic advice) |
| [NASA SE Handbook](https://www.nasa.gov/reference/systems-engineering-handbook/) · [ISTQB Glossary](https://glossary.istqb.org/) | verification methods (inspection, analysis, demonstration, test); verification ≠ validation | plan-verifier |
| [GitHub Spec Kit `/analyze`](https://github.github.com/spec-kit) · [Kiro Specs](https://kiro.dev/docs/specs) | read-only cross-artifact check that reports gaps, never edits; acceptance criteria one by one | plan-verifier |
| [Common workflows](https://code.claude.com/docs/en/common-workflows) · [Anthropic TDD workflow (2025), via DataCamp](https://www.datacamp.com/tutorial/claude-code-best-practices) | match existing test conventions, cover edge cases; "do not modify the tests" | test-writer |
| [Tautological tests](https://randycoulman.com/blog/2016/12/20/tautological-tests) · [TTDD anti-pattern](https://fabiopereira.me/blog/2010/05/27/ttdd-tautological-test-driven-development-anti-pattern) · [AI tests that don't assert](https://getautonoma.com/blog/ai-generated-tests-pass-but-dont-assert) | expected values from the requirement, not from the code | test-writer |
| [Fastify v5 Testing](https://fastify.dev/docs/v5.8.x/Guides/Testing/) · [Vitest mocking](https://vitest.dev/guide/mocking.html) · [Vitest environment](https://vitest.dev/guide/environment.html) · [TanStack Query testing](https://tanstack.com/query/latest/docs/framework/react/guides/testing) · [next-intl testing](https://next-intl.dev/docs/environments/testing) | `inject` + `close`; `vi.mock` hoisting; per-file env; fresh `QueryClient` with `retry:false`; provider wrapper | test-writer |
| [Write tests](https://kentcdodds.com/blog/write-tests) · [Testing Trophy](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications) · [Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) | typological, not exhaustive, testing (matches `TESTING.md`) | test-writer |
| [Diátaxis](https://diataxis.fr/) · [Docs as Code](https://www.writethedocs.org/guide/docs-as-code/) · [Google dev docs style](https://developers.google.com/style/highlights) | doc types as a lens; docs in git; concise active voice | doc-writer |
| [C4 model](https://c4model.com) · [Mermaid C4 (experimental)](https://mermaid.js.org/syntax/c4.html) · [GitHub discussion #197898](https://github.com/orgs/community/discussions/197898) | C4 zoom levels via flowchart subgraphs; no Mermaid C4 syntax on GitHub | doc-writer |
| [Nygard: Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) (2011) · [MADR](https://adr.github.io/madr/) | ADR format — only on request | doc-writer |

Project rules (forbidden commands, do-not-touch paths, shared-contract sync, migrations,
test naming) come from [`CLAUDE.md`](../../CLAUDE.md) and each package's `AGENTS.md`,
not from the sources above. Not backed by an official source: "Not for …" in agent
descriptions (repo convention from the skills), "test first where practical", the
plan-verifier scope check as a set difference of changed vs planned files, the
architecture-reviewer confidence threshold of 80 (borrowed from the code-review plugin
default), doc-writer's placement table (repo convention), sonnet for the reviewers with an opus
opt-in, and the single- vs multi-agent size thresholds in implementation-planner.
Researched but not adopted: mutation testing with StrykerJS (single-threaded Vitest
runner — at most a manual, per-module check).

## Adding or changing an agent

- Frontmatter must start on line 1 with `name` and `description`, or the file is
  silently skipped; check with `claude plugin validate .claude/agents`.
- A new agents directory is picked up only after a session restart.
- Add a row to the catalog above; keep this file a map — details stay in the agent file.
