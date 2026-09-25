# Context pack: Themed select

## INSIGHTS that apply
- [I-A1] `client/AGENTS.md:32` — "`src/vendor/ui` (`@devdigest/ui`) — vendored primitives; compose, don't edit." (+ FUA skill §2 "compose, never edit") → new `src/components/select`, vendor untouched.
- [I2] `client/INSIGHTS.md` Codebase Patterns 2026-09-23 — "vendor/ui Modal (and Drawer) render in place with position:fixed, no portal: inside a dimmed row (opacity 0.55 for a disabled SkillCard) the dialog inherits the opacity, and its clicks bubble to the row's onClick" → the listbox is portaled to body; option clicks must not bubble into the host rows.
- [I3] `client/INSIGHTS.md` Recurring Errors 2026-09-23 — "a position:absolute descendant with NO positioned ancestor … escapes main's clipping and stretches the document → blank space under the page + a second window scrollbar" → popup is `position:fixed` in a portal.
- [I4] `client/INSIGHTS.md` Codebase Patterns 2026-09-22 — "ConfigTab: the form draft holds only touched fields over the live agent … never copy server state into useState for this form or send the full object" → only swap the component; keep `edit("provider")` wiring.
- [I5] `client/INSIGHTS.md` What Doesn't Work 2026-09-23 — "running the full client vitest suite in parallel with tsc/biome … CPU starvation makes unrelated CodeMirror/modal tests hit the 5000ms test timeout (seen: ConfigTab, VersionsTab, ConventionsView…)" + Tool Notes 2026-09-21 — "a path filter with Next route brackets … reports 'No test files found' → filter by a plain substring" → run filters as `npx vitest run ConfigTab`; rerun the full suite alone before calling a failure real.
- [I6] `client/INSIGHTS.md` Codebase Patterns 2026-09-22 — "messages/en/prReview.json: the namespace is shared by the PR detail route, the /pulls list (list.*) and components/findings-hover … → change only route-owned subkeys" → add only `list.sortLabel`.
- [I7] `client/INSIGHTS.md` What Works 2026-09-22 — "renderWithProviders … + mockFetch … → stub fetch/EventSource, do not vi.mock('@/lib/hooks/*')" → the migrated tests keep this setup.

## Verified facts
- [F1] `client/src/vendor/ui/kit/SelectInput.tsx:14-55` — native `<select appearance:none>` inside a styled div; the popup is drawn by the OS; props `value,onChange?,options,mono=true`.
- [F2] `client/src/vendor/ui/styles.css:10` (dark) / `:49` (light) — both define `--bg-elevated --bg-hover --border --border-strong --text-primary --text-secondary --text-muted --accent --shadow-modal`; `:214` global `:focus-visible` outline `--accent`; `:255` `@keyframes ddpop`; `:169` themed scrollbars. `src/lib/theme.tsx` puts `data-theme` on `<html>`, so portaled nodes inherit the tokens.
- [F3] `client/src/vendor/ui/kit/SearchableSelect.tsx:111-205` — themed popup (bg-elevated, border-strong, radius 9, shadow-modal, ddpop, row bg-hover, Check icon); buttons without listbox roles; z 40; absolute (clipped in a Modal).
- [F4] `kit/Modal.tsx:20,60` / `kit/Drawer.tsx:20,57` — overlay zIndex 50, body `overflow:auto` (an absolute popup would be clipped).
- [F5] `vendor/ui/command-palette/CommandPalette.tsx:68`, `ShortcutsHelp.tsx:10` — zIndex 60.
- [F6] `kit/FormField.tsx` — `<label>` not tied to children → callers pass `aria-label`.
- [F7] `src/test/setup.ts` — no scrollIntoView/getBoundingClientRect stubs (jsdom returns zeros; scrollIntoView undefined).
- [F8] Call sites: agents `ConfigTab.tsx:73,81,88,103`; `CreateAgentModal.tsx:73`; `SkillMetaFields.tsx:67` (used by ImportPreviewModal + skill ConfigTab); `ConventionCard.tsx:57`; `FilterBar.tsx:52`; `Showcase.tsx:162` (unchanged); `lib/model-label.ts:31` is a comment only. SearchableSelect does not use SelectInput.
- [F9] Tests using the native API: `CreateAgentModal.test.tsx:28`, `ImportPreviewModal.test.tsx:63`, `skills/[id]/…/ConfigTab.test.tsx:52`, `ConventionsView.test.tsx:147` (`within(card)`, value "style" → label "Style"). `getByDisplayValue` uses hit TextInputs only. No e2e flow touches a select.
- [F10] Labels: skills `type.*` labels equal the values; `conventions.card.categoryLabel` = "Category" exists; `agents.config.provider|strategy|ciFailOn|outputSchema`, `agents.create.fields.provider` exist; `prReview.list.sort` has no label key.

## Mirrors
- `vendor/ui/kit/SearchableSelect.tsx` — popup/row styles, Check mark, outside-mousedown close.
- `src/components/cost-text/` — shared folder anatomy.

## Skill map (from routing.json)
| Step | Files (glob) | Skills | Key rules |
|---|---|---|---|
| S1–S2 | `client/src/components/select/*.ts(x)` | frontend-ui-architecture, react-best-practices, typescript-expert, security | shared UI ≥2 routes; helpers pure; derive not store; effects only for listeners w/ cleanup; ≤200 lines; no dangerouslySetInnerHTML |
| S2–S4 | `**/*.test.tsx`, `client/src/test/select.ts` | react-testing-library | query by role; user-event; mock at boundaries only |
| S3–S4 | `client/src/app/**` | + next-best-practices | `"use client"` on the leaf; no hydration mismatch (portal only when open) |
| S4 | `client/messages/en/prReview.json` | — | route-owned key only [I6] |
No zod imports, no vendor/shared → no drift check.

## Risks
- The outside-click handler ignores the portaled list → mousedown on an option closes the list before click. Mitigation: check both refs; S2 test 4.
- Tests look for options `within(container)` → not found (portal). Mitigation: `pickOption` uses `screen`.
- Several comboboxes on agents ConfigTab → `getByRole("combobox")` throws. Mitigation: aria-label + name queries.
- The popup drifts while the page scrolls in `<main overflow:auto>`. Mitigation: capture-phase scroll listener repositions it.
- Picking an option from inside ConventionCard bubbles into a clickable card. The portal keeps the React tree, so the synthetic click still bubbles. Mitigation: `stopPropagation` in the option click.

## Notes for reviewers
- Architecture: vendor untouched; no app file imports `SelectInput` after S4.
- Security: labels are text nodes only.
