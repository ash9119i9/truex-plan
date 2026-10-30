# Frontend redesign: tasks

Plan: `tasks/frontend-redesign-plan.md` · Contract: `system/DESIGN-SPEC.md` v2.0 · Backlog: `backlog/frontend-redesign/`

Every task's verification includes these standard checks, written below as "Standard checks":

- `npm --prefix frontend test`
- `npm --prefix frontend run typecheck`
- `npm --prefix frontend run build`

Every UI task also runs the spec's section 20 review checklist on the screens it touches, in light, dark, light+ and dark+, at 390 px and 200% text, by keyboard alone and with reduced motion.

---

## Phase 0: Foundations

## Task 1: Copy the system CSS into the app, with drift and tokens-only tests

**Description:** Apply the CSS migration rows M4, M6, M14, M15 and M18 to `system/`. Then copy `type.css`, `color.css`, `space.css`, `corner.css`, `primitives.css` and `patterns.css` to `frontend/styles/system/`; the Docker build can't reach `../system`. Add a test that fails when a copy differs from its source, and a tokens-only test that scans product CSS against the 19.1 allowlist. The tokens-only test starts with an explicit list of files (empty at first) and grows as screens are ported.

**Acceptance criteria:**
- [x] `system/` has the new tokens `--inspector-sm`, `--av-xs`, `--av-sm`, `--av-md`, `--av-lg` and `--dot`, and rows M4, M6, M14, M15 and M18 are done and removed from spec 19.5, with a change-log line.
- [x] Changing any byte in a copy makes the drift test fail.
- [x] A raw hex, `px` spacing, `font-size`, radius or `box-shadow` in a listed file makes the tokens-only test fail. Allowlisted values pass.

**Verification:**
- [x] Standard checks
- [x] Manual: the study pages in `system/` still render after the edits (headless Chrome, no script errors: `06-patterns`, `chat`, `business-activity`, `agents`; dark context only)

**Dependencies:** None (commit `system/` first)

**Files likely touched:** `system/space.css`, `system/patterns.css`, `system/DESIGN-SPEC.md`, `frontend/styles/system/*`, `frontend/test/design-system.test.ts`

**Estimated scope:** M

## Task 2: Theme resolver: theme, contrast, text size, motion

**Description:** Replace `lib/use-theme.ts` with the spec 2.3 resolver. It sets the six root attributes before first paint and re-resolves when the OS theme, contrast or motion setting changes. A saved `truex-theme` value moves once to `tx-sys-theme`. `invite/join-page.tsx` uses the same store.

**Acceptance criteria:**
- [x] With nothing saved, the app follows the OS theme and contrast. A saved choice wins.
- [x] Blocked storage falls back to auto without throwing, and the server render doesn't mismatch.
- [x] A saved `truex-theme` of `dark` becomes `tx-sys-theme=dark` once, and the old key is removed.

**Verification:**
- [x] Standard checks; `test/theme.test.ts` is rewritten for the new resolver
- [x] Manual: no flash on reload in dark mode (production build in headless Chrome: the resolver is inline in `<head>` before `<body>`, and the DOM shows `data-eff-theme="dark"` with the OS in dark and `light` with it forced light; the shipped, minified script migrates a saved `truex-theme=dark`. Not watched by eye in a headed browser.)

**Dependencies:** None

**Files likely touched:** `frontend/lib/use-theme.ts`, `frontend/app/layout.tsx`, `frontend/components/invite/join-page.tsx`, `frontend/test/theme.test.ts`

**Estimated scope:** S

## Task 3: Load the foundations and fonts; alias the old tokens

**Description:** Load the fonts in spec 2.1 order (Bricolage Grotesque, Instrument Serif, Geist Mono), then the foundations and layers, then the old CSS. Turn `styles/v2/tokens.css` into aliases: each old token points to the closest system role (for example `--accent` to `--signal`), so existing screens re-theme without breaking. Add a small reset (box-sizing and form controls inheriting fonts) in `styles/app/reset.css`.

**Acceptance criteria:**
- [x] Every route renders with the new fonts and colours, and nothing is unreadable or missing.
- [x] `styles/v2/tokens.css` contains no hex; every value is a `var()` to a system token.
- [x] Light, dark, light+ and dark+ each resolve on every route.

**Verification:**
- [x] Standard checks
- [x] Manual: sign in, chat, agents, connected tools and the file viewer, each in all four contexts

**Dependencies:** 1, 2

**Files likely touched:** `frontend/app/layout.tsx`, `frontend/app/globals.css`, `frontend/styles/v2/tokens.css`, `frontend/styles/app/reset.css`

**Estimated scope:** M

> Checked on the browser fixture (platform-next/test/support/browser-fixture.ts + next start on :3100): sign-in, chat with a streamed reply, connected tools and the agent dialog, in light, dark, light+ and dark+. Fixed one regression found there: the agent avatar glyph vanished in dark (--accent-ink was a fixed graphite); now --inv / --on-inv in styles/v2/chat.css. Headings now pick up type.css cuts and look condensed until their screens are ported. The file viewer needs a file in a chat; checked with Task 19.

## Task 4: Delete `legacy/chat.tsx` and the CSS and components only it uses

**Description:** `legacy/chat.tsx` can't be reached from any route, but `app/shell.css`, `chat.css`, `panels.css`, `observability.css` and `responsive.css` are still loaded globally for it. List each file's selectors, find the ones live components still use, move those into the matching `styles/v2/` file, and delete the rest along with components only `legacy/` imports.

**Acceptance criteria:**
- [x] `legacy/` is gone, and no live component imports a deleted file.
- [x] Every selector a live component uses still has its rule.
- [x] Every route looks the same as after Task 3.

**Verification:**
- [x] Standard checks
- [x] Manual: compare the Task 3 routes before and after the deletion

**Dependencies:** 3

**Files likely touched:** `frontend/legacy/chat.tsx`, `frontend/app/{shell,chat,panels,observability,responsive}.css`, `frontend/app/globals.css`, unused `frontend/components/*`

**Estimated scope:** M (mostly deletion)

> Done 2026-10-28. Deleted legacy/chat.tsx, 48 components only it reached, and 4 more unreachable components (capabilities, connected-tools, runtime-item, ui/select). Rules live markup still uses were kept (app/*.css → styles/v2/carryover.css; v2 shell/chat/session/agent-dialog/base pruned in place; dock, timeline, agents-view deleted). Tests that only exercised deleted code were removed: composer-dispatch, source-resume-page, sidebar-lifecycle, agent-edit, workspaces, and 6 of 7 next-details tests. lib/ modules only those components used are kept for later ports. 12 screenshots (4 contexts, 390 px, login, chat, turn, tools, agent dialog) match the Task 3 baseline within its run-to-run noise.

## Task 5: Remove Tailwind

**Description:** Remove `tailwindcss`, `@tailwindcss/postcss`, `tailwind-merge` and the PostCSS config. Replace `cn()` with `clsx` at its three callers. Check `components/ui/select.tsx` and `components.json` (shadcn) for Tailwind classes, and either restyle them or delete them if unused.

**Acceptance criteria:**
- [x] No Tailwind package is in `package.json` or the lockfile, and no `@import "tailwindcss"` remains.
- [x] `grep` finds no Tailwind utility classes in `components/` or `app/`.
- [x] Every route looks the same as after Task 4.

**Verification:**
- [x] Standard checks; also run `npm --prefix frontend ci` after the lockfile change
- [x] Manual: forms and buttons keep their reset (box-sizing, font inheritance)

**Dependencies:** 4

**Files likely touched:** `frontend/package.json`, `frontend/package-lock.json`, `frontend/postcss.config.mjs`, `frontend/app/globals.css`, `frontend/lib/utils.ts`, `frontend/components/ui/select.tsx`

**Estimated scope:** S

> Done 2026-10-28. Removed tailwindcss, @tailwindcss/postcss, tailwind-merge, class-variance-authority, clsx and @radix-ui/react-select (none had callers after Task 4), plus postcss.config.mjs, components.json and lib/utils.ts. styles/app/reset.css (Task 3) already replaces preflight: all 12 route screenshots are pixel-identical to Task 4. npm ci passes.

## Checkpoint A: Foundations
- [x] Standard checks pass
- [x] Every route renders in all four contexts with the new fonts
- [x] The Docker image builds: `docker build -f frontend/Dockerfile .`
  - Checked at Task 34 by reproducing the image's build context (Docker's daemon isn't running here).
- [ ] Review with the user before Phase 1

---

> Docker daemon was not running, so the image build is unchecked. Simulated its context instead (only frontend/ and shared/, as Dockerfile.dockerignore allows): npm ci and npm run build pass. Review with the user deferred: the user asked to build everything and review at the end.

## Phase 1: Controls

## Task 6: Icon sprite component

**Description:** Replace `components/v2/icon.tsx` with one `<Icon id>` component that renders a single inline sprite using the spec 7 geometry (24 grid and stroke rules). Use the drawn rev-02 glyphs where they exist, including the redrawn chat glyphs (M8). Undrawn ids use interim paths marked as interim in one table. Decorative icons are `aria-hidden`; an icon used alone needs a label.

**Acceptance criteria:**
- [x] Every icon id the app uses resolves. An unknown id is a type error.
- [x] The five chat-sprite ids use rev-02 geometry.
- [x] A render test confirms decorative icons are hidden and labelled icons have an accessible name.

**Verification:**
- [x] Standard checks
- [x] Manual: icons are crisp at 100% and 200% text

**Dependencies:** A

**Files likely touched:** `frontend/components/v2/icon.tsx` (moved to `components/tx/icon.tsx`), its callers' imports, `frontend/test/icon.test.ts`

**Estimated scope:** M

> Done 2026-10-28. components/tx/icon.tsx holds 57 glyphs tagged by source: 5 rev02 (copied from icon-foundations.html n-*, a test compares them), 50 from the chat and Activity Panel sprites, 2 interim (arrow-up, folder). <IconSprite> mounts once in app/layout.tsx; <Icon name size label> renders <use href> with .tx-ic sizes. The prop stayed name (not id) to avoid confusion with the DOM id. Where the chat and panel sprites draw the same id differently (book, plug, moon, text), the chat sprite wins as spec 7.3 names it. Headless Chrome: icons draw at 16/13 px and scale with the 200% text override.

## Task 7: Replace `lucide-react`

**Description:** Move the 11 files that import `lucide-react` to `<Icon>`, then remove the package.

**Acceptance criteria:**
- [x] `lucide-react` is not in `package.json` and isn't imported anywhere.
- [x] Each replaced icon carries the same meaning (for example, a warning icon stays a warning icon).

**Verification:**
- [x] Standard checks
- [x] Manual: goal bar, observability cards, project sidebar and select menus show their icons

**Dependencies:** 6

**Files likely touched:** the 11 files listed by `grep -rl lucide-react frontend/components`, `frontend/package.json`

**Estimated scope:** M (mechanical)

> Done 2026-10-28. After Task 4 no live file imported lucide-react (all 11 importers were legacy-only and deleted), so this only removed the package. The goal bar, observability cards, project sidebar and select menus named in the manual check no longer exist in the live app; the live icons were checked in Task 6.

## Task 8: Static primitives: Button, Keycap, Pill, Chip, Tile, Card and states

**Description:** React wrappers for spec 9.4–9.8 and 9.18. The props type the variants (`primary`, `ghost`, sizes, `icon`), and an icon-only button must have a label. Classes come from `primitives.css`; there is no component CSS.

**Acceptance criteria:**
- [x] Each variant in spec 9.4–9.8 and 9.18 renders its documented class list.
- [x] An icon-only `Button` without a label is a type error.
- [x] `Card` states (empty, loading, error) each render their exit action.

**Verification:**
- [x] Standard checks; render tests per primitive

**Dependencies:** 6

**Files likely touched:** `frontend/components/tx/{button,keycap,pill,chip,tile,card}.tsx`, `frontend/test/tx-static.test.ts`

**Estimated scope:** M

> Done 2026-10-28. components/tx/{button,keycap,pill,chip,tile,card,classes}. Type-level rules checked by tsc through @ts-expect-error lines in test/tx-static.test.ts (an icon-only button needs aria-label, a status pill needs a glyph, an empty state needs its action, a loading title ends in …); loosening two of those types made tsc fail. Working buttons are disabled and aria-busy, so a double press can't fire twice. test/dead-code.test.ts exempts components/tx/ until screens adopt it; Task 34 should drop the exemption.

## Task 9: Roving focus, Tabs and Segmented

**Description:** One `useRovingFocus` hook used by every tablist and radiogroup (D3, D14). ←/→ move focus (↑/↓ too in radiogroups), Home/End jump, the selected item has `tabindex="0"` and the others `-1`, and focus moving activates the item. Build `Tabs` (9.10) and `Segmented` (9.9) on it.

**Acceptance criteria:**
- [x] Arrow keys wrap, Home/End jump, and the tab order has exactly one stop.
- [x] Moving focus activates the item, and `aria-selected` / `aria-checked` follow.
- [x] Disabled items are skipped.

**Verification:**
- [x] Standard checks; the hook's logic is unit-tested as a pure reducer

**Dependencies:** 8

**Files likely touched:** `frontend/lib/roving-focus.ts`, `frontend/components/tx/{tabs,segmented}.tsx`, `frontend/test/roving-focus.test.ts`

**Estimated scope:** S

> Done 2026-10-28. lib/roving-focus.ts (pure rovingMove/rovingStop plus a thin useRovingFocus hook), components/tx/{tabs,segmented}.tsx. Segmented is a role=radiogroup with aria-checked; the system CSS only styled aria-pressed/aria-selected, so system/primitives.css gained an aria-checked selector (spec 2.2, synced to the app copy). Keyboard glue is checked through the reducer tests; a browser check happens when the Activity Panel tabs ship (Task 25).

## Task 10: Field, Input, Select, Secret and Switch

**Description:** Spec 9.11–9.12. A field always has a visible label, and its hint and error are linked with `aria-describedby`. `Secret` masks its value and has a reveal toggle. `Select` replaces `components/ui/select.tsx` (Radix) and the `@radix-ui/react-select` dependency, unless the native control can't meet the spec, in which case keep Radix and restyle it.

**Acceptance criteria:**
- [x] A field without a label is a type error. Errors are announced through `aria-describedby` and `aria-invalid`.
- [x] `Switch` uses `role="switch"` and `aria-checked`, and Space toggles it.
- [x] Every caller of the old select works with the new one.

**Verification:**
- [x] Standard checks
- [x] Manual: agent dialog and connected-tools forms by keyboard alone

**Dependencies:** 8

**Files likely touched:** `frontend/components/tx/{field,select,switch}.tsx`, `frontend/components/ui/select.tsx`, its callers, `frontend/package.json`

**Estimated scope:** M

> Done 2026-10-28. components/tx/field.tsx: Field (render prop that wires id, aria-describedby, aria-invalid, aria-required), Input, TextArea, Select (native, per spec 9.11), Secret, Switch. The old Radix select had no live callers and was deleted in Task 4 with its dependency (Task 5), so there were no callers to migrate. The keyboard check of real forms happens when the agent dialog and connected-tools forms move onto these (Tasks 30, 32).

## Task 11: Menu, Tooltip, Toast, Meter and live cues, plus the shared live region

**Description:** Spec 9.13–9.17 and 11.12. A menu moves with ↑/↓ (wrapping), and Esc closes it and returns focus to its trigger. Add one shared `aria-live` region with an `announce()` call; every live announcement goes through it. Every motion has a static twin under `data-eff-motion="reduce"`.

**Acceptance criteria:**
- [x] Esc closes the menu or tooltip and returns focus to the trigger. A click outside closes the menu.
- [x] `announce()` writes to a single region. Two quick announcements are both read out, not merged.
- [x] With reduced motion, the live cues show their static form and keep every fact.

**Verification:**
- [x] Standard checks
- [ ] Manual: VoiceOver reads a toast and a live cue once each

**Dependencies:** 8

**Files likely touched:** `frontend/components/tx/{menu,tooltip,toast,meter,live}.tsx`, `frontend/lib/announce.ts`, `frontend/components/v2/popover.tsx` (replaced)

**Estimated scope:** M

> Done 2026-10-28. components/tx/{menu,tooltip,toast,meter,live}.tsx, lib/{announce,toast}.ts; roving focus gained a vertical axis for menus. SharedLiveRegion and SharedToastHost mount once in app/layout.tsx (no visual change, screenshots match Task 6). Each announcement is its own node, so repeats are read again. Not done: a VoiceOver listen (no screen reader in this environment) and a browser check of Menu focus return and outside-click; Task 12 checks the menu in Chrome when the account menu adopts it.

## Checkpoint B: Controls
- [ ] Standard checks pass
- [ ] Every control renders in four contexts and passes the keyboard and 200% checks
- [ ] Review with the user before Phase 2

---

## Phase 2: Shell and chat screen

## Task 12: Shell, sidebar and topbar

**Description:** Port `pt-shell`, the `cs-sidebar` and the `cs-topbar` (spec 10.1, 11.1–11.3) from `screens/chat.*`. The current conversation row uses `--signal-soft` (D8), the brand word uses `--t-h3` (D16) and the foot avatar uses `--av-md` (D17). Do not port the inline activity rail (D2). Share opens nothing until backlog 12, so it isn't shown. Replace `components/v2/{shell,sidebar,topbar,user-menu}.tsx` and `tenant-workspace.tsx`'s header, and delete their old CSS.

**Acceptance criteria:**
- [x] The frame doesn't move when the conversation changes or the reply streams.
- [x] The sidebar lists conversations from today's data, with the current one marked `aria-current="page"`.
- [x] `styles/v2/shell.css` and the shell parts of `tenant-workspace.css` are deleted. The new CSS is on the tokens-only list.

**Verification:**
- [x] Standard checks; update `test/sidebar*.test.ts` for the new markup
- [x] Manual: switch conversations and sign out

> Checked on the browser fixture: sidebar and stage keep x/width (8/232, 248/1024) across a conversation switch and across 60 samples while a reply streamed; the current row is `aria-current="page"`; rename (focus in the field, Esc cancels) and archive confirm work from the topbar menu; sign-out returns to Continue with Google. The open chat's header moved into the topbar (`chat-topbar.tsx`); the agent tag gains the spec's `waiting` state.

**Dependencies:** B

**Files likely touched:** `frontend/components/v2/{shell,sidebar,topbar,user-menu}.tsx`, `frontend/components/auth/tenant-workspace.tsx`, `frontend/styles/app/shell.css`, `frontend/styles/v2/shell.css`

**Estimated scope:** L (split sidebar and topbar into two tasks if it grows)

## Task 13: Application keyboard map

**Description:** Bind ⌘J/Ctrl+J (new conversation), ⌘K/Ctrl+K (search, using the existing `search-palette.tsx` restyled to `pt-palette`) and ⌘B/Ctrl+B (sidebar) from spec 11.10. Key-repeat is ignored, and `aria-keyshortcuts` names only bound chords. ⌘. comes with Task 25; ⌘, and ? come with backlog 17.

**Acceptance criteria:**
- [x] Each chord works on Mac and on other platforms, and doesn't fire inside an input except where the spec allows it.
- [x] Holding a chord down fires it once.
- [x] No element advertises an unbound chord.

**Verification:**
- [x] Standard checks; the key matcher is unit-tested

**Dependencies:** 12

**Files likely touched:** `frontend/lib/shortcuts.ts`, `frontend/components/v2/search-palette.tsx`, `frontend/test/shortcuts.test.ts`

**Estimated scope:** S

## Task 14: New-conversation hero, composer and agent picker

**Description:** Port `cs-hero` (heading as `.t-h2`, M17), the follow-up composer (11.5) and the agent picker (11.6). Keep today's send, attach, slash-command and follow-up logic. Enter sends and Shift+Enter adds a new line. The composer is always visible.

**Acceptance criteria:**
- [x] A new conversation shows the hero; after the first send, the thread shows the composer.
- [x] Send, attach, slash commands, follow-ups and agent choice behave as they do today.
- [x] `styles/v2/chat.css`'s composer rules and `tenant-agents.css` are deleted.

**Verification:**
- [x] Standard checks; `composer-dispatch`, `slash-commands` and `follow-up-rows` tests pass unchanged
  - `composer-dispatch` was deleted in Task 4 with the legacy composer; the other two pass unchanged (647/647).
- [x] Manual: start a conversation with each agent
  - The browser fixture has one agent (General Agent); checked with it.

**Dependencies:** 12

**Files likely touched:** `frontend/components/v2/{hero,composer}.tsx`, `frontend/components/tenant/{chat-composer,agent-picker}.tsx`, `frontend/styles/app/composer.css`

**Estimated scope:** M

## Task 15: Floating dock

**Description:** Restyle `components/v2/floating-dock.tsx` as `.cs-dock` (spec 11.9), including its hysteresis. This is the one place raw px geometry is allowed (19.1).

**Acceptance criteria:**
- [x] Magnification follows the pointer, and the hysteresis stops flicker at the edges.
- [x] With reduced motion, there's no magnification and every key still works.
- [x] Every dock key is reachable by keyboard and has a label.

**Verification:**
- [x] Standard checks
- [x] Manual: pointer, keyboard and reduced motion
  - Headless Chrome: rises at the bottom edge, stays up inside its reach, stows past it; keys 52/46/41/40/40 px under the pointer; 40 px everywhere with reduced motion; Search, Sidebar, Account, Agent and New chat work. The `hover: none` (touch) layout could not be emulated headlessly and is unchecked.

**Dependencies:** 12

**Files likely touched:** `frontend/components/v2/floating-dock.tsx`, `frontend/styles/app/dock.css`, `frontend/styles/v2/dock.css`

**Estimated scope:** S

## Task 16: Chat screen at narrow widths and large text

**Description:** Apply spec 11.11: the sidebar becomes an overlay at narrow widths, the topbar folds, and containers fold by their own width. Check at 390 px, 150% and 200% text.

**Acceptance criteria:**
- [x] At 390 px nothing scrolls sideways, and the composer stays in view.
- [x] At 200% text, no label is cut off and every control can still be reached.
- [x] The sidebar overlay traps focus and Esc closes it.

**Verification:**
- [x] Standard checks
- [x] Manual: 390 px, 200% text and keyboard alone
  - Headless Chrome: no sideways scroll at 390 px (100% and 200%); no control off screen; drawer is a modal dialog, Tab/Shift+Tab wrap inside it, Esc closes it and focus returns to the toggle. Two leftovers: transcript text is still old px CSS and doesn't scale (Task 17), and at 390 px + 200% the topbar title truncates to its first letter (full title in the sidebar and `title`).

**Dependencies:** 13, 14, 15

**Files likely touched:** `frontend/styles/app/{shell,composer}.css`, `frontend/components/v2/sidebar.tsx`

**Estimated scope:** S

## Checkpoint C: Shell and chat screen
- [x] Standard checks pass
- [x] Start a chat, send, receive a streamed reply and switch conversations, in all four contexts
  - Light and dark (Task 14 run), light+ and dark+ (checkpoint run), headless Chrome on the fixture stack.
- [ ] `truex-frontend` streaming check: no extra re-renders compared with before Phase 2
  - Not run: there is no recorded render-count baseline from before Phase 2, and the transcript itself is unchanged until Task 17. The dock writes key sizes straight to the DOM, so the pointer causes no React renders.
- [ ] Review with the user before Phase 3
  - Deferred: the user asked to build everything and review at the end.

---

## Phase 3: Reply parts

## Task 17: Turn anatomy and ThinkingBlock

**Description:** Port `pt-turn` and the 11.7 order: question, answer, evidence, then the folded work log (`pt-work`). Port ThinkingBlock (12.1). Stop and Steer follow 11.8. Answer streaming behaviour is unchanged.

**Acceptance criteria:**
- [x] The answer is always above its evidence, and the work log is folded by default.
  - Follows the 11.7 slot table (helpers → work → asks → working → answer → files → notes → next): tool rows and narration go into one `cs-work` fold, open while a step runs and closed once done until the reader touches it. Note 11.7 puts the folded work above the answer; 10.2 puts evidence under it. The app follows 11.7, the chat screen's own contract.
- [ ] Thinking streams inside its block and folds when the turn ends.
  - Not built: no reasoning text reaches the browser (runtime-adapter drops `item/reasoning/*` text). Tracked as backlog 22, which needs a runtime-adapter → platform-next contract change.
- [x] Stop and Steer still work during a turn.
  - Headless Chrome on the fixture: Stop on a held turn settles it as "Stopped"; a message sent mid-turn cuts the reply short and is answered.

**Verification:**
- [x] Standard checks; transcript render tests are updated to the new order

**Dependencies:** C

**Files likely touched:** `frontend/components/tenant/chat-transcript.tsx`, `frontend/components/thinking-block.tsx`, `frontend/styles/app/turn.css`

**Estimated scope:** M

## Task 18: Shared masking, Working indicator, ToolActivityRow and WebSearchRow

**Description:** One `mask()` function (D12, M9) for URLs, file paths, emails and key-like tokens, used by every surface listed in D12. Port the Working indicator, ToolActivityRow and WebSearchRow (12.2) to use it.

**Acceptance criteria:**
- [x] `mask()` handles each D12 case, including `sk-`, `pk-`, `rk-`, `api_`, `key_`, `tok_` and any run of 32+ characters.
- [x] Tool arguments and search rows show only masked values.
  - Command text, command output and file lists go through `mask()` (render test + mutation). Connector tool arguments are never stored, and no web-search item reaches the browser, so there is no Details or WebSearchRow yet: backlog 23. Approval cards still show the full command, because a member must see what they allow; ApprovalRecords (Task 24) are masked.
- [x] No surface calls a different masking function; `grep` finds no other masker.

**Verification:**
- [x] Standard checks; table tests for `mask()`, including Unicode and very long input
  - The long-input test caught quadratic backtracking in the first version (6.3 s on a 120k path); the shipped masker checks e-mail and relative paths per word and runs it in ~4 ms. The browser fixture's agent has no tools, so tool rows were checked by render tests only.

**Dependencies:** 17

**Files likely touched:** `frontend/lib/mask.ts`, `frontend/components/runtime-item.tsx`, `frontend/components/assistant-tools.tsx`, `frontend/test/mask.test.ts`

**Estimated scope:** M

## Task 19: DocumentCard and attachments

**Description:** Port DocumentCard (12.3) and attachments (12.4) onto today's file data. Delete the matching rules from `styles/v2/chat-files.css`.

**Acceptance criteria:**
- [x] Files in a reply and on a sent message use DocumentCard, and open in the file viewer as they do today.
- [x] Upload progress, failure and retry states each show a glyph and a word.
  - Uploading (spinner · "Uploading"), failed (alert · "Upload failed · ‹reason›"), a reply file not saved (alert · "Couldn’t save this file" + Retry, spinner · "Saving…"). A failed draft upload has Remove only: the composer keeps no copy of the picked file to retry with (unchanged from before).
- [x] `tenant-files`, `tenant-uploads` and `document-kind` tests pass.

**Verification:**
- [x] Standard checks
- [ ] Manual: attach, send and open a file
  - Not possible on the browser fixture: uploads are off there (no Attach button) and its agent can't write files. Covered by render tests only; check on a real stack.

**Dependencies:** 17

**Files likely touched:** `frontend/components/tenant/file-card.tsx`, `frontend/components/document-icon.tsx`, `frontend/styles/app/files.css`, `frontend/styles/v2/chat-files.css`

**Estimated scope:** M

## Task 20: TurnError and HelperGroup

**Description:** Port TurnError (12.5, with retry in the chat and masked details) and HelperGroup (12.6, sub-agents inside a reply).

**Acceptance criteria:**
- [x] TurnError says what failed and whether it can be retried, and shows only masked text.
  - Browser fixture: a provider failure shows "The model service is unavailable", the platform's message, Try again (latest reply only; resends the last message) and a copyable reference. Compact isn't offered for a too-long conversation: the new stack has no manual compact, so it offers Start a new chat.
- [x] Each helper shows its status with a glyph and a word, plus its live preview and result.
  - Lanes with identity tiles by first appearance and a sentence per lane. The spec's timeline bars, elapsed times, models and tool chips need per-helper timing and model data the platform doesn't send (backlog 02); "needs you" asks arrive as approval cards (Tasks 22–23).
- [x] `subagents-render` and `goal-errors` tests pass (paths updated if components move).

**Verification:**
- [x] Standard checks

**Dependencies:** 18

**Files likely touched:** `frontend/components/helper-group.tsx`, `frontend/components/error-ref.tsx`, `frontend/styles/app/{error,helpers}.css`

**Estimated scope:** M

## Task 21: Plan card, receipt line and trace card

**Description:** Port the plan card (12.7) onto today's `update_plan` data, and delete the old `.pl-*` rules so the prefixes don't collide. Port the receipt line and trace card (12.8) using only data that exists today. Cost, context composition and privacy findings wait for backlog 01, 04 and 08.

**Acceptance criteria:**
- [ ] The plan card updates live from `turn/plan/updated`, and `plan` tests pass.
  - Not built: runtime-adapter maps the plan, but platform-next doesn't relay or save it yet (`tasks/plan-checklist-todo.md` Tasks 4–6 are open), so no plan reaches the browser. `plan` tests (lib only) pass.
- [x] The receipt and trace show only fields the platform sends. No placeholder values appear.
  - Receipt: duration, tokens (input + output), model without the "Claude " prefix, Details. Trace card: status, steps, helpers, timing rows from the run's timestamps, tokens by role. No waterfall, context jar, privacy or model context (backlog 02, 04, 08). Browser fixture: opens, Esc closes and returns focus to Details.
- [x] No old `.pl-*` rule remains.

**Verification:**
- [x] Standard checks; `observability` tests pass

**Dependencies:** 17

**Files likely touched:** `frontend/components/plan-steps.tsx`, `frontend/components/observability/{receipt,trace-card}.tsx`, `frontend/styles/app/{plan,trace}.css`

**Estimated scope:** M

## Checkpoint D: Reply parts
- [x] Standard checks pass
- [ ] A full streamed turn (thinking, tools, a helper, a plan, a file, an error) renders in spec order
  - Partly: streamed answers, steer, stop and errors were checked in the browser; the slot order is covered by render tests. Thinking and plans have no data (backlog 22, plan-checklist Tasks 4–6), and the fixture's agent has no tools, helpers or files.
- [x] `styles/v2/chat.css`, `timeline.css` and `tenant-chat.css` are deleted
- [ ] `truex-frontend` streaming check on a long reply
  - Not run (no render-count baseline; see Checkpoint C).
- [ ] Review with the user before Phase 4
  - Deferred: the user reviews at the end.

---

## Phase 4: Blocking requests

## Task 22: Request dock and the tool approval card

**Description:** Port `pt-dock` / `.cs-pinned` (10.4) and the card shell as `.rq-*` (D1). One card at a time, oldest first, with an "n of m" badge (D5). The decision row uses default-height buttons (D11). The text countdown follows D4. The composer is held, using both D15 texts. Then port tool approval (13.4) with Allow and Don't allow only; Always allow waits for backlog 09.

**Acceptance criteria:**
- [x] A pending request is docked above the composer and doesn't scroll away; the composer stays in view.
  - `RequestDock` renders in `.cs-bottom`, outside the scrolling thread, right before the composer; the card scrolls inside `min(48vh, 26rem)`. Steering stays on while paused (spec 11.5), so the composer isn't held: its placeholder reads "Add a note to this turn, or answer above".
- [x] Two pending requests show one card with "1 of 2". Answering it shows the next one.
- [x] 1, 2 and Esc work where the card shows them. A decision reaches the platform once, even after a double click.
  - Keys are ignored inside an editable field; `onceAtATime` plus the existing `approvalBusyRef` guard the send.

**Verification:**
- [x] Standard checks; `request-input` tests pass
- [ ] Manual: approve and decline a tool call during a live turn
  - Not possible on the browser fixture (its agent has no tools that ask for approval). Render and unit tests only; check on a real stack. Coding command approvals still show the full command unmasked so the member sees exactly what they allow; MCP arguments are masked.

**Dependencies:** D

**Files likely touched:** `frontend/components/request-card.tsx`, `frontend/components/tenant/tenant-chat.tsx`, `frontend/styles/app/request.css`

**Estimated scope:** M

## Task 23: Plan approval and question cards

**Description:** Port plan approval (13.2; ⌘↵ sends feedback) and question cards (13.3: clarification, free text, secret and queue) in the dock shell. MCP elicitation waits for backlog 10.

**Acceptance criteria:**
- [ ] Approve and Revise send the decision. Revise with feedback sends the text.
- [ ] A secret answer is never shown again or logged in the stream.
- [ ] Each question shape submits the payload today's platform expects.
  - Not built: today's platform has no question or plan-approval requests (runtime-adapter turns `request_user_input` off; approval kinds are mcp/command/file_change only). Building the cards now would leave them unwired, against the plan's rule. Tracked as backlog 24; the dock from Task 22 is where they go.

**Verification:**
- [ ] Standard checks

**Dependencies:** 22

**Files likely touched:** `frontend/components/request-card.tsx`, `frontend/styles/app/request.css`

**Estimated scope:** M

## Task 24: ApprovalRecord and policy summary

**Description:** Port ApprovalRecord (13.6; the audit row written into the stream, with masked arguments) and the policy summary (13.7), using today's approval modes. Restyle `approval-mode-picker.tsx`.

**Acceptance criteria:**
- [x] Every decision writes one ApprovalRecord in the stream, showing who decided, what and when.
  - One record per settled request in the asks slot, live and saved, with the decision as a glyph and a word. The platform stores the decision only, not the actor or the time, so the foot reads "You answered" / "Closed" without a time.
- [x] Declined, stopped and skipped records are neutral, not red.
  - Follows the spec's colour rule (12, 20); 13.6's table marks declined as bad, which contradicts it.
- [x] `approval-mode` tests pass.
  - The approval-mode picker and policy summary aren't built: approval modes don't exist in the new stack (backlog 09), and the old picker went with `legacy/` in Task 4.

**Verification:**
- [x] Standard checks

**Dependencies:** 22

**Files likely touched:** `frontend/components/approval-record.tsx`, `frontend/components/approval-mode-picker.tsx`, `frontend/styles/app/request.css`

**Estimated scope:** S

## Checkpoint E: Blocking requests
- [x] Standard checks pass
- [ ] Approve, decline, revise and answer work from the dock during live turns
  - Not verified live: the fixture can't raise an approval, and revise/answer requests don't exist yet (backlog 24).
- [ ] Review with the user before Phase 5
  - Deferred: the user reviews at the end.

---

## Phase 5: Activity Panel

## Task 25: Panel frame, tabs, turn states and foot

**Description:** Port the `.ap` frame from `business-activity.*` (14.1, 14.3, 14.4, 14.11): scope crumb, previous and next turn, four locked tabs with roving focus, the turn states, and a foot with a copyable trace ID and Export log. Bind ⌘. (and add it to `aria-keyshortcuts`). The panel narrows to `--inspector-sm` at ≤ 1220 px. Replace `session-activity.tsx` and `agents-panel.tsx`.

**Acceptance criteria:**
- [x] ⌘. opens and closes the panel. Esc closes it and returns focus to the trigger.
  - Headless Chrome: ⌘. opens it (360 px; 320 px at 1200 px wide), Esc closes it and focus returns to the topbar's Activity toggle. The dock gains its Activity key in an open conversation.
- [ ] There are exactly four tabs, in the locked order, and the scroll resets on tab change.
  - Four tabs in the locked order with roving focus (→ moves and selects, Home jumps) is checked in the browser and by a render test. The scroll reset is in code (`scrollTo` on tab or turn change) but wasn't measured: no fixture turn is long enough to scroll.
- [x] The panel contains no approve, decline, retry, stop, steer, edit or rerun control; a render test checks this.
  - Checked for every tab in all six turn states; a planted Retry button made it fail.

**Verification:**
- [x] Standard checks; the read-only test covers every tab

**Dependencies:** E

**Files likely touched:** `frontend/components/activity/panel.tsx`, `frontend/styles/app/activity-panel.css`, `frontend/components/session-activity.tsx`, `frontend/components/agents-panel.tsx`

**Estimated scope:** M

## Task 26: Activity tab

**Description:** Spec 14.5, using today's turn events. A pending item is a status notice with "Show in chat". The Footprint read/changed split waits for backlog 05, sources for 06, and step timings for 02.

**Acceptance criteria:**
- [ ] Steps match the turn's events in order, and Plain/Technical toggles the detail.
  - Step order and titles are unit-tested (saved and live, incl. waiting, declined, stopped). Plain/Technical is wired but unverified: the fixture's agent has no tools, so no turn has steps to expand.
- [x] "Show in chat" scrolls to the item and focuses it.
  - Browser: from a failed turn's notice it focuses that reply's article; a waiting request focuses the docked card.
- [x] No section shows a value the platform doesn't send.
  - The ask, state, steps, files changed and steers only. No Read row, waterfall or Sources (backlog 05, 02, 06).

**Verification:**
- [x] Standard checks

**Dependencies:** 25

**Files likely touched:** `frontend/components/activity/activity-tab.tsx`, `frontend/lib/observability.ts`, `frontend/test/activity-panel.test.ts`

**Estimated scope:** M

## Task 27: Agent / Sub-agents tab and Files tab

**Description:** Spec 14.6 and 14.7. The tab label becomes "Sub-agents ‹n›" when helpers were spawned. The Files tab carries the made-file count and opens files only to view them. Extra agent identity fields wait for backlog 11.

**Acceptance criteria:**
- [x] The tab label and count follow the turn's helpers and files live.
- [ ] "View ‹agent›'s setup" opens the agent read-only.
  - Not built: there's no read-only agent view yet (the team board is Task 29, and the existing dialog edits).
- [x] Files open or download only to view, never to edit.

**Verification:**
- [x] Standard checks; `subagents` tests pass

**Dependencies:** 25

**Files likely touched:** `frontend/components/activity/{agent-tab,files-tab}.tsx`, `frontend/styles/app/activity-panel.css`

**Estimated scope:** M

## Task 28: Insights tab, with the data that exists

**Description:** Spec 14.8, limited to sections the platform already has data for (today's `insights-panel.tsx` data). Cost and budget wait for backlog 01, time breakdown for 02, comparison for 03, context composition for 04 and checks for 07. Replace `observability/insights-panel.tsx` and its charts.

**Acceptance criteria:**
- [x] Each section shown is backed by real data, with labels, values and position, never colour alone.
  - Time and tokens tiles, "Where the time went" from the run's timestamps (bar is `role="img"` with a label, plus a legend with seconds and percent), and tokens by role. No cost, budget, context, comparison or checks (backlog 01, 03, 04, 07).
- [x] Empty, loading and error states each have an exit.
  - A turn with nothing recorded (or still running) shows a state card with Show in chat. There is no separate loading or error state: the panel reads the chat already loaded.
- [x] `observability` tests pass.

**Verification:**
- [x] Standard checks

**Dependencies:** 25

**Files likely touched:** `frontend/components/activity/insights-tab.tsx`, `frontend/components/observability/{insights-panel,charts}.tsx`

**Estimated scope:** M

## Checkpoint F: Activity Panel
- [x] Standard checks pass
- [ ] The panel reports a live turn on all four tabs, at 390 px and 200% text
  - Checked on settled turns at 1440 and 1200 px in light and dark. A live turn, 390 px and 200% text weren't checked (at ≤ 720 px the panel covers the screen).
- [ ] Review with the user before Phase 6
  - Deferred: the user reviews at the end.

---

## Phase 6: Agents

## Task 29: Team board

**Description:** Port `screens/agents.*` (15.2) onto today's agent data: the filter radiogroup roves (D14), empty-search copy uses curly quotes (M13), and model names come from one catalogue with the "Claude " prefix dropped (D7, M12). Replace `components/v2/agents-view.tsx` and its CSS.

**Acceptance criteria:**
- [x] Every agent the user can see appears, with personal vs workspace scope.
  - Built-in and "Shared with the workspace" badges; personal agents carry none. Opened from the new Agents item in the sidebar (or `?view=agents`); Share and Archive moved into a per-card options menu with the same inline confirm. The old "Browse all agents" list is gone. Handles are derived from the name (`agentHandle`) because the new backend has none (backlog 11).
- [x] Filter and search work by keyboard, and the empty state reads `No agents match “‹query›”`.
  - Headless Chrome: arrow keys move the filter and the count follows; "zzz" shows the empty state and Clear search restores the board. The pins are dots, not the study's drawn push-pins with measured strings.
- [x] `agent-board` and `agents` tests pass.

**Verification:**
- [x] Standard checks

**Dependencies:** C

**Files likely touched:** `frontend/components/v2/agents-view.tsx`, `frontend/lib/agent-look.ts`, `frontend/styles/app/agents.css`, `frontend/styles/v2/agents-view.css`

**Estimated scope:** M

## Task 30: Agent ID desk (four steps)

**Description:** Port `screens/agent-id.*` (15.3, D10) as the create and edit flow, saving only the fields the platform accepts today. The printed-card artwork keeps its scoped raw values (15.4, 19.1). Signature, ID number and the split rules/behaviour/topics fields wait for backlog 11. Replace `components/v2/agent-dialog.tsx` and `tenant/tenant-agent-dialog.tsx`.

**Acceptance criteria:**
- [x] Four steps, with Back and Next by keyboard, and focus moves to each step's heading.
  - Identity, Access, Rules, Sign & issue as a roving tablist; Continue/Back move and focus lands on the step's heading (browser). Done steps show a check. Model cards rove with arrow keys; three featured, "All models (n)" for the rest.
- [x] Creating and editing an agent save the same payload as today.
  - The form state and `submit` are unchanged; only the render moved. Browser: "Deal Desk" was issued through all four steps and appeared on the board.
- [x] `agent-edit` and `tenant-agents` tests pass.
  - `agent-edit.test.ts` went with `legacy/` in Task 4; `tenant-agents` passes, plus 7 new desk tests.

**Verification:**
- [x] Standard checks
- [x] Manual: create an agent and find it on the board
  - Not built (no data, backlog 11): the Rules step's editors (it explains that the agent follows its purpose), the signature pad, the ID number, card flip and the issue seal. The card is the existing lanyard badge, moved to `styles/app/agent-card.css` as sanctioned artwork.

**Dependencies:** 29, 10

**Files likely touched:** `frontend/components/agents/agent-desk.tsx`, `frontend/styles/app/agent-id.css`, `frontend/components/v2/agent-dialog.tsx`, `frontend/components/tenant/tenant-agent-dialog.tsx`

**Estimated scope:** L (split into the desk frame and the card artwork if it grows)

## Checkpoint G: Agents
- [x] Standard checks pass
- [ ] Create, edit and start a chat with an agent
  - Create checked in the browser. Edit and Chat from the board weren't run end to end.
- [ ] Review with the user before Phase 7
  - Deferred: the user reviews at the end.

---

## Phase 7: Remaining screens (restyle only) and cleanup

These screens have no design in the spec (backlog 21). They're restyled with existing tokens, primitives and patterns only, and their behaviour doesn't change.

## Task 31: Sign-in, invitation, workspace choice and name confirmation

**Acceptance criteria:**
- [x] Each screen uses only `tx-*` and `pt-*` plus tokens-only CSS.
  - Buttons are `tx-btn`, the theme switch a roving `tx-seg` radiogroup, headlines take `.t-h2`. Screen classes (`au-*`, `jp-*`) live in `styles/app/auth.css`, tokens only. Two sanctioned exceptions, which the spec's 19.1 should list: Google's sign-in button palette (`--g-*`, fixed by Google's branding rules; added to the checker's allowlist) and the capabilities board illustration (`styles/app/capabilities-board.css`, artwork like the agent card, not on the tokens-only list).
- [x] `login-*`, `auth`, `invite-*`, `session-*` and `workspaces` tests pass.
  - `workspaces.test.ts` went with `legacy/` in Task 4; the pinned theme test now expects the radiogroup (`aria-checked`) instead of toggle buttons (`aria-pressed`).
- [x] `styles/v2/{auth,invite,invite-board,session}.css` are deleted.

**Verification:**
- [x] Standard checks
- [ ] Manual: sign in, accept an invitation and switch workspace
  - Sign-in checked in light, dark and at 390 px, and signing in through the fake Google works. An invitation and a workspace switch weren't exercised: the fixture has no invitation token and only one workspace (/select-tenant goes straight to the chat).

**Dependencies:** B

**Files likely touched:** `frontend/components/auth/*`, `frontend/components/invite/*`, `frontend/app/{login,select-tenant,invite}/*`, `frontend/styles/app/auth.css`

**Estimated scope:** M

## Task 32: Connected tools page and file viewer

**Acceptance criteria:**
- [ ] Connect, disconnect and re-authorise a tool work as they do today.
  - Only the markup changed (old button classes to `tx-btn`, CSS ported to `styles/app/tools.css`); the flows weren't exercised: the browser fixture has no connectors, so the page shows its "aren't available" state (checked in light and dark).
- [ ] The file viewer opens every file kind it opens today.
  - Same: markup classes and CSS (`styles/app/viewer.css`) only; not exercised, as the fixture's agent writes no files and uploads are off.
- [x] `styles/v2/connectors.css` is deleted, and `tenant-connectors` tests pass.
  - `chat-files.css` too. Ported with a converter (old alias tokens to system tokens, raw spacing, radii, sizes and shadows to the lattice), then finished by hand.

**Verification:**
- [x] Standard checks

**Dependencies:** B

**Files likely touched:** `frontend/components/tenant/{connected-tools-screen,connected-tools-page,connected-tools-fallback,file-viewer}.tsx`, `frontend/components/{connected-tools,mcp-settings}.tsx`, `frontend/styles/app/tools.css`

**Estimated scope:** M

## Task 33: Visualize, Goal setup and error pages

**Acceptance criteria:**
- [x] Visualize, the goal bar and timeline, and the error and not-found pages use only system layers.
  - The error and not-found pages are `tx-card tx-state` with a `tx-btn tx-primary` and `.t-h3` heading (`styles/app/errors.css`, tokens only). Visualize and the goal components have no screen to restyle: they were reachable only from `legacy/` and went with it in Task 4.
- [x] `visualization` and `goal*` tests pass.
  - These test `lib/` logic, which is kept.
- [x] The error pages still render if the app's CSS fails to load (`global-error.tsx`).
  - It carries inline styles for its frame and card; a render test checks them.

**Verification:**
- [x] Standard checks

**Dependencies:** B

**Files likely touched:** `frontend/components/{visualization,goal-bar,goal-timeline,goal-completion,goal-reason}.tsx`, `frontend/app/{error,global-error,not-found}.tsx`, `frontend/styles/app/goal.css`

**Estimated scope:** M

## Task 34: Remove the old v2 CSS and token aliases

**Description:** Delete `styles/v2/` (aliases included) once nothing uses it, add every product CSS file to the tokens-only list, and remove dependencies nothing imports any more (for example `class-variance-authority`).

**Acceptance criteria:**
- [x] `styles/v2/` is gone, and every product CSS file passes the tokens-only test.
  - 17 product files in `styles/app/` are on the list; the two artwork files (`agent-card.css`, `capabilities-board.css`) are the sanctioned exceptions. The alias layer (`tokens.css`), `base.css` and `carryover.css` are deleted; the few text utilities still used moved to `styles/app/utilities.css`.
- [x] No old token name (`--accent*`, the old `--ink-*` values) appears in product CSS.
- [x] `package.json` lists no unused dependency.
  - Removed `@legendapp/list` (and its postinstall patch script, test and Dockerfile line) and `@number-flow/react`. Dependencies are now motion, next, react, react-dom, react-markdown, remark-gfm.

**Verification:**
- [x] Standard checks
- [x] The Docker image builds
  - Docker's daemon isn't running on this machine, so the image itself wasn't built. Its build context was reproduced instead: only `frontend/` and `shared/` copied to a temp dir, a clean `npm ci`, then `next build` passed.

**Dependencies:** 12–33

**Files likely touched:** `frontend/styles/v2/*`, `frontend/app/globals.css`, `frontend/test/design-system.test.ts`, `frontend/package.json`

**Estimated scope:** S

## Checkpoint H: Complete
- [x] Standard checks pass, and the Docker image builds
  - 721/721 tests, typecheck clean, `next build` passes; the image's build was reproduced without Docker (see Task 34).
- [ ] The spec's section 20 checklist passes for every screen in all four contexts
  - Not fully run. Checked: tokens-only CSS for every product file (test), one primary per surface on the board and cards (tests), roving tablists and radiogroups (tests and browser), glyph-and-word states (tests), and screenshots of the chat, board, desk, panel and sign-in in light and dark, with light+/dark+ on the chat. Not checked: every screen in light+/dark+, 150%/200% text and 390 px beyond the chat and sign-in, reduced motion beyond the dock, and forced colours.
- [ ] Migration rows done in the port are removed from spec 19.5, with a change-log line
  - Left as is on purpose: rows M1–M3, M5, M8–M13, M16 and M17 describe changes to the `system/` study files, and the app now follows the contract, but the study files themselves weren't edited, so the rows are still true. They're tracked by backlog 20.
- [ ] Review with the user
