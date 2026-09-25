# Development Plan: Themed select (project-styled dropdown in both themes)
Packages: client · Base: feat/lab3@621199b · Spec: none
Context pack: docs/plans/2026-09-25-themed-select.context.md

## Goal
Every single-value dropdown opens a project-styled list drawn with the design tokens, readable in dark and light themes. This covers agent provider/strategy/CI fail-on, the create-agent provider, skill type, convention category and PR sort. The OS-native `<select>` popup is gone. Keyboard and screen-reader support matches the native one.

## Out of scope
- `SearchableSelect` (Model field): already themed [F3].
- `/showcase` keeps the vendored `SelectInput` [F8].
- Any edit under `client/src/vendor/ui` [I-A1].

## Decisions
- Approach (a), a custom listbox, not (b) `color-scheme` + `option` CSS. The OS draws the native popup [F1]. `color-scheme` only picks the OS dark palette, and browsers mostly ignore `<option>` styles (hover, radius, shadow). So (b) cannot match the project look [F3].
- Build a new shared `src/components/select/` → `Select`. Do not edit `SelectInput` [I-A1]. Four routes use it, so it is Shared UI [FUA §3]. It composes `@devdigest/ui` `Icon` and the tokens. It is not a duplicate primitive: `SelectInput` cannot be themed.
- Props are a superset of SelectInput's: `value, onChange?, options, mono = true` stay the same, and `"aria-label"?` and `disabled?` are new and optional. Each call site changes only its import and tag.
- ARIA follows the APG select-only combobox: a `div role="combobox" tabIndex=0` keeps focus, and `aria-activedescendant` points at the `role="option"` items. Focus return is automatic.
- The popup is rendered with `createPortal(document.body)`, `position:fixed`, `zIndex:70`. It must beat the Modal/Drawer `overflow:auto` and z 50 [F4] and the palette's z 60 [F5], and avoid [I2] and [I3].
- Use CSS variables only. Every token used exists in both `[data-theme]` blocks [F2].

## Steps
### S1 — pure helpers [client]
- Files: A `client/src/components/select/helpers.ts`, A `…/select/helpers.test.ts`
- Change:
  - `normalizeOptions(options) → {value,label}[]`
  - `moveActive(key, index, count)`: arrows clamp, no wrap; Home/End.
  - `typeaheadIndex(labels, buffer, from)`: case-insensitive prefix match, forward from `from+1`, wraps.
  - `placePopup(rect, viewportH, listH, gap=6, max=280) → {left,width,top|bottom,maxHeight}`: flips above when there is not enough room below.
- Rules: pure, no React/DOM [FUA §7]; no `any`.
- Tests: clamping, empty list, type-ahead wrap and case, flip/no-flip, maxHeight clamped.
- Done when: `cd client && npx vitest run components/select` is green.

### S2 — `Select` + `useSelectListbox` [client]
- Files: A `…/select/Select.tsx` (`"use client"`), A `…/select/useSelectListbox.ts`, A `…/select/styles.ts`, A `…/select/index.ts` (`Select`, `type SelectOption`), A `…/select/Select.test.tsx`, A `…/select/styles.test.ts` (added by test-writer backfill: CSS-variables-only rule)
- Change:
  - Trigger looks like SelectInput [F1]: padding `10px 12px`, radius 7, `--border-strong`, `--bg-elevated`, muted `ChevronsUpDown`, ellipsis, `mono`. Attributes: `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls` (useId), `aria-disabled`.
  - Popup copies SearchableSelect [F3]: `--bg-elevated`, `--border-strong`, radius 9, `--shadow-modal`, padding 6, `ddpop .12s`, scrolls. Options: `aria-selected`, padding `8px 10px`, radius 6. The active option gets `--bg-hover`; the selected one gets `Icon.Check` (transparent on the others).
  - Keys when closed: ArrowDown/Up, Enter, Space, Alt+ArrowDown open at the selected option. Home/End open at first/last. A printable char opens and runs type-ahead.
  - Keys when open: arrows, Home/End, type-ahead (500 ms buffer). Enter/Space pick and close. Escape and Tab close with no change.
  - Mouse: click the trigger to toggle. Hover sets the active option. Option `mousedown` calls preventDefault (focus stays on the trigger), click picks with `stopPropagation`.
  - Close on: outside `mousedown` (outside BOTH the trigger and the portal), trigger blur, pick, Escape.
  - Position comes from `placePopup` in a layout effect while open, updated on `resize` and on capture `scroll` (ignore scrolls from inside the list). Scroll the active option into view with `el.scrollIntoView?.({block:"nearest"})` (jsdom has none [F7]).
  - A value not in `options` shows the raw value.
- Rules: `selectedIndex` is derived, not stored. State is `open`, `activeIndex`, `popupPosition` (must re-render the fixed popup on resize/scroll) and a type-ahead ref. Effects are listeners that clean up, plus DOM syncs that need no cleanup (`scrollIntoView` of the active option) [react-best-practices]. _(Amended after verify-r1: the original wording omitted `popupPosition` and the DOM-sync effect, both required by S2.change.)_ Logic lives in the hook, the file stays ≤200 lines [FUA §4–6]. The portal mounts only while open (SSR-safe). No hard-coded copy.
- Tests (RTL + user-event, by role; options are portaled → query them with `screen`):
  1. Click opens; `listbox` and `option` roles are present; the selected option has `aria-selected`; clicking an option calls onChange and closes.
  2. ArrowDown ×2 + Enter → correct value; Escape → no call, the list closes, focus stays on the combobox.
  3. Home/End; type-ahead "an" → anthropic.
  4. Outside mousedown closes; inside a vendored `Modal`, the option renders outside the dialog DOM and picking still works.
- Done when: `cd client && npx vitest run components/select` is green; `./scripts/gates.sh`.

### S3 — agents call sites [client]
- Files: M `client/src/app/agents/[id]/_components/AgentEditor/_components/ConfigTab/ConfigTab.tsx` (4×), M `client/src/app/agents/_components/AgentsListView/_components/CreateAgentModal/CreateAgentModal.tsx`, A `client/src/test/select.ts`, M `…/CreateAgentModal/CreateAgentModal.test.tsx`, M `…/AgentEditor/_components/ConfigTab/ConfigTab.test.tsx`
- Change: `SelectInput` → `Select` from `@/components/select`, with `aria-label` from `config.provider|strategy|ciFailOn|outputSchema` and `create.fields.provider` [F10]. The helper `pickOption(user, combobox, name)` clicks the combobox, then `screen.getByRole("option",{name})`.
- Rules: [I4] (form wiring untouched), [I7].
- Tests: at CreateAgentModal.test:28, replace `selectOptions` with `pickOption(user, getByRole("combobox",{name:"Provider"}), "openrouter")`. In ConfigTab.test, add a case: pick anthropic → Save PUTs `{provider:"anthropic"}`.
- Done when: `npx vitest run CreateAgentModal` and `npx vitest run ConfigTab` are green [I5].

### S4 — skills, conventions, pulls [client]
- Files: M `client/src/app/skills/_components/SkillMetaFields/SkillMetaFields.tsx`, M `client/src/app/repos/[repoId]/conventions/_components/ConventionCard/ConventionCard.tsx`, M `client/src/app/repos/[repoId]/pulls/_components/FilterBar/FilterBar.tsx`, M `client/messages/en/prReview.json` (add `list.sortLabel: "Sort"`), M `ImportPreviewModal.test.tsx:63`, `skills/[id]/…/ConfigTab/ConfigTab.test.tsx:52`, `ConventionsView.test.tsx:147`
- Change: switch to `Select` with `aria-label` from `fields.type`, `card.categoryLabel` and `list.sortLabel`. In tests, `selectOptions` → `pickOption` by label: "rubric", "security", and "Style" (the label, not the value `style`). ConventionsView keeps `within(asyncCard)` for the combobox only.
- Rules: [I6]; strings go in messages (client/AGENTS.md).
- Tests: updated suites green, request assertions unchanged.
- Done when: `grep -rn SelectInput client/src --include=*.tsx | grep -v -e vendor/ui -e showcase` is empty; `./scripts/gates.sh`.

## Contracts & migrations
- none

## Verification
- `./scripts/gates.sh`. Run the full client suite alone, not in parallel with other jobs [I5].
- Manual (`./scripts/dev.sh`), in both themes: agent Config → Provider; Create agent modal (the popup is not clipped and sits above the modal); Skill type; convention category edit; PR Sort near the bottom of the viewport (the popup flips up). Keyboard: Tab, ArrowDown, type "o", Enter, Escape.

## Open questions / assumptions
- Fix the vendored `SelectInput` itself? Default: no [I-A1]. If the owner allows it, the S2 body goes into `vendor/ui/kit/SelectInput.tsx` and S3/S4 become test-only changes.
- Add `Select` to `/showcase`? Default: no.
- Should Tab with the list open pick the active option (APG allows either)? Default: close without picking.
