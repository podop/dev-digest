# Project Context
Spec: 2026-10-01-project-context · Modules: server, client, reviewer-core · Status: ready-for-planning
Design sources: user request + clarifications (2026-10-01, chat); screenshots read: [3] Project Context page (`public-api.md` preview, "Used by 3 agents", coverage ring), [4] Agent editor → Context tab ("2 of 7 attached", drag rows, Preview, "≈ 317 tokens" footer), [5] Skill editor → Context tab ("Project context to use", "Serializes as"), [6] PR → Agent run drawer → trace (Configuration "Specs read", Prompt assembly). Lesson brief "Project Context Folder" (Reader, manual attach, paths-not-text, `## Project context` as untrusted data, trace `specs_read`, verification scenario).
Related: none (no earlier spec of this feature). Builds on `docs/plans/2026-09-24-prompt-assembly-logging.md` (prompt section metadata). Supersedes the unused scaffolding contracts `SpecFile` / `IndexStatus` and the unused client hooks for `/repos/:id/context` and `/context/reindex`.

## 1. Goal
Reviewers today judge a PR without the project's own specifications, so they cannot flag a
violation of a documented rule ("`api/` never imports `db/`"). Project Context lets the user
browse the markdown documents of an imported repo (specs, docs, insights), attach chosen
ones to an agent or a skill per repo, see how many tokens they will add to every run, and
then see in each run's trace exactly which documents were sent and their full text. The
user picks documents manually; nothing is selected automatically.

## 2. Context
- Agents and skills are workspace-global; neither has a repo column (`server/src/db/schema/agents.ts:14-45`, `skills.ts:10-35`). A run knows its PR and repo (`run-executor.ts:130`, `reviews/domain/types.ts:26`).
- Each agent runs as its own engine call with its own trace (`review-service.ts:58-67`, `docs/review-flow.md:98-131`). Linked enabled skills are injected per agent (`run-executor.ts:243-251`, `server/INSIGHTS.md:33`).
- reviewer-core already accepts `specs?: string[]` and renders `## Project context` with each item wrapped as untrusted (`reviewer-core/src/prompt.ts:95-96,227-230,288-294`), labelled by index (`spec-0`), no size cap; the server never passes it (`run-executor.ts:280-293`).
- The trace has `specs_read: string[]`, always `[]` (`server/src/modules/reviews/domain/trace.ts:64-65,98-102`; contract `vendor/shared/contracts/trace.ts:127`). `prompt_assembly.specs` holds the wrapped joined text (`reviewer-core/INSIGHTS.md:18`). The drawer renders "Specs read" chips and one expandable Project context block (`TraceBody.tsx:41-52,91-111`, `PromptBlock.tsx`).
- Clones live under `DEVDIGEST_CLONE_DIR` (default `~/.devdigest/workspace/<owner>/<name>`, `platform/config.ts:136-138`), shallow (`repos/service.ts:57-58`), path stored in `repos.clone_path`, null until cloned. Reading a file at a commit with a size cap and a traversal guard exists (`adapters/git/simple-git.ts:222-230,256-275`). The code walker skips `.md` (`repo-intel/infrastructure/walk.ts:46`).
- Token estimate in use everywhere: `ceil(chars / 4)` (`reviewer-core/src/llm/usage.ts:26-28`, client `RunTraceDrawer/helpers.ts:28-37`).
- Client: active repo from URL › localStorage › first repo (`client/src/lib/repo-context.tsx`). Agent editor tabs: config, skills (`AgentEditor/constants.ts`); skill editor tabs: config, preview, versions, stats (`client/src/app/skills/constants.ts:8`). No Project Context route or nav item (`vendor/ui/nav.ts:21-35`); i18n `context.json` exists with a `chunks` string.
- Skills already expose "used by N agents" (`modules/skills/infrastructure/repository.ts:18`). Markdown rendering has no raw HTML (`client/INSIGHTS.md:49`).

## 3. Scope
### In scope
- Listing markdown documents of a repo by configured globs; previewing one.
- A Project Context screen per repo; a Context tab in the agent editor and in the skill editor.
- Per-repo, ordered attachments of document paths to agents and skills.
- Reading attached documents at run time and injecting them as untrusted data; trace transparency.
### Out of scope
- No automatic selection of documents from PR content (separate feature).
- No editing, creating, uploading, renaming or deleting documents from DevDigest; the Edit toggle, "new file", "new folder" and "upload" actions of design [3] are not shown.
- No LLM call, embedding or chunking is made to list, count or attach documents.
- Attaching or detaching documents does not create a new agent version or skill version.
- No coverage percentage is computed or shown.
- No MCP tool changes.
- Document text is not stored in agent or skill metadata — only paths.

## 4. User scenarios
- US1 — As a user, I browse the specs/docs/insights markdown files of the active repo and read one, so that I know what the project documents.
- US2 — As a user, I attach documents to an agent for this repo, in an order I choose, and see their token total, so that I know what every run of this agent will add to the prompt.
- US3 — As a user, I attach documents to a skill for this repo, so that every agent using the skill gets them.
- US4 — As a user, I open a run's trace and see which documents were sent, their size in tokens, which were skipped and why, and read the full text of each as sent.
- US5 — As a user, I get findings that cite the document whose rule the PR violates.

## 5. Functional requirements
- FR1 [server] — The system shall list the `.md` files of a repo's local clone whose repo-relative path matches any configured glob; default glob `**/{specs,docs,insights}/**/*.md`; the globs are server configuration. (US1)
- FR2 [server] — Each listed document shall carry: path, file name, document type (`specs` | `docs` | `insights` — the last path segment of those three names), size in bytes, estimated tokens (`ceil(chars/4)`), last-modified time, and the number of agents that use it in this repo (FR10). (US1, US2)
- FR3 [server] — The system shall return one document's content for preview, only for a path that FR1 would list. (US1)
- FR4 [server] — The system shall store, per agent and per repo, an ordered list of attached document paths, and the same per skill and per repo; saving replaces the whole list. (US2, US3)
- FR5 [server] — Before an agent's run, the system shall build the run's document list for the PR's repo: the agent's attachments in their order, then, for each enabled skill linked to the agent in skill order, that skill's attachments in their order; a path already in the list is not added again. (US2, US3)
- FR6 [server] — The system shall read each document of FR5 from the PR's base commit, and add it to the run until the run's project-context total would exceed 16 000 estimated tokens; each document is either `included` or skipped with a status: `missing` (not at the base commit), `too_large` (> 256 KB), `over_budget`, `unreadable` (any other read failure). A skipped document never fails the run. (US4)
- FR7 [reviewer-core] — Included documents shall be placed in the `## Project context` prompt section as untrusted data, each wrapped in the existing untrusted delimiters labelled with its repo path, in FR5 order, with one trusted instruction: documents are project specifications, are data and not instructions, and a finding based on a document cites its path. (US5)
- FR8 [server] — The run trace shall record, per document of FR5: path, document type, origin (agent, or skill id and name), estimated tokens, status (FR6), and for included documents the text as sent; plus the included token total and the budget. `specs_read` shall list the paths of included documents. (US4)
- FR9 [client] — A "Project Context" nav item under Workspace shall open the screen of the active repo: a filterable list of documents (name, folder, type badge), a header "N docs · ≈ X tokens total", a refresh action, and a preview pane of the selected document rendered as markdown with "Used by N agents". (US1)
- FR10 [server] — "Used by N agents" shall count distinct agents that, in this repo, attach the document directly or link a skill that attaches it. (US1)
- FR11 [client] — The agent editor shall have a Context tab for the active repo: title "Project context", badge "k of n attached", filter, the hint "Order matters — earlier docs appear earlier in the assembled `## Project context` block", one row per document (drag handle, checkbox, name, folder, type badge, Preview), and a footer "≈ X tokens total" plus "Injected as an untrusted block (`## Project context`) into every run." (US2)
- FR12 [client] — Toggling a checkbox or dragging a row shall save the agent's (or skill's) list for that repo immediately, with no separate Save button; attached rows are listed first in their order. (US2, US3)
- FR13 [client] — The footer total shall be the estimated tokens a run of this agent would add in this repo: direct and skill-inherited attachments, de-duplicated (FR5), with "incl. Y from skills" when Y > 0. (US2)
- FR14 [client] — The skill editor shall have a Context tab: title "Project context to use", badge "k attached", hint "Any agent using this skill inherits these documents.", the same rows as FR11 with an icon preview, and a read-only "Serializes as" block showing `## Project context` followed by one `- <path>` line per attached document. (US3)
- FR15 [client] — The run trace drawer shall show, under Configuration → "Specs read", each included path with its tokens and each skipped path with its status; and under Prompt assembly a block "Project context · attached specs" listing every included document, each expandable to its full text as sent and copyable. (US4)
- FR16 [client] — The Preview action (agent and skill tabs) shall open the document's rendered markdown without leaving the tab. (US1, US2)

## 6. Workflow and communication
```mermaid
sequenceDiagram
  participant U as User (client)
  participant S as Server API
  participant G as Repo clone (git)
  participant DB as Database
  U->>S: list documents (repo)
  S->>G: walk clone, match globs, stat .md files
  S->>DB: count agents using each path
  S-->>U: documents with tokens and used-by
  U->>S: save attachments (agent or skill, repo, ordered paths)
  S->>DB: replace the list (no version bump)
  S-->>U: saved list
  Note over S: review run, one per agent
  S->>DB: agent attachments + linked enabled skills' attachments (PR repo)
  S->>G: read each path at the PR base commit (size cap)
  G-->>S: text or missing/too large/error
  S->>S: dedupe, apply 16k budget, mark statuses
  S->>S: reviewer-core assembles prompt with Project context section
  S->>DB: save trace with per-document records
  U->>S: open run trace
  S-->>U: specs read + per-document text
```
- Client → server (sync HTTP). On failure the screen shows its error state with Retry; a failed save rolls the checkbox/order back and shows a toast.
- Server → clone (sync, local fs/git). No clone → list returns `clone_status: not_cloned`; at run time every document is `missing`.
- Server → reviewer-core (in-process). Documents arrive as already-read strings with their labels; reviewer-core does no I/O.
- A read failure of one document never fails the run (FR6); the run proceeds with the rest.

## 7. Contracts
All new shapes are added to both `@devdigest/shared` copies. Paths are repo-relative, `/`-separated, end in `.md`, contain no `..` segment, no leading `/`, no NUL, ≤ 512 chars.

**GET /repos/:repoId/context** → 200 `{ clone_status: 'ready' | 'not_cloned', globs: string[], docs: ContextDoc[], tokens_total: number }`
`ContextDoc = { path: string, name: string, doc_type: 'specs' | 'docs' | 'insights', size_bytes: number, tokens: number, updated_at: string (ISO), used_by: number }`, sorted by path. Errors: 404 `repo_not_found`. Limit: at most 500 documents (first 500 by path; `truncated: true` added when cut).

**GET /repos/:repoId/context/doc?path=<path>** → 200 `{ path, name, doc_type, content: string, tokens: number, size_bytes: number, used_by: number, used_by_agents: { id: string, name: string, via: 'direct' | 'skill', skill_name?: string }[] }`. Errors: 400 `invalid_path` (shape rule or not matching the globs), 404 `repo_not_found`, 404 `doc_not_found`, 413 `doc_too_large` (> 256 KB).

**GET /agents/:id/context?repoId=<id>** → 200 `{ repo_id: string, paths: string[] }` (ordered). **PUT /agents/:id/context** body `{ repo_id: string, paths: string[] }` → 200 same shape. Errors: 404 `agent_not_found`, 404 `repo_not_found`, 422 `invalid_path`, 422 `duplicate_path`, 422 `too_many_paths` (> 50). Paths are not required to exist (FR6 handles absence).
**GET/PUT /skills/:id/context** — same shapes and errors with 404 `skill_not_found`.

**RunTrace** (additive, optional — old traces stay valid): `project_context?: { budget_tokens: number, tokens_total: number, docs: { path: string, doc_type: string, origin: { kind: 'agent' } | { kind: 'skill', skill_id: string, skill_name: string }, tokens: number, status: 'included' | 'missing' | 'too_large' | 'over_budget' | 'unreadable', text?: string }[] }`. `specs_read: string[]` keeps its type and now holds the included paths.

Superseded, removed from both copies: `SpecFile`, `IndexStatus` (no consumers besides the unused client hooks).

## 8. Data model (logical)
- **Context attachment** — owner (agent or skill) × repo × path, with an order position. Unique per owner × repo × path. Deleted with its owner or its repo. Not part of agent/skill version snapshots.
- **Context document** — derived, never stored: read from the clone on each list/preview, and from the PR base commit at run time.
- **Run project-context record** — part of the run trace (FR8), lives as long as the trace.

## 9. States and UX
| Screen / element | Loading | Empty | Error | Degraded | Success | Notes |
|---|---|---|---|---|---|---|
| Project Context list | skeleton rows | "No documents match `<globs>`" + the globs | message + Retry | `not_cloned`: "Repository is not cloned yet" | list + "N docs · ≈ X tokens total" | refresh refetches |
| Preview pane | skeleton | "Select a document" | 404/413 message | — | rendered markdown, "Used by N agents" | raw HTML shown as text |
| Agent / skill Context tab | skeleton rows | "No documents in `<repo>`" (link to Project Context) | message + Retry | `not_cloned` notice; attached paths no longer present listed as "missing" rows that can be unchecked | rows + badge + footer | names the active repo; no repo → "Select a repository" |
| Footer tokens | "≈ … tokens total" | "≈ 0 tokens total" | hidden | — | total, "incl. Y from skills" | > 16 000 → warning (Q2) |
| Trace "Specs read" | — | "none" | — | skipped paths with status badge | path · tokens | |
| Trace Project context block | — | block hidden | — | — | one expandable item per doc | copy per doc |

## 10. Edge cases
- EC1 [server] — An attached path is absent at the PR base commit (renamed, deleted, other branch) → skipped, status `missing`, run continues (FR6).
- EC2 [server] — Document > 256 KB → `too_large` at run time; 413 on preview; still listed with its size (FR2, FR3).
- EC3 [server] — The next document would push the total over 16 000 tokens → it and every later one get `over_budget`; earlier ones stay included (FR6).
- EC4 [server] — The same path attached to the agent and to one of its skills, or to two skills → included once, origin = first occurrence (FR5).
- EC5 [server] — A preview or attachment path with `..`, a leading `/`, a non-`.md` extension, or not matching the globs → 400/422 `invalid_path`, nothing read (FR3, FR4).
- EC6 [server] — A file name or document text containing the untrusted delimiter or quote characters → escaped so it cannot close or re-open the delimiter (FR7).
- EC7 [server] — A symlink inside the clone pointing outside it → not listed and not readable (FR1, FR3).
- EC8 [client] — Two quick toggles or a toggle during a drag → saves are applied in order; the final list on the server equals the final list on screen (FR12).
- EC9 [client] — Active repo switched while on a Context tab → the tab reloads that repo's documents and attachments (FR11, FR14).
- EC10 [server] — A disabled skill linked to the agent → its attachments are not added (FR5).
- EC11 [server] — Repo not cloned → list `not_cloned`; at run time all documents `missing` (FR1, FR6).
- EC12 [client] — Very long path or file name → truncated with ellipsis, full path in a tooltip (FR9, FR11).

## 11. Non-functional requirements
- NFR1 [server] — Listing a repo with 500 matching documents completes in ≤ 1 s on a local clone; at most 500 documents are returned.
- NFR2 [server] — Document text is untrusted: it reaches the model only inside the untrusted delimiters; the existing injection guard stays unchanged and applies (`reviewer-core/CLAUDE.md`).
- NFR3 [server] — No read outside the clone root: path shape rule, glob match, and symlink containment are checked before any read.
- NFR4 [server] — Each run logs one line with the counts of included and skipped documents and the included token total (no document text).
- NFR5 [server] — Building project context makes zero LLM calls and adds no token cost besides the included text.
- NFR6 [client] — All new strings are in `messages/en`; the "chunks" string of the Project Context screen is replaced by "tokens total".
- NFR7 [client] — Rows are keyboard-operable: checkbox toggles with Space, drag order also changeable with keyboard (move up/down), Preview is a button with a label.

## 12. Dependencies and rollout
- Shared contract change: yes — new context shapes and optional `RunTrace.project_context`; `SpecFile`/`IndexStatus` removed; both copies.
- Persisted data change: yes — new attachment entity (migration). Old traces remain valid (optional field).
- New server configuration: context globs (default as FR1).
- No feature flag. Release order: server and reviewer-core with the client in one change.

## 13. Acceptance criteria
- AC1 [server] — Given a clone with `specs/a.md`, `docs/b.md`, `insights/c.md`, `src/d.md` and `node_modules/x/docs/e.md`, when the list is requested, then exactly a, b, c are returned with types specs/docs/insights, sizes, `tokens = ceil(chars/4)`, ISO `updated_at`. Traces: FR1, FR2 · Verify: integration
- AC2 [server] — Given a custom glob in configuration, when the list is requested, then only files matching it are returned and `globs` echoes it. Traces: FR1 · Verify: integration
- AC3 [server] — Given agent X attaches `specs/a.md` and agent Y links skill S that attaches it, both in repo R, when the list for R is requested, then `used_by` of `specs/a.md` is 2, and in another repo it is 0. Traces: FR2, FR10 · Verify: integration
- AC4 [server] — Given a listed document, when it is previewed, then its full content and `used_by_agents` (with `via`) are returned; for `../x.md`, `/etc/a.md`, `specs/a.txt` or `src/d.md` the response is 400 `invalid_path`. Traces: FR3, EC5, NFR3 · Verify: integration
- AC5 [server] — Given a symlink `specs/link.md` pointing outside the clone, when listing and previewing, then it is absent from the list and preview returns 400 or 404. Traces: EC7, NFR3 · Verify: integration
- AC6 [server] — Given a 300 KB `specs/big.md`, when previewed, then 413 `doc_too_large`; it still appears in the list with its size. Traces: EC2, FR3 · Verify: integration
- AC7 [server] — Given PUT `/agents/:id/context` with `{repo_id, paths:[b,a]}`, when GET follows, then `[b,a]` is returned in that order; the agent's `version` is unchanged; PUT with a duplicate path → 422 `duplicate_path`, 51 paths → 422 `too_many_paths`, unknown agent → 404. Traces: FR4 · Verify: integration
- AC8 [server] — Given the same on `/skills/:id/context`, when saved, then the order is kept and the skill's `version` is unchanged. Traces: FR4 · Verify: integration
- AC9 [server] — Given agent attachments `[a]` and two enabled linked skills attaching `[b,a]` and `[c]`, and one disabled linked skill attaching `[d]`, when a run starts, then the document order is a, b, c; d is absent; a's origin is `agent`. Traces: FR5, EC4, EC10 · Verify: unit
- AC10 [server] — Given an attached path changed in the PR head but not in the base commit, when the run reads it, then the text equals the base-commit version. Traces: FR6 · Verify: integration
- AC11 [server] — Given attachments in this order: one deleted at the base commit, one of 300 KB, then documents of 10 000, 5 000, 2 000 and 500 tokens, when a run executes, then the run completes and the trace statuses are `missing`, `too_large`, `included`, `included`, `over_budget`, `over_budget` with `tokens_total = 15000`. Traces: FR6, EC1, EC2, EC3 · Verify: unit
- AC12 [server] — Given a repo with no clone, when a run with attachments executes, then every document is `missing` and the run completes; the list returns `clone_status: not_cloned` with no documents. Traces: EC11, FR1, FR6 · Verify: integration
- AC13 [reviewer-core] — Given two included documents, when the prompt is assembled, then `## Project context` contains one trusted instruction line and two untrusted blocks labelled with their paths in order, and the system message still contains the unchanged injection guard. Traces: FR7, NFR2 · Verify: unit
- AC14 [reviewer-core] — Given a document whose text contains `</untrusted>` and a path containing `"` or `>`, when assembled, then neither can close or re-open the delimiter (escaped). Traces: EC6, NFR2 · Verify: unit
- AC15 [server] — Given a completed run, when its trace is fetched, then `project_context.docs` has one record per FR5 document with path, type, origin, tokens, status, `text` only for included ones, `budget_tokens = 16000`, and `specs_read` equals the included paths; a trace saved before this feature still parses. Traces: FR8 · Verify: integration
- AC16 [server] — Given a run with project context, when it executes, then exactly one log line reports included count, skipped count and token total and contains no document text, and the number of LLM calls equals that of the same run without attachments. Traces: NFR4, NFR5 · Verify: integration
- AC17 [server] — Given a clone with 500 matching documents, when the list is requested, then it returns in ≤ 1 s and with 501 documents returns 500 and `truncated: true`. Traces: NFR1 · Verify: integration
- AC18 [client] — Given the Project Context nav item, when clicked with an active repo, then the list shows names, folders, type badges, "N docs · ≈ X tokens total", and selecting a row renders its markdown with "Used by N agents"; empty, error (Retry) and not-cloned states render per section 9. Traces: FR9, NFR6 · Verify: component
- AC19 [client] — Given the agent Context tab with 7 documents of which 2 are attached, when it opens, then the badge reads "2 of 7 attached", attached rows come first in order, and the footer shows the token total including "incl. Y from skills". Traces: FR11, FR13 · Verify: component
- AC20 [client] — Given the agent Context tab, when a checkbox is toggled or a row is moved (drag or keyboard), then a PUT with the new ordered list is sent at once; on a failed PUT the previous state returns and a toast shows. Traces: FR12, NFR7 · Verify: component
- AC21 [client] — Given two toggles in quick succession, when both saves finish, then the server-side list equals the on-screen list. Traces: EC8 · Verify: component
- AC22 [client] — Given the skill Context tab with one attached document, when it opens, then "1 attached", the inheritance hint and a "Serializes as" block with `## Project context` and `- <path>` are shown. Traces: FR14 · Verify: component
- AC23 [client] — Given a run trace with 2 included and 1 `missing` document, when the drawer opens, then "Specs read" shows 2 paths with tokens and 1 with a `missing` badge, and Prompt assembly shows "Project context · attached specs" whose items expand to each document's full text. Traces: FR15 · Verify: component
- AC24 [client] — Given a Preview button on a Context tab row, when clicked, then the rendered document opens over the tab and closing it keeps the tab state. Traces: FR16 · Verify: component
- AC25 [client] — Given the active repo is switched on a Context tab, when the new repo loads, then that repo's documents and attachments are shown. Traces: EC9 · Verify: component
- AC26 [client] — Given a 200-char path, when rendered in a row, then it is truncated with an ellipsis and the full path is in the tooltip; an attached path absent from the repo shows as a "missing" row that can be unchecked. Traces: EC12, EC1 · Verify: component
- AC27 [server] — Given the verification repo with `docs/architecture.md` stating "module `api/` does not import `db/` directly" attached to the Security Reviewer, when a PR adding `import … from '../db/…'` under `api/` is reviewed, then at least one finding cites `docs/architecture.md`. Traces: FR7, FR5 · Verify: manual

## 14. Traceability
| Source | Module | FR | EC / NFR | AC |
|---|---|---|---|---|
| Brief "Reader"; [3] list | server | FR1, FR2, FR10 | EC7, EC11, NFR1, NFR3 | AC1–AC3, AC5, AC12, AC17 |
| [3] preview | server, client | FR3, FR9 | EC2, EC5, NFR6 | AC4, AC6, AC18 |
| Brief "manual attach"; [4] | server, client | FR4, FR11, FR12, FR13, FR16 | EC8, EC9, EC12, NFR7 | AC7, AC19–AC21, AC24–AC26 |
| [5] skill tab | server, client | FR4, FR14 | — | AC8, AC22 |
| Brief "run-executor reads"; user "skip and record" | server | FR5, FR6 | EC1–EC4, EC10 | AC9–AC11 |
| Brief "untrusted, delimiters, guard" | reviewer-core | FR7 | EC6, NFR2 | AC13, AC14 |
| [6] trace; user "Prompt assembly attached specs" | server, client | FR8, FR15 | NFR4, NFR5 | AC15, AC16, AC23 |
| Brief "Verification" | all | FR7 | — | AC27 |

## 15. Design review
| # | Gap / proposal | Source | Module | Decision |
|---|---|---|---|---|
| 1 | Edit mode on documents: the clone is a shallow, DevDigest-managed checkout; writes would not reach the remote, would be lost on re-clone, and runs read the base commit, so an edit would not even change reviews | [3] | client | accepted: view-only (D1) |
| 2 | Coverage ring 78 has no defined metric | [3] | client | accepted: replaced by "Used by N agents" only (D3) |
| 3 | "≈ 317 tokens" footer and "chunks" wording | [4], i18n | client | accepted: "≈ X tokens total" (D5) |
| 4 | "Serializes as" in [5] uses `## Project specifications`; the prompt section is `## Project context` | [5] | client | accepted: show the real heading |
| 5 | Footer counts only direct attachments in [4]; inherited skill docs also add tokens | [4] | client | accepted: total includes inherited (FR13) |
| 6 | Attached document deleted from the repo has no state in the design | [4] | client | accepted: "missing" row (section 9) |
| 7 | Run-time limits not in design | — | server | accepted: 256 KB per file, 16k tokens per run (D7) |
| 8 | Untrusted block labelled by index cannot be cited | prompt.ts | reviewer-core | accepted: label = path (FR7) |
| 9 | Tabs bound to a repo but design shows no repo name | [4], [5] | client | accepted: tab names the active repo |
| 10 | Warning when the total exceeds the run budget | — | client | open (Q2) |

## 16. Decisions
- D1 — Can documents be edited? → View-only; editing a managed clone is not worth it (user delegated the call, 2026-10-01).
- D2 — Attached document no longer exists → skip and record in the trace (user, 2026-10-01).
- D3 — Coverage → only "Used by N agents" (user, 2026-10-01).
- D4 — New version on attach → no version for agents or skills (user, 2026-10-01).
- D5 — Footer / "chunks" → replace with "tokens total" (user, 2026-10-01).
- D6 — Attachment scope → per repo: owner × repo × path (user, 2026-10-01).
- D7 — Run budget → 16 000 estimated tokens per run, 256 KB per file (user, 2026-10-01).
- D8 — Document version at run time → PR base commit (user, 2026-10-01).
- D9 — Selection → manual only; automatic selector is a separate feature (brief).
- D10 — Spec status → approved by the user in the request (2026-10-01).

## 17. Open questions
- Q1 — Should the Project Context screen also list `INSIGHTS.md` files outside an `insights/` folder? — default: no, only the configured globs.
- Q2 — Show a warning on Context tabs when the token total exceeds 16 000? — default: yes, "exceeds the 16k run budget — later documents will be skipped".
- Q3 — Should the PR overview show which documents an agent will use before a run? — default: no (trace only).
