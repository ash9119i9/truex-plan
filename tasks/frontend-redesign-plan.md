# Implementation Plan: Frontend redesign (design spec v2)

Added 2026-10-28 · Contract: `system/DESIGN-SPEC.md` v2.0 · Tasks: `tasks/frontend-redesign-todo.md` · Backlog: `backlog/frontend-redesign/`

## Overview

Rebuild every screen in `frontend/` to `system/DESIGN-SPEC.md`: new type, colour, space and corner foundations, `tx-*` controls, `pt-*` layouts, then the shell, chat, reply parts, request cards, Activity Panel, agents board and Agent ID desk, and finally a restyle of the screens the spec doesn't design. This is frontend-only. No platform-next or runtime-adapter contract changes are in this plan; spec content that needs new backend data is built later, together with its backend, from the backlog (items 01–12).

## How it stays shippable

The old v2 tokens (`styles/v2/tokens.css`) and the system tokens share names with different values (for example `--ink-3`: `#849198` vs `#637077`). Running two token sets side by side isn't possible, so:

```text
Phase 0  system foundations load globally; old v2 token names become aliases
         of system tokens → every existing screen keeps working, re-themed
Phase 1+ screens are ported one at a time; each task deletes the old CSS
         and components it replaces
Last     aliases and the remaining v2 CSS are removed; the tokens-only
         check covers all product CSS
```

Every task leaves the app building and usable. Each checkpoint can merge to `main`.

## Architecture decisions

- **Spec is the contract; `system/screens/*` are references.** Ports follow the spec where a study differs (19.5). The JS migration rows (M1 `.rq` rename, M3 and M11 roving focus, M5 button height, M9 shared masking, M10 key bindings, M12 and M13 copy, M16 and M17 off-scale values) are done in the React port, not in the study files.
- **Shared CSS is copied into the app.** The Docker build only copies `frontend/` and `shared/`, so `frontend/` can't import `../system`. Foundation and layer CSS (`type`, `color`, `space`, `corner`, `primitives`, `patterns`) are copied to `frontend/styles/system/`. A test fails if the copies drift from `system/`. CSS migration rows M4, M6, M14, M15 and M18 are applied in `system/` first, then synced.
- **Tokens only, enforced by a test.** A test scans product CSS for raw hex, `px`/`rem` spacing, `font-size`, radius and `box-shadow`, with the 19.1 allowlist. It covers new CSS from Task 1 and widens as old CSS is deleted.
- **Tailwind goes.** Only the preflight reset and `cn()` (tailwind-merge) use it. A small reset of our own replaces preflight, and `clsx` replaces `cn()`.
- **Keep the logic, replace the views.** `lib/tenant-chat.ts`, `lib/tenant-chat-stream.ts`, `lib/subagents.ts`, `lib/observability.ts` and their tests stay. Views in `components/tenant/*` and `components/v2/*` are rewritten to the new layers.
- **Where code lives:** primitives in `frontend/components/tx/` (one file per primitive family, named after its `tx-` class; thin wrappers that type the variants and require labels, with behaviour only where the spec defines it), product CSS in `frontend/styles/app/`, screens stay in `components/tenant/`.
- **Theme follows the spec resolver.** Keys `tx-sys-theme`, `tx-sys-contrast`, `tx-sys-size`. A saved `truex-theme` value is migrated once. The default changes from light to following the OS, as the spec requires.
- **Backlog-dependent UI is not built ahead of its data.** A section with no data source (cost, budget, comparison, checks, footprint split, sources, privacy findings, elicitation, Autopilot, extra agent fields, share) is left out until its backlog item ships it with the backend. No placeholder numbers, no unwired components.
- **Unfinished design gets interim answers** (backlog 13–21):
  - **Icons:** one `<Icon>` sprite component with the spec's ids. Undrawn glyphs use interim paths and are swapped when backlog 13 lands.
  - **Motion:** only `--tx-d-1/2/3` and `--tx-spring`, each with a reduced-motion twin.
  - **Undesigned screens:** restyled with existing tokens and primitives only (spec 0.4).
- **Shortcuts:** ⌘J, ⌘K and ⌘B are bound in Task 13, and ⌘. with the Activity Panel in Task 25. ⌘, and ? are bound with backlog 17, when Settings and the shortcuts sheet exist. `aria-keyshortcuts` names only bound chords.

## Task list

Full task details are in `tasks/frontend-redesign-todo.md`.

### Phase 0: Foundations
- [x] 1. Copy the system CSS into the app, with drift and tokens-only tests
- [x] 2. Theme resolver: theme, contrast, text size, motion
- [x] 3. Load the foundations and fonts; alias the old tokens
- [x] 4. Delete `legacy/chat.tsx` and the CSS and components only it uses
- [x] 5. Remove Tailwind

### Checkpoint A: every route renders on the new foundations, in light, dark, light+ and dark+

### Phase 1: Controls
- [x] 6. Icon sprite component
- [x] 7. Replace `lucide-react`
- [x] 8. Static primitives: Button, Keycap, Pill, Chip, Tile, Card and states
- [x] 9. Roving focus, Tabs and Segmented
- [x] 10. Field, Input, Select, Secret and Switch
- [ ] 11. Menu, Tooltip, Toast, Meter and live cues, plus the shared live region

### Checkpoint B: the controls render in all four contexts, and pass keyboard and 200% checks

### Phase 2: Shell and chat screen
- [x] 12. Shell, sidebar and topbar
- [x] 13. Application keyboard map
- [x] 14. New-conversation hero, composer and agent picker
- [x] 15. Floating dock
- [x] 16. Chat screen at narrow widths and large text

### Checkpoint C: start a chat, send, receive, and switch conversations on the new shell

### Phase 3: Reply parts
- [ ] 17. Turn anatomy and ThinkingBlock
- [x] 18. Shared masking, Working indicator, ToolActivityRow and WebSearchRow
- [ ] 19. DocumentCard and attachments
- [x] 20. TurnError and HelperGroup
- [ ] 21. Plan card, receipt line and trace card

### Checkpoint D: a full streamed turn renders in spec order, and the old transcript CSS is gone

### Phase 4: Blocking requests
- [ ] 22. Request dock and the tool approval card
- [ ] 23. Plan approval and question cards
- [x] 24. ApprovalRecord and policy summary

### Checkpoint E: approve, decline and answer flows work from the dock

### Phase 5: Activity Panel
- [ ] 25. Panel frame, tabs, turn states and foot
- [ ] 26. Activity tab
- [ ] 27. Agent / Sub-agents tab and Files tab
- [ ] 28. Insights tab, with the data that exists

### Checkpoint F: the panel reports a live turn and has no state-changing control

### Phase 6: Agents
- [x] 29. Team board
- [x] 30. Agent ID desk (four steps)

### Checkpoint G: create an agent and find it on the board

### Phase 7: Remaining screens (restyle only) and cleanup
- [x] 31. Sign-in, invitation, workspace choice and name confirmation
- [ ] 32. Connected tools page and file viewer
- [x] 33. Visualize, Goal setup and error pages
- [x] 34. Remove the old v2 CSS and token aliases

### Checkpoint H: complete; the spec's section 20 review checklist passes for every screen

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Token aliases in Task 3 leave old screens unreadable (contrast, spacing) before they're ported | High | Map each old token to the closest system role, and check every route in four contexts at Checkpoint A. Ugly is acceptable, broken is not. |
| Deleting old CSS removes rules a live component still uses (the old files are global and unscoped) | High | Before each deletion, list the file's selectors and grep `components/` and `app/` for them. Delete only the unused ones, and check the screen manually. |
| Old and new class names collide; old CSS already has `.pl-*`, the plan card's prefix | Medium | The plan-card task deletes the old `.pl-*` rules. Each port checks its prefixes against the remaining old CSS. |
| Rewriting `tenant-chat.tsx` (1,560 lines) and `chat-transcript.tsx` (1,703) breaks streaming behaviour the tests don't cover | High | Keep the `lib/` logic untouched. Port one reply part per task, and keep tests passing at each step. Run a live turn by hand at every checkpoint. |
| Render tests load components by path (`component("tenant/chat-transcript.tsx")`), so moving files breaks them | Low | Update the paths in the same task that moves the component. |
| Streaming performance drops with the new markup | Medium | Use the `truex-frontend` skill's streaming checks at Checkpoints C and D. Compare with today's render counts. |
| Google Fonts fail in air-gapped installs | Medium | Keep the font link for now (as today). Self-hosting is an open question. |
| The interim icons and the undesigned screens drift from the final design | Low | One `<Icon>` component and token-only CSS keep each later swap to one file. |

## Out of scope

- Backend work for backlog 01–12, and the designs for 13–21. Each ships from its backlog item.
- platform-next, runtime-adapter, `agent-core/`, `platform/` and `vendor/codex/`.

## Open questions

1. Fonts: keep the Google Fonts link, or self-host now (the spec requires it for air-gapped installs)?
2. Shipping: merge each checkpoint to `main` (my recommendation; every checkpoint leaves the app working), or keep one long branch?
3. `system/` and `backlog/frontend-redesign/` are uncommitted. They should be committed before Task 1 builds on them.
4. Still open from earlier: delete `docs/truex-design-spec.html` (the old v2 spec) and `system/tools/build-spec-html.py`?
