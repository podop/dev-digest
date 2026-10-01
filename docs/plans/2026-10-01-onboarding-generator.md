# Development Plan: Onboarding Generator
Packages: server, client · Base: feat/lab5-sdd@3942722 · Spec: specs/2026-10-01-onboarding-generator.md
Context pack: docs/plans/2026-10-01-onboarding-generator.context.md
Execution: multi-agent (chosen by the user)
Paths: `OB/`=`server/src/modules/onboarding/` · `T/`=`server/test/` · `VS/`=`server/src/vendor/shared/` · `C/`=`client/src/` · `TV/`=`C/app/repos/[repoId]/onboarding/_components/TourView/`

## Goal
On a click, one LLM call over the repo index and ≤ 4 root files writes a five-part tour. Its paths are checked against the index. The tour is stored per repo, flagged stale on index/prompt change, and shown at `/repos/:id/onboarding` with a TOC, Regenerate and Share link.

## Out of scope
Spec §3; e2e; MCP.

## Decisions
- Reuse table `onboarding` (tour in `json`); no migration [F1].
- New facade read `repo-intel.listIndexedFiles(repoId)`: all `file_rank` paths, rank DESC (FR5 folders, FR9) [F7][F8].
- Guard: module-local rule + `wrapUntrusted` (conventions precedent); reviewer-core untouched [F10].
- Loose LLM schema; domain clamps to FR4 (truncate text with "…", drop commands > 200 chars) [F20].
- `maxRetries: 1` = FR1 retry. `ConfigError` → 422 `provider_not_configured`; anything else/abort → 502 `generation_failed` [F5][F6].
- FR8: in-memory per-repo in-flight set (single local API process).
- Diagram: own SVG + pure layout, not `MermaidDiagram` (mermaid can't render in jsdom → AC16; no kind colours) [F17].
- Summary: inline-code splitter, no Markdown (NFR2).
- Route `/repos/[repoId]/onboarding`; nav item in `vendor/ui/nav.ts` (project-context precedent) [F14].
- Delete `server/src/prompts/onboarding.system.md`; replace `messages/en/onboarding.json` [F16].
- User: English only; no model/cost in header; sync 120 s; implementers write tests; no e2e.

## Steps
### S1 — Contracts [server, client]
- Files: A `VS/contracts/onboarding.ts`, `VS/constants/onboarding.ts` (zod-free limits, section ids); M `VS/contracts/knowledge.ts` (drop `Onboarding*`), `VS/index.ts`, client copy, `T/contracts.test.ts`
- Change: §7 `OnboardingTour` + FR4 limits; `OnboardingTourState` union on `status`
- Covers: AC1, AC12 · Tests: valid tour; 13 nodes rejected; old `{sections}` fails
- Done when: drift script 0; `cd server && pnpm exec vitest run test/contracts.test.ts --reporter=dot`; `cd client && pnpm typecheck`

### S2 — Domain [server]
- Files: A `OB/domain/{constants,input,prompt,tour}.ts`, `T/onboarding-domain.test.ts`
- Change: [F18] constants; `input` = excerpts, `scripts` only, env names only, TODO lines, untested files; `prompt` = system (guard + English), wrapped user message [F19], output schema, budget trim; `tour` = `normalizeTour`, `staleness` [F20]
- Rules: [I1] [K1] [K2] [K6]
- Covers: AC2, AC3, AC4, AC9, AC10 · Tests: a case per AC
- Done when: `cd server && pnpm exec vitest run test/onboarding-domain.test.ts --reporter=dot`

### S3 — Index read + adapters [server]
- Files: M `server/src/modules/repo-intel/{types,service}.ts`; A `OB/application/ports.ts`, `OB/infrastructure/{repository,llm-model,repo-files}.ts`, `T/onboarding-infra.test.ts`
- Change: `listIndexedFiles` ([] flag off). Repository: workspace `findRepo` (+`fullName`, `defaultBranch`), `getTour` via `safeParse` else null, `upsertTour`. `LlmOnboardingModel` mirrors intent. `repo-files`: read at sha, throw → null, concurrency 8 [F9]
- Rules: [I2] [I3] [I7] [I10] [K2] [K6]
- Covers: AC12 · Tests: missing/oversize → null; error mapping
- Done when: `cd server && pnpm exec vitest run test/onboarding-infra.test.ts --reporter=dot`

### S4 — Use cases [server]
- Files: A `OB/application/onboarding-service.ts`, `T/onboarding-service.test.ts`
- Change: `getTour(ws, repoId)`, `generate(ws, repoId, log)` per [F21]
- Rules: [I4] [I12] [K4] [K5] [K8]
- Covers: AC5, AC6, AC7, AC13 · Tests (fakes): 409 in flight; failure keeps old tour; one log line without repo text; stale reasons
- Done when: `cd server && pnpm exec vitest run test/onboarding-service.test.ts --reporter=dot`

### S5 — HTTP + wiring [server]
- Files: A `OB/http/{routes,schemas}.ts`, `OB/composition.ts`, `T/onboarding.it.test.ts`; M `server/src/modules/{index,composition}.ts`, `T/composition.test.ts`, `server/README.md`; D `server/src/prompts/onboarding.system.md`
- Change: GET/POST `/repos/:id/onboarding` (`IdParams`, S1 response schemas); wire `resolveFeatureModel(ws,'onboarding')`, `c.repoIntel`, `c.git`, `c.llm`
- Rules: [I2] [I5] [I6] [I8] [I9] [K3] [K7]
- Covers: AC1, AC2, AC5–AC8, AC11–AC13 · Tests: it with fake `repoIntel`/`git`, `llm` stub per provider [F8]
- Done when: `cd server && pnpm exec vitest run test/onboarding.it.test.ts test/composition.test.ts --reporter=dot`; `pnpm arch:check`

### S6 — Hooks + nav [client]
- Files: A `C/lib/hooks/onboarding.ts`; M `C/lib/hooks/{keys,index}.ts`, `C/vendor/ui/nav.ts`, `C/components/app-shell/helpers.ts` + test, `client/messages/en/onboarding.json`
- Change: `repoKeys.onboarding`; `useOnboardingTour`, `useGenerateOnboardingTour(repoId)` (`quietErrorCodes ['*']`, `setQueryData`); Workspace nav item
- Rules: [C3] [C4] [K11]
- Covers: AC14 · Tests: `activeKeyFor` tour path → key, `/onboarding` → none; nav href
- Done when: `cd client && pnpm exec vitest run helpers --reporter=dot` [C8]; `pnpm typecheck`

### S7 — Section cards [client]
- Files: A `TV/_components/{ArchitectureCard,PathList,RunSteps,FirstTasks}/` with tests
- Change: FR12–FR14, §9 card states, EC11 [F22]
- Rules: [C9] [K10] [K12] [K13] [K14]
- Covers: AC16, AC17, AC18, AC22 · Tests: a case per AC
- Done when: `cd client && pnpm exec vitest run ArchitectureCard PathList RunSteps FirstTasks --reporter=dot`

### S8 — Tour screen [client]
- Files: A `C/app/repos/[repoId]/onboarding/page.tsx`, `TV/{TourView.tsx,TourView.test.tsx,helpers.ts,helpers.test.ts,styles.ts,index.ts}`; M `client/README.md`
- Change: page renders `<TourView key={repoId}/>`; header, TOC, §9 states, share, toasts in per-call `mutate` callbacks [F23]
- Rules: [C1] [C2] [C5] [C6] [C7] [C10] [C12] [K9] [K15]
- Covers: AC15, AC19, AC20, AC21 · Tests: a flow per AC
- Done when: `cd client && pnpm exec vitest run TourView --reporter=dot`; `pnpm typecheck`

## Execution
- Mode: multi-agent — 2 packages, contracts, ~35 files.
- W1: S1 · W2: S2 ∥ S6 · W3: S3–S4 ∥ S7 · W4: S5 ∥ S8 (pairs are server ∥ client with disjoint files; both depend only on S1). `./scripts/gates.sh` after each wave (`--integration` at W4).

## Contracts & migrations
- S1: `cp -r server/src/vendor/shared/. client/src/vendor/shared/` + drift check. No migration [F1].

## Verification
- `./scripts/gates.sh` per wave; `--integration` at W4 and end.
- Review risk: **high** (untrusted repo text → LLM → UI, contracts, concurrency gate).
- AC23 manual (real key): `./scripts/dev.sh` → import this repo, wait for the index (`filesIndexed > 0`) → Settings → Feature models: Onboarding Tour provider has a key → open Onboarding Tour → Generate. Each critical/reading/first-task path: `git ls-files | grep -Fx <path>` (folder: `git ls-files <path>/` non-empty). A run step contains `./scripts/dev.sh` or a README pnpm command.
- AC22 by eye at 1280 px: no horizontal scroll.

## Open questions / assumptions
- Folders are allowed only in first tasks (FR4e).
- Both stale reasons → `index_changed`.
- Untested = no indexed `.test.`/`.spec.`/`__tests__/`/`test(s)/` file whose name contains the base name. TODO scan = `getTopFilesByRank(200)`.
- AC13 log line asserted in the S4 unit test; GET ≤ 300 ms in S5 it.
- AC22 in jsdom = style/`title` assertions.
