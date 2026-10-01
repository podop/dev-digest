# Development Plan: Project Context
Packages: server, reviewer-core, client · Base: feat/lab5-sdd@a53ff75 · Spec: specs/2026-10-01-project-context.md
Context pack: docs/plans/2026-10-01-project-context.context.md
Execution: multi-agent (chosen by the user)
Paths: `PC/`=`server/src/modules/project-context/` · `T/`=`server/test/` · `VS/`=`server/src/vendor/shared/` · `C/`=`client/src/`

## Goal
Browse a repo's spec/doc/insight `.md` files and attach them per repo to agents/skills. Each run reads them at the PR base commit and injects them as untrusted `## Project context`; the trace shows each doc's status and text.

## Out of scope
Spec §3; MCP; e2e.

## Decisions
- `PC` owns `agent_context_docs`/`skill_context_docs`; agents/skills untouched → no version bump [F8].
- reviews → PC via a local port [I3][F15]. reviewer-core `specs` → `{path,text}[]`; `wrapUntrusted`/guard untouched [F4][R3].
- New `GitClient.resolveBaseCommit` [F6]; in-house glob matcher; new `PayloadTooLargeError`→413 [F7]; routes `:id`+`IdParams` [F17].
- EC8 via mutation `scope` [F13]; shared picker in `C/components/context-picker/`; nav edit in `vendor/ui/nav.ts` (precedent 4e7fcfd) [F11].
- User: Q1 no, Q2 yes (warn >16k), Q3 no; implementer writes tests; no e2e.

## Steps
### S1 — Contracts [server, client]
- Files: A `VS/contracts/project-context.ts`, `VS/constants/project-context.ts` (zod-free limits + default glob); M `VS/contracts/{trace,platform}.ts`, `VS/index.ts`, client copy, `C/lib/{hooks/core.ts,hooks/core.test.tsx,types.ts}` [F12], `T/contracts.test.ts`
- Change: spec §7 shapes; `RunTrace.project_context` nullish; drop SpecFile/IndexStatus
- Covers: AC15 · Tests: old+new trace parse
- Done when: drift script 0; `cd server && pnpm exec vitest run test/contracts.test.ts`; `cd client && pnpm typecheck`

### S2 — Tables [server]
- Files: A `server/src/db/schema/project-context.ts`; M `server/src/db/schema.ts`; A `0016_*.sql`
- Change: like `agent_skills` [F8]; see [F18]
- Covers: AC7, AC8 · Tests: in S7 · Done when: `pnpm db:generate` emits CREATE-only; `pnpm typecheck`

### S3 — Git base commit [server]
- Files: M `VS/adapters.ts` (+copy), `server/src/adapters/{git/simple-git,mocks}.ts`; A `T/git-base-commit.test.ts`
- Change: `resolveBaseCommit(repo, baseRef, head): Promise<string|null>`: see [F19]
- Rules: [I2] · Covers: AC10 · Tests: real tmp git [F16]
- Done when: `cd server && pnpm exec vitest run test/git-base-commit.test.ts`

### S4 — Prompt [reviewer-core]
- Files: M `reviewer-core/src/{prompt,review/run,index}.ts`, `reviewer-core/test/prompt.test.ts`, `T/{prompt-log,prompt-structured,prompt-callers}.test.ts`
- Change: [F20]; section `specs_rule` [R1]; `assembly.specs` = wrapped blocks [R2]
- Covers: AC13, AC14, AC27 (manual) · Tests: order, labels, single rule, guard unchanged, escapes
- Done when: `cd reviewer-core && npx vitest run test/prompt.test.ts` + the 3 server tests

### S5 — Domain [server]
- Files: A `PC/domain/{constants,types,paths,globs,run-context}.ts`, `T/project-context-domain.test.ts`
- Change: pure rules of [F21]
- Rules: [I3][I17] · Covers: AC9, AC11 · Tests: AC9/AC11/AC4 cases
- Done when: `cd server && pnpm exec vitest run test/project-context-domain.test.ts`

### S6 — List + preview [server]
- Files: A `PC/application/{ports,project-context-service}.ts`, `PC/infrastructure/{repository,clone-docs}.ts`, `PC/http/{routes,schemas}.ts`, `PC/composition.ts`; M `server/src/modules/{index,composition}.ts`, `server/src/platform/{config,errors}.ts`, `server/src/http/error-handler.ts`, `T/composition.test.ts`; A `T/project-context.it.test.ts`
- Change: env `PROJECT_CONTEXT_GLOBS` [F10]; walker + preview per [F22]; `not_cloned`; cap 500 + `truncated`; codes per §7
- Rules: [I5][I6][I7][I11][I12] · Covers: AC1, AC2, AC4–AC6, AC12, AC17 · Tests: it per AC
- Done when: `cd server && pnpm exec vitest run test/project-context.it.test.ts test/composition.test.ts` [I8]; `pnpm arch:check`

### S7 — Attachments + used_by [server]
- Files: M `PC/{application/project-context-service,infrastructure/repository,http/routes,http/schemas}.ts`, `T/project-context.it.test.ts`, `server/README.md`; A `T/project-context-service.test.ts`
- Change: GET/PUT agent+skill context; loose body (domain owns codes); workspace checks first [I14]; replace in one tx; `used_by` (FR10) + `used_by_agents`
- Covers: AC3, AC7, AC8 · Tests: it AC3/7/8; unit 404s
- Done when: `cd server && pnpm exec vitest run test/project-context.it.test.ts test/project-context-service.test.ts`

### S8 — Run + trace [server]
- Files: M `PC/application/project-context-service.ts`, `PC/infrastructure/repository.ts`, `server/src/modules/reviews/{application/ports,application/run-executor,domain/trace,composition}.ts`, `server/README.md`, `docs/review-flow.md`; A `T/project-context-run.it.test.ts`
- Change: per [F23]
- Rules: [I3][I4]; NFR5 · Covers: AC9–AC12, AC15, AC16 · Tests: it [I1][I16][I20]
- Done when: `cd server && pnpm exec vitest run test/project-context-run.it.test.ts test/skills-executor.it.test.ts`

### S9 — Hooks, nav, screen [client]
- Files: A `C/lib/hooks/project-context.ts`, `C/app/repos/[repoId]/context/page.tsx` + `_components/ContextView/` (DocList, DocPreviewPane, helpers, tests); M `C/lib/hooks/{keys,index}.ts`, `C/vendor/ui/nav.ts`, `client/messages/en/context.json`, `client/README.md`
- Change: hooks (optimistic, rollback, `scope`, `useSkillsContext`); `?doc=` [C14]; §9 states; `.dd-md` [C8][C9]; title tooltip [C6]
- Covers: AC18 · Tests [C1][C10] · Done when: `cd client && pnpm exec vitest run ContextView` [C12]; `pnpm typecheck`

### S10 — Picker + agent tab [client]
- Files: A `C/components/context-picker/` (ContextDocRow, DocPreviewModal), `C/app/agents/[id]/_components/AgentEditor/_components/ContextTab/`; M `AgentEditor.tsx`, `AgentEditor/constants.ts`, `AgentEditorView/constants.ts`, `client/messages/en/agents.json`
- Change: FR11–13/16; missing rows; dnd-kit [C2]; modal as a sibling [C7]; `runTokens` + warning [C13]; toast [C4]; no repo → hint
- Covers: AC19–AC21, AC24–AC26 · Tests: per AC [C3]
- Done when: `cd client && pnpm exec vitest run ContextTab context-picker`

### S11 — Skill tab [client]
- Files: A `C/app/skills/[id]/_components/SkillEditor/_components/ContextTab/`; M `SkillEditor.tsx`, `C/app/skills/constants.ts`, `client/messages/en/skills.json`
- Change: FR14 via ContextPicker + "Serializes as" · Covers: AC22 · Tests: badge, hint, block, PUT
- Done when: `cd client && pnpm exec vitest run SkillEditor ContextTab`

### S12 — Trace drawer [client]
- Files (under `…/pulls/[number]/_components/RunTraceDrawer/`): M `_components/TraceBody/TraceBody.tsx`, `styles.ts`, `RunTraceDrawer.test.tsx`, `client/messages/en/runs.json`; A `_components/ProjectContextBlock/`
- Change: FR15. Old traces are unchanged · Covers: AC23 · Tests: 2 included + 1 missing; old trace
- Done when: `cd client && pnpm exec vitest run RunTraceDrawer`

## Execution
- Mode: multi-agent — 3 packages, contracts, DB.
- W1: S1–S3 · W2: S4–S5 ∥ S9 · W3: S6–S7 ∥ S10–S11 · W4: S8 ∥ S12. Each wave ends with `./scripts/gates.sh --integration`.

## Contracts & migrations
- S1, S3: `cp -r server/src/vendor/shared/. client/src/vendor/shared/` + drift check.
- S2: `0016` via `pnpm db:generate`.

## Verification
- `./scripts/gates.sh --integration` per wave + end. Review risk: **high** (DB, contracts, path input, untrusted text).
- AC27 (manual, real key): repo X, `main`: `docs/architecture.md` ("module `api/` does not import `db/` directly"), `api/users.ts`, `db/client.ts`; PR adds `import { query } from '../db/client'` to `api/users.ts` → `./scripts/dev.sh`, import X, doc listed → attach to Security Reviewer → review → trace `included`, ≥1 finding cites `docs/architecture.md`.

## Open questions / assumptions
- Base commit = merge-base → base tip → else `unreadable`; heads never fetched [F6].
- `doc_type` falls back to `docs`. `used_by` counts every linked skill (literal FR10). With no docs, the log line and `project_context` are omitted.
- Old `context.json` keys dropped; nav item has no g-key.
