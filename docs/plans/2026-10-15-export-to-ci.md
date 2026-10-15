# Development Plan: Export to CI
Packages: server, agent-runner, client · Base: feat/export-to-ci@db09602 · Spec: specs/export-to-ci.md
Context pack: docs/plans/2026-10-15-export-to-ci.context.md
Execution: multi-agent (chosen by the user)

## Goal
An agent is exported via a 4-step wizard as a PR on `devdigest/ci` (manifest, skills, empty memory, runner bundle, hardened per-agent workflow). A manual Refresh pulls CI results via the GitHub API into `agent_runs` (`source='ci'`) + `ci_runs`, shown on `/ci-runs` and the agent's CI tab.

## Out of scope
- Spec §3 Out of scope; no migration or contract edit beyond the GitHub port [F1]; no new tests (user).

## Decisions
- Multi-agent, 4 implementers (cap 5) — user
- No test writing; existing tests stay green; a test broken by an intended change may be minimally updated — user
- Review: architecture-reviewer, then plan-verifier; fix ≤2 iterations / ≤2 fix subagents, then the user — user
- Simplest path the spec allows; spec security NFRs non-negotiable — user
- Declare `yaml` in server deps; `yaml` + `fflate` (pure) allowed in `ci/domain` — [F10][F11]
- Action pins = this repo's pins [F9]; bundle path from `import.meta.url`, no `config.ts` edit — spec boundaries
- Export skills = linked AND enabled, link order — [F6]
- No new `src/components/*`; CI tab and `/ci-runs` keep own table/banner — spec boundaries

## Recommendations not adopted
- Tests for workflow rules and ingest — user: follow-up

## Steps
### S1 — GitHub port: Actions runs/artifacts [server]
- Files: M `server/src/vendor/shared/adapters.ts`, M `client/src/vendor/shared/adapters.ts` (copy), M `server/src/adapters/github/octokit.ts`, M `server/src/adapters/mocks.ts`
- Change: types `WorkflowRunSummary` {id, run_attempt, head_sha, path, event, conclusion, html_url, repository_id, pr_numbers, created_at}, `RunArtifactSummary` {id, name, size_in_bytes, expired, created_at}; `listWorkflowRuns(repo, workflowFile, {perPage})` (pull_request, completed), `listRunArtifacts(repo, runId)`, `downloadArtifact(repo, id, {maxBytes}) → Uint8Array | null` (null = too big). withRetry+withTimeout; errors keep `.status`; mock returns opts or `[]`/`null`.
- Rules: [I9]; onion §3 ports; drift [F2]
- Covers: FR19, FR20
- Tests: none (user)
- Done when: `cd server && pnpm typecheck && pnpm test:unit`; `./scripts/check-shared-drift.sh`

### S2 — ci domain [server]
- Files: A `server/src/modules/ci/domain/{constants,slug,manifest,workflow,workflow-rules,ingest}.ts`; M `server/package.json`, `pnpm-lock.yaml` (`pnpm add yaml@^2.9.0`)
- Change: constants (branch, PR title, paths, check/artifact names, triggers, pins, limits); `slugify` (FR8); manifest via `AgentManifest.safeParse` + `yaml.stringify` (FR7); `buildWorkflow` per FR9 + `buildPrBody` (EC17); `checkWorkflow(text) → {ok}|{rule}`; `readResultArtifact`, `verifyArtifact`, `githubErrorCode`. Details: context "Rules".
- Rules: [I11][I5]; domain pure; NFR1/2/5
- Covers: FR6–FR9, FR12, NFR1, NFR2, NFR5, AC7, AC8, AC10
- Tests: none (user)
- Done when: `cd server && pnpm typecheck && pnpm lint && pnpm arch:check`

### S3 — agent-runner [agent-runner]
- Files: M `agent-runner/src/{manifest,context,artifact,run,index}.ts`, M `agent-runner/README.md`
- Change: `DEVDIGEST_AGENT` → `<dir>/agents/<slug>.yaml` (slug `^[a-z0-9][a-z0-9-]{0,39}$` else RunnerError), unset = today; artifact `version:"2"` + `commit_sha` (`PR_HEAD_SHA`), `repository`, `repository_id`/`run_id`/`run_attempt` (env int|null), `model`, `manifest_version`, `skills`, `blockers`; trace header via injectable `log` (no env values).
- Rules: [I23][I24]; agent-runner/CLAUDE.md invariants
- Covers: FR16–FR18, NFR3, NFR12, AC21–AC23
- Tests: existing only (update if broken)
- Done when: `cd agent-runner && pnpm typecheck && pnpm test && pnpm build`

### S4 — ci application + infrastructure [server]
- Files: A `ci/application/{ports,export-service,ingest-service}.ts`, A `ci/infrastructure/{repository,mappers,runner-bundle}.ts`
- Change: export + refresh per context "Flows"; repository: installation find/upsert/list (+last run), slug owner, stored (run id, attempt), one-tx `agent_runs`+`ci_runs` insert (duplicate → rollback, not error), runs list scoped by `agent_runs.workspace_id`; `runner-bundle` reads `<root>/agent-runner/dist/index.js` (null if absent).
- Rules: [I2][I6][I7][I8][I10]; FR15: all checks before any GitHub call
- Covers: FR5, FR13, FR15, FR19–FR23, NFR4, NFR6, NFR7, NFR9, AC6, AC14–AC18, AC24–AC31, AC37, AC39
- Tests: none (user)
- Done when: `cd server && pnpm typecheck && pnpm lint && pnpm arch:check`

### S5 — ci http + wiring [server]
- Files: A `ci/http/{routes,schemas}.ts`, A `ci/composition.ts`; M `server/src/modules/{composition,index}.ts`, M `server/test/composition.test.ts`
- Change: `POST /agents/:id/export-ci` (200/201 `CiExport`), `GET /agents/:id/ci-installations`, `GET /ci/runs` (`agent_id` uuid?, `limit` 1–200=100), `POST /ci/refresh` (optional body, `agent_id` uuid?); responses from `@devdigest/shared`.
- Rules: [I1][I3][I4]; fastify schema-first
- Covers: FR5, FR13, FR19, FR23, AC9, AC31, AC38 (manual)
- Tests: M `composition.test.ts` (+`ci`)
- Done when: `cd server && pnpm typecheck && pnpm arch:check && pnpm exec vitest run test/composition.test.ts`

### S6 — CI hooks, CI Runs page, nav [client]
- Files: A `client/src/lib/hooks/ci.ts`, M `lib/hooks/{keys,index}.ts` (append), M `src/vendor/ui/nav.ts` (one item), A `src/app/ci-runs/page.tsx`, A `app/ci-runs/_components/CiRunsView/{CiRunsView.tsx,helpers.ts,styles.ts,index.ts}`, M `messages/en/ci.json`
- Change: `ciKeys`; `useCiRuns`, `useCiInstallations`, `useCiExportFiles` (query POSTing `files`; key agent+repo+triggers+post_as), `useOpenCiPr` (quiet errors), `useRefreshCi`; page per FR24 + §9.
- Rules: [I12][I16][I18][I19][I20][I21]
- Covers: FR24, FR25, NFR8, NFR11, AC20, AC32–AC34, AC36
- Done when: `cd client && pnpm typecheck && pnpm lint`

### S7 — Agent CI tab [client]
- Files: M `agents/[id]/_components/AgentEditor/{constants.ts,AgentEditor.tsx}`, M `AgentEditorView/constants.ts`, A `AgentEditor/_components/CiTab/{CiTab.tsx,helpers.ts,styles.ts,index.ts}`, M `ci.json`
- Change: FR1/FR2 (`useUpdateAgent` `{ci_fail_on}` only); `isOutdated`, relative time; wizard state `{repo?}|null` (mounted in S8).
- Rules: [I14][I15][I20]
- Covers: FR1, FR2, AC1–AC3, AC34
- Done when: `cd client && pnpm typecheck && pnpm lint && pnpm test`

### S8 — Export wizard [client]
- Files: A `CiTab/_components/ExportWizard/{ExportWizard.tsx,useExportWizard.ts,helpers.ts,zip.ts,styles.ts,index.ts}`, A `ExportWizard/_components/{Target,Preview,Configure,Install}Step/{X.tsx,index.ts}`, M `CiTab.tsx`, `ci.json`
- Change: FR3, FR4, FR10, FR11, FR14, §9 rows; Modal + own Esc/focus wrap; `ExportWizardSteps`; zip = reference STORE writer.
- Rules: [I13][I14][I17]; NFR10
- Covers: FR3, FR4, FR10, FR11, FR14, NFR10, AC4, AC5, AC11–AC13, AC19, AC20, AC35
- Done when: `cd client && pnpm typecheck && pnpm lint && pnpm test`

## Execution
- Mode: multi-agent — 3 packages, ~45 files
- W1 (impl 1): S1, S2, S3 — server + agent-runner
- W2 (impl 2): S6, S7 — client — ∥ W1 (disjoint files)
- W3 (impl 3): S4, S5 — server — after W1
- W4 (impl 4): S8 — client — after W2; ∥ W3
- Pairs share one worktree: `./scripts/gates.sh` once per pair; W1 also runs agent-runner commands [F13].

## Contracts & migrations
- GitHub port (S1), both copies + drift check. Migration: none [F1].

## Verification
- `./scripts/gates.sh` after W1∥W2 and W3∥W4; agent-runner typecheck/test/build; `./scripts/spec-lint.sh specs/export-to-ci.md`
- Manual (API 3021, web 3020, DB `devdigest_ci`): wizard files; edited workflow per rule → 422 `details.rule`; AC38 on a demo-repo fork.
- Review risk: high (workflow security, ingest, GitHub writes)

## Open questions / assumptions
- Test backfill (follow-up): unit AC7–AC10, AC21–AC23, AC25–AC30, AC37; integration AC6, AC14–AC18, AC24, AC31, AC39; component AC1–AC5, AC11–AC13, AC19, AC20, AC32–AC35 — default: gates + manual run now
- A1–A5 in the context pack
