# Truex Frontend Design Revamp — Scope & Coverage Contract

**Status:** Draft v1 for approval
**Date:** 2026-10-26
**Repository:** `truex-plan` · branch `truex_planv2`
**Scope owner:** Product + Design + Frontend
**Implementation source of truth:** current code. Where this document and an older design doc disagree, the code wins.

---

## 0. How to use this document

This is the **design scope contract**, not the visual design itself. It defines every surface, state, and decision the revamp must cover before design is considered complete.

The revamp uses four scope tiers:

| Tier | Meaning | Design expectation |
|---|---|---|
| **P0 — Core** | Shipped product or required for a coherent tenant workspace | Wireframes, hi-fi desktop, hi-fi mobile, all states, copy, a11y annotations, component variants |
| **P1 — Committed near-term** | Already in flight or accepted as near-term product work | Same as P0, but may ship in a second design wave |
| **P2 — Reserved** | Known legacy/future surface, not committed to this revamp | Documented anatomy and verdict; **no final screens**. The design system must be able to absorb it later without new primitives |
| **Retired** | Deliberately not part of the tenant product | No design work; remove or isolate corresponding code/styles when implementation follows |

**What “designed” means here:** every P0/P1 row has a frame for each applicable state, a responsive variant, approved copy, a component specification, and an accessibility annotation. A happy-path screen alone is not complete.

**Scope lock:** after sign-off, adding a new screen, overlay, navigation destination, or message type is a scope change. It requires an explicit amendment to this document. “We’ll add it later” is not allowed for known surfaces — every known surface is already listed below with a verdict.

**Change control:** P2 items may be promoted to P1 only by updating this document and accepting the added design cost. New P0 states discovered during design are added to the relevant coverage table before drawing.

---

## 1. Executive summary

The live tenant app is much smaller than the repository suggests:

- A session-gated login, a chat sidebar, a new-chat hero, a conversation screen, a file viewer, an agent picker/dialog, and a connected-tools page.
- No live settings page, search, agents page, workspace chooser, invite-join screen, goals, plans, helper agents, projects, or insights.

At the same time, a much richer legacy UI exists in [frontend/legacy/chat.tsx](../frontend/legacy/chat.tsx) and the components it imports. It is unreachable from any route, but its CSS is imported globally by [frontend/app/globals.css](../frontend/app/globals.css), so it still affects the live chat. The revamp must either absorb, reserve, or retire every legacy surface — not leave it half-alive.

There are also features in flight: follow-up suggestions, agent-creation fixes, and planned queue/live-thinking/compaction/coding surfaces. These must be in the design now because their states are already part of the product’s near-term UX.

**Target outcome:** one coherent, accessible, responsive tenant workspace with a single design system, complete state coverage, and an explicit register of everything deferred.

---

## 2. Scope decision and assumptions

The recommended scope is **option C: live app + committed near-term features, with legacy catalogued and verdict-ed**. The following decisions are assumed. If any is wrong, correct it before design begins.

| ID | Decision | Assumed default | Why |
|---|---|---|---|
| **D1** | Revamp scope | Live app + P1 near-term features | Keeps the revamp shippable without silently losing the legacy inventory |
| **D2** | Shell / IA | Keep the current tenant shell: sidebar + workspace header + stage; retire the v2 topbar, dock, and alternate sidebar | The v2 shell is not routed; the tenant shell is the real product |
| **D3** | Brand direction | Evolve the current system (Figtree, Newsreader accent, blue palette, robot/lanyard identity), not a full rebrand | A full rebrand adds discovery work not currently scoped |
| **D4** | Mobile | First-class responsive design, not a desktop-only adaptation | The live app already has a mobile drawer and touch-specific composer behavior |
| **D5** | Settings / account / workspace | Deferred to P2; only header-level theme and sign-out are P0 | No live settings routes exist today |
| **D6** | Observability | Quiet usage/receipt line is P0; expanded trace/insights is developer-only/P2 | The live chat exposes usage; the full observability stack is unreachable |
| **D7** | Agent model | One create/edit dialog with name, purpose, scope, look, tint, model, connectors, skills; consider instructions as a P1 addition; **no handles/mentions in v1** | The live dialog has no instructions field; handles are specified in legacy docs but not implemented |
| **D8** | Themes | Light, dark, and system (“Auto”); light remains the default | Matches existing behavior and brand system |
| **D9** | CSS strategy | New design layer with namespaced components; retire legacy global CSS rather than patching specificity | Current collisions are a design and engineering risk |
| **D10** | Search | P1, placed in the sidebar; no command palette in P0 | Search is a trust/basics item, not a live screen |
| **D11** | Activity panel | P0 uses the right panel for files only; multi-tab Activity/Agents/Goal/Plan/Insights is P2 | The tabs have no live data flow |
| **D12** | Agents destination | P1 only if the navigation decision adds an Agents page; otherwise the team pinboard is P2 | No live route exists today |
| **D13** | Legacy goals, plans, helper agents, projects, documents/visualize | P2 reserved unless promoted before sign-off | Not in the tenant chat v1 contract |
| **D14** | Platform admin / operator UI | Out of scope | Platform serves API only today |

---

## 3. Current state audit

### 3.1 Live routes

| Route | What renders | Notes |
|---|---|---|
| `/` | `SessionEntry` → redirect to `/t/:tenantId/chat` | Shows “Opening your workspace…” |
| `/login` | Split login + capabilities board | Redirects signed-in users; maps `?error=` notices |
| `/auth/complete` | `SessionEntry` | Same entry path after Google |
| `/t/[tenantId]` | `TenantWorkspace` + `SessionGate` | Workspace session boundary |
| `/t/[tenantId]/chat` | `TenantChat` | The product’s core screen |
| `/t/[tenantId]/connected-tools` | Connected tools catalog | OAuth return landing |
| `/connected-tools` | Fallback for unreadable OAuth flow | No tenant context |
| `/select-tenant` | Redirect to `/` | Workspace chooser is on hold |
| `/invite/[token]` | Redirect to `/login` | Invitations deferred |
| error boundary / 404 | Error and not-found screens | Global and route-level |

### 3.2 Live screen inventory

- **Auth:** login split screen, capabilities board, Google sign-in, cookie banner, 10 error notices, session gate (checking, signed out, blocked, unavailable), sign-out failure.
- **Workspace chrome:** wordmark, workspace name, person name, theme toggle, sign out, mobile sidebar toggle.
- **Chat:** sidebar/chat list, new-chat hero, time greeting, agent picker, composer, first-message-in-flight state, open-chat header, rename, archive, transcript, streaming, tools, approvals, files, follow-ups, read-only states.
- **Files:** inline file cards, composer chips, sent images, full viewer (Preview/Source, image/markdown/CSV/HTML/text/download-only), writing/saving/unsaved/error states.
- **Agents:** picker groups, selected/unavailable, inline edit/share/archive confirms, create/edit dialog, 12 looks, 5 tints, model, connectors, access, skills, badge preview.
- **Connected tools:** catalog, statuses, connect/reconnect/disconnect/check, OAuth result banners, not-configured/empty/loading/error states, fallback page.
- **System:** loading, empty, error + retry, 404, global error, lost connection, reconnect.

### 3.3 Legacy inventory (unreachable, but still styled)

The legacy UI is a full product generation. It includes:

- Goals with pause/resume, budget, edit, review, completion, timeline.
- Plans with plan approval, plan steps, and a Plan tab.
- Clarification question cards, tool approval cards, approval records.
- Helper agents/subagents with inline groups, chips, agent panel, delegation settings, detail transcripts.
- Projects with per-chat menus and project folders.
- A five-tab activity panel: Activity, Agents, Goal, Plan, Insights.
- Observability: receipt, live usage, trace card, developer details, step timeline, token bar, privacy card, insights KPIs/charts, rate limits.
- Documents and Visualize output, tools sheet, quick tools, slash commands, command result cards.
- MCP settings and a raw capability console.
- A team pinboard (`AgentsView`), a full v2 topbar/sidebar/dock/search palette/user menu, and an alternate agent dialog.
- Invite join page and capability board.
- Read-only views of other members’ chats.

Most of it is dead code; its CSS is not dead. See [V2_UI_COMPONENTS.md](./V2_UI_COMPONENTS.md) for the old catalog, but treat its `LIVE` labels as stale.

### 3.4 In flight

- Follow Up rows under the latest completed answer.
- Agent creation field compaction, preview-note overlap, badge-card rework.
- Planned queue, live thinking, usage/context/timing, compaction status, inline turn errors, coding-agent UI.
- Chat UX basics: drafts, scroll stability, copy/retry/edit, search, notifications.
- Agent celebration and team pinboard specifications.

### 3.5 Constraints and risks

1. **Global CSS collision.** Legacy `app/*.css` and `styles/v2/*.css` are imported globally. New components must not depend on that cascade.
2. **Stale documentation.** [V2_UI_COMPONENTS.md](./V2_UI_COMPONENTS.md) claims screens that no longer exist. Use code as truth.
3. **Auth has more states than screens.** Signed out, blocked, unavailable, session ended, logout failed, cookie blocked, and ten sign-in error codes are all distinct experiences.
4. **The chat is a state machine, not a page.** Streaming, approvals, reconnects, files being written, and follow-up sends all change layout and controls.
5. **Agent creation already overflows laptop height** and has a mobile overlap bug.
6. **File previews include untrusted HTML**, so the design must show trust boundaries (sandboxed preview, unsupported/too large states).
7. **Follow-up quality is not yet measured** against real models; the UI must handle zero/missing rows gracefully.

---

## 4. Design principles

1. **Trust before delight.** The workspace handles private chats, files, and tool actions. Every screen must make it obvious what is private, what will run, and what just happened.
2. **One obvious path.** New chat → pick agent → send → follow the reply → approve if asked → open files. No competing navigation models.
3. **Agent identity is the signature.** Robots, tints, lanyards, and the team board are brand, not decoration. They must remain legible at small sizes and in dark mode.
4. **States are the product.** Empty, loading, error, offline, read-only, expired, and race states get the same care as the happy path.
5. **Plain language.** Say what happened, why, and what to do next. No internal terms (tenant, MCP, runtime) in customer copy.
6. **Progressive disclosure.** Show the answer first; tool details, file internals, and developer traces stay secondary.
7. **No hidden destructive action.** Archive, disconnect, deny, and allow-for-chat must be explicit. Escape must never trigger a destructive choice.
8. **Accessible by default.** Keyboard-first, screen-reader-announced, reduced-motion-safe, 44px touch targets on mobile, no color-only status.
9. **One design system.** No screen-specific visual language. Legacy one-offs are retired, not restyled.
10. **Performance is a design constraint.** Motion, blur, shadows, and large previews must not make the chat feel heavy or block streaming.

---

## 5. Scope map

| Area | Tier | Surfaces |
|---|---|---|
| Foundations | P0 | Brand, color, type, icons, spacing, elevation, motion, themes, breakpoints, a11y |
| IA and shell | P0 | Route map, workspace header, sidebar, mobile drawer, right panel, overlays |
| Auth and session | P0 | Login, Google, notices, session gate, blocked/unavailable, sign-out, errors |
| New chat / hero | P0 | Greeting, agent picker, composer, connect card, first-send state |
| Chat list | P0 | Groups, rows, active/answering, pagination, empty/error, tools footer |
| Chat header | P0 | Title, agent/model, rename, archive, read-only, status |
| Transcript | P0 | User/agent messages, markdown, streaming, tools, approvals, network, files, follow-ups, errors |
| Composer | P0 | Text, attachments, send/stop/steer, limits, disabled/read-only, focus/drop |
| Files | P0 | Chips, cards, images, versions, viewer, previews, unsaved/error |
| Agents | P0/P1 | Picker, create/edit dialog, badge preview, celebration, team board (P1 gated) |
| Connected tools | P0 | Catalog, statuses, actions, OAuth results, fallback |
| Activity / observability | P0/P2 | File panel P0; receipt line P0; expanded trace/insights P2 |
| Settings / workspace | P2 | Profile, workspace switching, members, invites, app settings |
| System states | P0 | Loading, empty, error, offline, reconnect, permission, long content |
| Legacy register | Mixed | See section 14 |
| Planned features | P1/P2 | Queue, thinking, compaction, message actions, search, coding UI, etc. |

---

## 6. Detailed design scope

### 6.1 Foundations — P0

**Design surfaces**

- **Brand:** lowercase `truex` wordmark, `t` mark, “agents” lockup on login, favicon/app icon, social preview. Define clear space and minimum sizes.
- **Color:** light and dark palettes; brand blue, soft ice/pastel companion, graphite ink, semantic success/warning/error/info, agent tints, file-type tones, chart tones. No literal hex outside tokens.
- **Typography:** Figtree for UI/display, Newsreader italic for the single accent phrase, JetBrains Mono for code. Define a 6–8 step scale with weights, line heights, tracking, and one reading measure.
- **Markdown/content typography:** headings, lists, tables, blockquotes, inline code, code fences, links, images, horizontal rules. One content stylesheet, not two.
- **Icons:** 24×24 grid, 1.75 stroke, round caps/joins; sizes 13–22; one icon set only.
- **Agent identity:** 12 robot looks, 5 tints, robot sizes, badge/lanyard anatomy, avatar in transcript, team card, empty/unnamed state.
- **File identity:** MD, XLSX, CSV, HTML, PDF, DOCX tiles, image thumbnails, version badge.
- **Spacing and density:** one spacing scale; compact/comfortable density decision; panel, card, row, and control padding.
- **Radius, border, elevation:** one radius scale; line weights; shadow levels for panel, popover, dialog, toast; dark-mode parity.
- **Motion:** duration/easing tokens; streaming caret, spinner, row reveal, drawer, dialog, follow-up picked, badge drop, confetti; reduced-motion fallback.
- **Themes:** light/dark/system; boot without flash; every surface audited in both modes; agent tints fixed across modes.
- **Layout:** shell columns (sidebar 268px, stage, activity 360–560px), stage reading measures, panel widths, toolbar heights.
- **Breakpoints:** consolidate the current 12 breakpoints into a small set (proposed: 640, 900, 1200, 1440) plus container queries for panels.
- **Accessibility foundation:** focus-visible style, contrast, hit targets, reduced motion, screen-reader naming, keyboard order.

**Must lock before screens**

- Type scale and reading measure.
- Spacing/density scale.
- Radius/elevation set.
- Breakpoint set.
- Focus treatment: one soft outer halo; do not stack a ring on top of a border.
- Theme contract and default mode.
- Token names and deprecated aliases.

**Deliverables:** token sheet, type specimen, color/contrast grid, icon sheet, robot/tint sheet, motion sheet, light/dark comparison boards.

---

### 6.2 Information architecture and shell — P0

**Target navigation model**

- `/` entry → workspace chat.
- `/login` → sign-in.
- `/t/:tenantId/chat` → chat list + conversation + new chat.
- `/t/:tenantId/connected-tools` → tool directory.
- P1 reserved: search overlay and agents destination.
- P2 reserved: settings, workspace switcher, members/invites.

**Workspace header**

- Wordmark, workspace name, signed-in person, theme toggle, sign out.
- Mobile: sidebar toggle, truncated workspace name, compact actions.
- States: long workspace name, long person name, dark mode, narrow width.

**Sidebar**

- New chat button.
- Today / Earlier groups.
- Chat rows: default, hover, focus, active, answering, long title, no title.
- “Show more” / loading more.
- Empty, loading, error + retry.
- Connected tools footer.
- P1: search trigger, agent/team entry, archived chats.
- Mobile: drawer, scrim, focus return, close on navigation.

**Stage and panels**

- Stage header and scroll region.
- Right panel for files; widths 360–560px.
- Panel behavior at ≥900, 640–900, <640: inline, overlay, or hidden.
- Overlay scrims and focus handling.
- No dock, no alternate topbar, no second sidebar in P0.

**Overlays**

- Centered dialog (agent create/edit).
- Popovers/menus if search/filters are added.
- Drawers/sheets on mobile.
- Confirmation patterns for archive, disconnect, deny.
- Toast/status announcements for copied, saved, failed, reconnected.

**Keyboard**

- Enter sends; Shift+Enter newline; Escape closes non-destructive overlays; Escape must not deny an approval.
- Sidebar toggle, search shortcut (P1), new chat shortcut (P1).
- Visible focus order and skip links.

**Design surfaces:** desktop shell board, tablet board, mobile board, drawer board, overlay board, empty/error shell board.

---

### 6.3 Entry, auth, and session — P0

**Screens and states**

1. **Entry:** “Opening your workspace…” redirect.
2. **Login:** split layout, “Sign in or create an account”, “Pick up where your *agents* left off”, 3-step progress, Google button, fine print.
3. **Capabilities board:** eight decorative specimens with readable legend; public-page rule (never show tenant counts or names).
4. **Theme control:** Auto / Light / Dark.
5. **Cookies blocked:** warning banner and recovery copy.
6. **Google pending:** busy button, double-click lock, slow response.
7. **Ten login notices:** cancelled, expired, rejected, account disabled, email in use, sign-ups unavailable, temporarily unavailable, logout failed, signed out, session ended; plus generic fallback.
8. **Session gate loading:** “Checking your session…”.
9. **Signed out:** login card, optional “Try signing out again”.
10. **Blocked:** “Can’t open this workspace”, message, Sign out, Check again.
11. **Unavailable:** “Truex is unavailable”, Try again; never looks like a sign-out.
12. **Session ended in another tab:** info notice, no stale private content.
13. **Sign-out:** immediate view clear, signing-out state, failure notice.
14. **Auth complete:** same entry state as `/`.
15. **Error boundary / 404:** “Something went wrong”, reference id, Try again; “Page not found”, Go to workspace.
16. **Offline:** quiet status, retry, no private content leak.

**P2 reserved:** workspace chooser, confirm-name/profile, manage workspaces, invite join, request-new-invite, multi-workspace switching.

**Rules**

- Never show the previous person’s view after identity changes.
- Never treat an outage as a sign-out.
- Error copy must say what happened, whether the account is safe, and the next action.
- The login page is public: no tenant names, counts, or private data.
- `no-referrer`, no-index, and no token forwarding are product requirements, not only engineering ones.

---

### 6.4 New chat and hero — P0

**Surfaces**

- Time-based greeting: “Good morning”, “Working late”, etc.
- Headline: “What should we work on today?”
- Agent picker: Built-in / Your agents / Shared groups; selected, selected-but-unavailable, loading, error + retry, empty.
- Agent row actions: Edit, Share, Archive; inline confirmations; busy states.
- “New agent” entry.
- Hero composer.
- Connect card when the chosen agent needs a connector.
- First-message-in-flight state before the chat exists.

**States**

- No agents at all.
- Agents loading.
- Agents error.
- Selected agent unavailable.
- Many agents / long agent names.
- Uploads enabled/disabled.
- Files attached or uploading.
- Composer disabled until an agent is chosen.
- First send accepted, creating chat.
- First send refused or unknown outcome.

**Design question to resolve in P1:** how a user changes agent after a chat exists. Today the agent is fixed per chat; the UI has no agent browser after the first message.

---

### 6.5 Chat list and chat header — P0

**Chat list**

- New chat button.
- Today and Earlier group headers.
- Row anatomy: title, timestamp, active indicator, answering pulse.
- Long titles truncate; empty title reads “New chat”.
- Hover, focus, active, answering.
- “Show more” and “Loading…”.
- Empty: “No chats yet. Your chats appear here.”
- Loading: “Loading chats…”.
- Error + Retry.
- Connected tools footer.
- P1: search, archived chats, row menu, unread/failed indicators.

**Chat header**

- Title (truncate), agent · model subtitle, “Agent unavailable” fallback.
- Rename: input, 120-character limit, Save/Cancel, Escape, error.
- Archive: confirmation, “Archive this chat?”, explanation, disabled while a reply runs, error.
- Creating state: no actions until the chat exists.
- Read-only: archived, thread lost, model unavailable, agent unavailable; explanation + Start a new chat.
- P1: connection/status pill, Share placeholder decision, archive restore.

---

### 6.6 Conversation transcript — P0

**Message anatomy**

- User bubble: text, sent images, sent files, “Not sent” state, Resend.
- Agent reply frame: avatar, name, answer body, streaming caret, copy action, interrupted note.
- Steer bubble: a user message inserted into a running reply.
- Run footer: outcome note, usage line, file card, follow-ups.
- Empty transcript: currently renders nothing; **must be designed**.

**Content**

- Markdown headings, lists, tables, blockquotes, links, inline code, fenced code with Copy and Wrap lines, images.
- Long messages: collapse/expand decision.
- Copy per answer and per code block, with copied/failed feedback.
- P1: edit and resend, regenerate, feedback thumbs, sources/citations, new-content pill.
- P2: citations tied to claims, rich source cards.

**Live run states**

- Working / Still working (after 15s).
- Streaming text + caret.
- Progress narration.
- Thinking (P1).
- Retrying / Reconnecting / Stopping / Saving.
- Stop button always reachable while running.
- Lost connection + Reconnect.
- Save failed + automatic retry.
- Outcome: completed, stopped, failed, uncertain.
- Interrupted by a steer / next message.
- P1: compaction marker “Condensing conversation…”.
- P1: depth picker and live thinking disclosure.

**Tool and activity rows**

- Connector tool row: running, completed, failed, duration, approval label.
- Workspace command row: command, live output, output disclosure, status.
- File-change row: files added/changed, multi-file list.
- Skill row: “Used skill <name>”.
- All rows are plain text for untrusted model output; no HTML.
- P2: richer diffs, code viewer, file-change panel for coding agent.

**Approvals**

- Write-tool approval card: title, command or params, Allow once, Allow for this chat, Deny; busy; Already answered; Expired.
- Network card: blocked connection, host, method, detail; Allow once, Allow for this chat (when offered), Keep blocked; “This can’t be allowed”.
- Connector reconnect banner after auth failure.
- Approval cards take focus when they appear; Escape must not deny.
- Resolved approvals become a quiet outcome, not a buttonless card.

**Files in transcript**

- File card header: N files, N ready, N not saved.
- Rows: file, writing, unsaved + Retry, active/open, download.
- Up to 3 rows visible, `+N more`, Show fewer.
- Sent images: loading placeholder, broken image fallback to file chip.
- P1: richer artifact cards; P2: document gallery and saved visualizations.

**Follow Ups (in flight, P0 design)**

- Up to three rows under the latest completed answer.
- Label “Follow Up” (decide final sentence case).
- Act glyph `↗`, reply/other glyph `↳`.
- Two-line clamp; full text in title/tooltip.
- Hover/focus tint; disabled while one is sending; picked row shows spinner.
- Hidden while streaming, during approvals, on stopped/failed/older answers, read-only chats, or when a newer message exists.
- Zero rows/missing rows must leave no gap.
- Failure: rows re-enable, text returns to composer.

**P1/P2 transcript additions**

- P1: copy, retry, edit, regenerate, feedback, inline turn error, search highlight, “new content” pill.
- P2: goal/plan/helper blocks, command result cards, trace receipts, citations, document cards.

---

### 6.7 Composer and input — P0

**Surfaces**

- Hero composer and docked composer.
- Textarea: 2–3 rows initial, auto-grow to 240px, 32,000-character cap, counter after 30,000.
- Attach button, file picker, drag-over, paste files, remove chip.
- Send button, Stop button, steer send while busy.
- Sending state; awaiting approval; disabled without agent; read-only replacement.
- Failure note and stop error.
- Connect card above composer.
- Placeholder “Message <agent>” or “Choose an agent to start”.
- Keyboard hint (screen-reader only); Enter/Shift+Enter; touch devices use the send button.

**P1/P2**

- P1: queue dock with Edit/Remove/Steer now; draft persistence; starter prompts; capability chips; large-paste-as-file.
- P2: goal mode/budget, approval mode, privacy note, slash commands, model/effort picker.

**Rules**

- Files cannot be attached to a running reply; explain why.
- Sending while busy is a steer; the button label/title must make that clear.
- Stop is never hidden behind a menu.
- A failed send must keep the typed text and explain whether retry is safe.
- Upload failures stay visible on the chip until removed or retried.
- Do not silently hide attachments when uploads are disabled; explain the state once.

---

### 6.8 Files and artifacts — P0

**Composer and transcript**

- Draft chips: file tile or image, name, size, Uploading, failed reason, remove.
- Sent attachments: images as thumbnails, other files as chips with size.
- File cards: writing, saved, unsaved, version badge, active row, overflow.
- Image loading and broken-image fallback.

**File viewer**

- Header: file tile, name, version, type/size/lines, writing/saving, previous/next “1 of N”, close.
- Preview/Source tabs only when source exists and preview is meaningful.
- Actions: Copy (text), Download (disabled until saved).
- Body states: skeleton, writing text, saving, missing, error + Try again, unsupported + Download, too large + Download, image, text/code, markdown, CSV grid, sandboxed HTML.
- CSV truncation note; empty file note; HTML source during streaming.
- Unsaved file: “This file couldn’t be saved” + Retry; no open/download until saved.
- Focus moves to the file name on open; Escape closes.
- Responsive: inline panel on wide screens, overlay on narrow; chat shrinks before the panel floats.

**P2**

- Document gallery, uploaded documents, saved visualizations, visual artifact viewer.

---

### 6.9 Agents — P0/P1

**Picker (P0)**

- Groups: Built-in, Your agents, Shared.
- Row states: default, selected, unavailable, editing, confirming archive.
- Inline Edit, Share, Archive; focus and busy states.
- Empty group copy.
- New agent entry.

**Create/edit dialog (P0)**

- Two-column desktop layout: form left, lanyard badge preview right.
- Mobile: single page; preview integrated, no overlap.
- Fields:
  - Name (60).
  - Purpose (280, counter).
  - Who can use it: Just me / Everyone in this workspace (create only).
  - Look: 12 robots.
  - Tint: 5 swatches.
  - Model select; unavailable current model state.
  - Connected tools: up to 3, token estimate, not-connected hint, Read and write / Read only when write tools exist, cap message.
  - Skills: up to 10, unavailable/needs-coding notes, cap message.
  - Instructions (if retained; decide placement and limit).
- Validation, required fields, save error, stale revision error.
- Actions: Cancel, Create agent / Save changes; disabled until valid; busy labels.
- Preview: name, scope, model, unnamed state; drag with spring-back; note must not overlap.
- Success: decide between close-only and celebration (badge drop, confetti, “is on the team”, Say hi). P1.
- Height target: no scrolling at 1440×900 and 1280×800; mobile scrolls as one page.

**P1 gated**

- Agents/team page with pinboard: grid paper, tilted cards, pins, active “in chat” badge, search, All/Yours/Built-in filter, New agent card, count.
- Agent profile/detail surface if a team page is added.
- Share flow: who can use it, confirmation, resulting scope label.

**Explicitly retired**

- `@handle` display and mention syntax in v1.
- Legacy instructions-only agent model; unify into the current dialog.
- Separate v2 agent-menu popover.

---

### 6.10 Connected tools — P0

**Catalog screen**

- Header: “Connected tools”, explanation, read-only promise (must be reconciled with read/write agent access — see risk R1).
- Loading, error + Try again, not configured, empty.
- Connector row: logo, name, status dot/label, detail (account, tool count), description, actions.
- Statuses:
  - Not connected → Connect.
  - Connected → Check connection, Disconnect.
  - Reconnect needed → Reconnect.
  - Needs admin approval → Try again + admin help link.
- Busy labels: Starting…, Checking…, Disconnecting….
- Disconnect result: manual revoke hint when provider revoke fails.
- Row error messages.
- OAuth success banner: “<Tool> is connected.” + Back to chat.
- OAuth error codes: cancelled, state invalid/expired, not member, exchange failed, verify failed, permissions missing, unavailable, generic.
- Fallback page for OAuth returns without a readable flow.

**P2**

- MCP server add/edit, auth headers, elicitation card, connector status/edit inside chat.
- Admin-level connector management.

---

### 6.11 Activity, insights, and observability — P0/P2

**P0**

- Right panel hosts the file viewer only.
- Quiet usage line under a settled reply when usage exists.
- Read-only/archived/outcome notes.
- Error reference on global errors.

**P2**

- Receipt expansion: duration, tokens, where time went, what it used, privacy.
- Trace card, developer details (turn/thread IDs, model context, JSON copy).
- Step timeline, token bar, privacy card, insights KPIs/charts, rate limits.
- Activity/Agents/Goal/Plan/Insights tabs.
- Developer mode toggle.
- Decision: if revived, these are **developer-only** or a separate secondary surface, not primary chat chrome.

---

### 6.12 Settings, account, workspace — P2 (deferred)

No settings route exists today. The revamp reserves space and components for:

- Profile/name, avatar/initials.
- Theme preference (already in header).
- Workspace switching / chooser.
- Members, roles, invitations.
- Agent management page (if added at P1).
- Archived chats.
- Connection settings entry.
- App preferences (notifications, density, keyboard).

**P0 only:** theme toggle and sign out in the workspace header; no settings page is drawn.

---

### 6.13 System and edge states — P0

Every P0 screen must specify:

- **Loading:** skeleton, spinner, or status line; no layout jump.
- **Empty:** explanation plus the next action.
- **Error:** what happened, what is safe, Retry or alternate path; error reference where relevant.
- **Busy:** buttons disabled with explicit labels; no duplicate submission.
- **Offline/reconnecting:** quiet status, no red alarm unless unrecoverable.
- **Read-only/permission:** why, what remains possible, Start a new chat or equivalent.
- **Expired/race:** approval expired/already answered; message send uncertain; file unsaved.
- **Long content:** long title, long agent/workspace names, long answer, many files, many chats, many agents, large payload.
- **Destructive confirmation:** archive, disconnect, deny; explicit, no Escape-to-confirm.
- **Screen reader:** live announcements for streaming status, approvals, file save, follow-up send, connection.
- **Reduced motion:** no spinner-only meaning; no essential motion.

---

## 7. Universal state checklist

For every P0/P1 screen, produce these states unless explicitly excluded:

| State | Required |
|---|---|
| Default / populated | Yes |
| Loading (first load and background refresh) | Yes |
| Empty (no data, no agents, no chats, no files) | Yes |
| Error with recovery | Yes |
| Busy / submitting / streaming | Yes |
| Disabled / unavailable | Yes |
| Read-only / permission denied | Yes |
| Offline / reconnecting / lost | Yes |
| Expired / race lost | Where applicable |
| Long content / overflow | Yes |
| Mobile layout | Yes |
| Dark theme | Yes |
| Keyboard focus path | Yes |
| Reduced motion | Yes |

---

## 8. Component library

The following must exist as reusable specifications with all variants and states. No screen may invent a one-off.

**Primitives**

- Button: solid, soft, danger, ghost, text; small/medium/large; icon-only; busy; disabled.
- Link, text button, external-link treatment.
- Input, textarea, select, checkbox, radio, segmented control, switch if needed.
- Field label, hint, counter, error, required marker.
- Chip, badge, status dot, status pill, count badge.
- Avatar, robot avatar, initials avatar, person row.
- Card, list row, panel header, section header, eyebrow.
- Menu, popover, dialog, sheet/drawer, scrim, tooltip.
- Tabs, accordion/details, disclosure.
- Banner, notice, inline alert, toast/status, progress bar, meter, spinner, skeleton.
- Empty state, error state, retry block.
- Code block with Copy and Wrap, markdown body, table.
- File tile, file row, file card, file viewer.
- Agent badge/lanyard, robot look picker, tint picker.
- Approval card, network card, tool row, activity row, follow-up row, queue item.
- Data-viz primitives only if P2 observability is revived.

**Patterns**

- Confirmation pattern (danger, explanation, two actions).
- Destructive flow (archive, disconnect).
- Permission/approval pattern (once, for chat, deny).
- Streaming status pattern.
- Attachment/upload pattern.
- OAuth result pattern.
- Global error pattern.
- Search result row (P1).
- Agent creation success pattern (P1).

**Component contract**

Each component spec includes: anatomy, sizes, spacing, color roles, type role, states, content rules, keyboard behavior, screen-reader behavior, responsive behavior, do/don’t examples.

---

## 9. Responsive and device coverage

**Target widths**

- Mobile: 360–639 (test 390×844, 360×800).
- Small tablet: 640–899 (test 768×1024).
- Desktop: 900–1199 (test 1024×768).
- Wide desktop: 1200+ (test 1280×800, 1440×900).
- Large: 1920×1080 sanity check.

**Rules**

- Sidebar becomes a drawer below 720px; scrim; Escape/close returns focus.
- File viewer becomes an overlay when the chat would fall below a readable measure; chat shrinks before the panel floats.
- Composer sticks to the bottom; safe-area insets on phones; keyboard opening must not hide the send/stop control.
- Touch targets at least 44×44 CSS px on coarse pointers; compact 32px controls only on fine pointers.
- Tables and code blocks scroll horizontally; no page-level horizontal scroll.
- Long agent/workspace/person names truncate, not wrap into controls.
- Dialog fits at 1280×800 and 1440×900; mobile is one scrollable page with pinned actions.
- Test with 200% browser zoom.
- Container queries for panel contents where useful; do not let one breakpoint system fight another.

---

## 10. Accessibility acceptance

Target: WCAG 2.2 AA.

- Contrast: fix `--ink-3` for small metadata and avoid raw accent blue for text; use the darker text accent. Every semantic pair passes in light and dark.
- Focus: one soft outer halo, visible on all backgrounds, not clipped by overflow; never remove focus without a replacement.
- Keyboard: every control reachable; logical order; dialogs trap focus and restore it; menus use correct roles and roving focus; Escape closes only non-destructive layers.
- Screen reader: live regions for streaming/working/approval/save/reconnect; decorative spinners hidden; agent/tool/file names announced; status not conveyed by color alone.
- Targets: 44px on touch; at least 24px on desktop.
- Motion: `prefers-reduced-motion` respected globally; no essential information only in animation.
- Zoom: no loss of function at 200%; no content clipped.
- Forms: labels, hints, errors connected; no placeholder-only labels.
- Markdown: a single H1 per page; transcript headings do not break document structure.
- File preview: sandboxed HTML, clear external/download behavior, accessible table and image names.
- Approval cards: focus moves to the card; buttons are explicit; “Deny” is never the default focused action.
- Test matrix: keyboard-only, screen reader (VoiceOver), 200% zoom, dark mode, reduced motion, mobile touch.

---

## 11. Content and tone

**Voice**

- Warm, plain, second person, sentence case, contractions.
- Say what happened and what to do next.
- Apologize only when the product caused the problem.
- No internal jargon: tenant, MCP, runtime, thread, sandbox, capability, token.
- Use curly quotes and proper punctuation.
- Keep destructive verbs literal: Archive, Disconnect, Deny, Keep blocked.

**Terminology decisions**

| Use | Avoid | Notes |
|---|---|---|
| Workspace | Tenant | Customer-facing |
| Chat | Conversation, session, thread | One term everywhere |
| Agent | Assistant, bot | “Agent” is the product term |
| Purpose | Description | Agent dialog field |
| Connected tools | Connectors, MCP | Customer-facing |
| Follow up | Follow Up / follow-up suggestions | Decide sentence case before final copy |
| Allow once / Allow for this chat / Deny | Accept / Reject | Approval verbs |
| Keep blocked | Deny | Network cards, if kept distinct |

**Copy deliverables**

- Screen-by-screen copy deck.
- Error catalogue with cause, safe-state reassurance, next action.
- Empty-state catalogue.
- Approval and destructive-action copy.
- Agent creation labels, hints, validation.
- File and connector status copy.
- Auth notices (all ten codes).
- Accessibility labels and announcements.

**Open copy conflict:** connected tools says “Everything stays read-only”, while agents can be set to “Read and write”. Resolve before design sign-off.

---

## 12. Motion specification

- Tokens: fast 120ms, standard 180–220ms, slow 280–320ms; standard easing, entrance easing, spring for badge drag.
- Streaming caret: steady, reduced-motion-safe.
- Working spinner: not the only signal; pair with text.
- Follow-up row: picked spinner; rows disable together; no layout jump.
- Drawer/scrim: slide + fade; focus moves with it.
- Dialog: fade/scale; no bounce; reduced motion removes scale.
- Agent badge: drag with resistance and spring-back; drop/celebration only once; reduced motion shows static success.
- File viewer: panel expand/collapse; no layout jump in transcript.
- Status changes: no flashing; use text plus color.
- Never animate layout that would move the reader’s scroll position.

---

## 13. Theme specification

- Light default; dark and system selectable; persist through reload without flash.
- Every screen gets a light and dark board.
- Agent tints and robot colors stay fixed across themes; badge background remains legible.
- File type tones remain distinguishable in both modes.
- Elevation and borders have dark counterparts; `shadow-sm` must not remain light-only.
- Login capabilities board, OAuth banners, charts, code blocks, and sandboxed HTML previews all audited.
- No hard-coded white/black in components; exceptions (Google mark, lanyard) are documented assets.

---

## 14. Legacy feature register

Every legacy surface gets a verdict. “Reserve” means it is documented here but not drawn in this revamp.

| Legacy surface | Source | What it offers | Verdict | Tier |
|---|---|---|---|---|
| Goals, goal bar, budget, review, timeline | `goal-*.tsx`, `legacy/chat.tsx` | Persistent objective, pause/resume, budget, accept/reopen | Reserve | P2 |
| Plans, plan steps, plan approval | `plan-steps.tsx`, `request-card.tsx` | Plan-first execution and approval | Reserve; revisit with coding workflow | P2 |
| Clarification question cards | `request-card.tsx` | Multi-question, options, “something else”, secret | Reserve | P2 |
| Helper agents / subagents | `agents-panel.tsx`, `helper-*.tsx` | Delegation, inline helper groups, per-agent timelines | Reserve | P2 |
| Projects | `project-sidebar.tsx` | Chat folders and project menus | Retire for v1 | Retired |
| Five-tab activity panel | `session-activity.tsx` | Activity, Agents, Goal, Plan, Insights | Files-only panel in P0; tabs reserved | P2 |
| Observability stack | `components/observability/*` | Receipt, trace, step timeline, token bar, privacy, insights | Quiet usage line P0; expanded trace P2 developer-only | P0/P2 |
| Documents and Visualize | `assistant-tools.tsx`, `visualization.tsx` | Uploaded docs, saved visuals, generated charts | Reserve; file viewer covers artifacts | P2 |
| MCP settings / capability console | `mcp-settings.tsx`, `capabilities.tsx` | Attach servers, raw capability runner | Retire member UI; admin/debug only if needed | Retired |
| Quick tools / slash commands | `quick-tools.tsx`, `slash-commands.ts` | Fork, compact, model/effort, slash menu | Retire for v1 | Retired |
| v2 sidebar/topbar/dock/user menu | `components/v2/*` | Alternate shell and navigation | Retire shell/dock/topbar; search P1; pinboard P1 gated | Mixed |
| v2 agent dialog | `v2/agent-dialog.tsx` | Handle, instructions, confetti, Say hi | Fold celebration into current dialog; handles retired | P1 |
| Invite join page | `invite/join-page.tsx` | Invitation acceptance, profile name, states | Defer; board stays on login | P2 |
| Workspace chooser / confirm name / manage | Docs only | Multi-workspace, profile, members | Defer; current routes redirect or absent | P2 |
| Read-only teammate chats | `legacy/chat.tsx` | View another member’s chat | Retire; chats are private | Retired |
| Share chat | v2 topbar placeholder | Share a chat | Defer; no flow exists | P2 |
| Privacy note / approval modes | legacy composer | Draft privacy warning, approval mode picker | Retire for v1 | Retired |

**Why this matters:** if a P2 item is later promoted, it must reuse the P0 shell, panels, cards, buttons, and tokens. It may not reintroduce the old topbar, dock, or raw MCP terminology.

---

## 15. Planned and future features

| Feature | Tier | Design status |
|---|---|---|
| Follow Up rows | P0 | Live; design all show/hide/failure/loading states |
| Agent creation compaction and preview fixes | P0 | Design required; test 1280×800, 1440×900, 390×844 |
| Agent creation celebration | P1 | Badge drop, confetti, “is on the team”, Say hi |
| Queue dock | P1 | Queued messages above composer; Edit/Remove/Steer now; cap; failure |
| Live thinking / depth | P1 | Streaming thinking, collapsed “Thought for Ns”, Fast/Balanced/Deep |
| Usage, context, timing | P1 | Quiet line plus expanded detail; context meter |
| Compaction status | P1 | “Condensing conversation…” and Stop decision |
| Inline turn errors | P1 | Error in the transcript, not only a page banner |
| Message actions | P1 | Copy, retry, edit, regenerate, feedback |
| Chat search | P1 | Sidebar entry + results; no command palette unless decided |
| Scroll stability / new-content pill | P1 | Sticky scroll and reader position |
| Draft persistence | P1 | Survives refresh, chat switch, failed send |
| Background completion notification | P1 | Tab title and/or desktop notification; permission state |
| Agent team pinboard | P1 gated | Grid paper, pins, search, filters, active “in chat” |
| Coding agent UI | P2 | Commands, diffs, files panel, approvals; waits on AgentCore |
| Sources and citations | P2 | Source cards tied to claims |
| Clarification chips | P2 | One-tap answers, plan controls |
| Templates, scheduling, memory | P2 | Save prompt, recurring task, memory disclosure |
| Workspace/invite/settings | P2 | Deferred |
| Admin/operator console | Out | Not customer frontend |

---

## 16. Deliverables

Design is complete only when these exist:

1. **Scope decision log** — this document, approved.
2. **Sitemap and route map** — every P0/P1 destination and overlay.
3. **User flows** — first sign-in, resume session, new chat, streaming, approval, file open, agent creation, connector connect, error recovery.
4. **Wireframes** — every P0 screen and overlay, including mobile.
5. **Hi-fi screens** — P0 and P1, desktop and mobile, light and dark.
6. **State boards** — universal state checklist applied per screen.
7. **Component library** — every component in section 8, all variants and states.
8. **Design tokens** — color, type, space, radius, elevation, motion, breakpoints; exported for implementation.
9. **Content deck** — all copy, errors, empty states, approvals, accessibility labels.
10. **Motion spec** — tokens, key transitions, reduced-motion fallbacks.
11. **Accessibility annotations** — focus order, roles, announcements, contrast, touch targets.
12. **Prototypes** — first-run auth, first message, streaming + approval, file viewer, agent creation, connector failure.
13. **Redlines / handoff notes** — responsive behavior, overflow, truncation, edge cases.
14. **Design QA checklist** — browser/device/theme/a11y verification.
15. **Legacy migration note** — what CSS/components are retired and in what order.

Recommended design-file structure:

- `00 · Cover & scope`
- `01 · Foundations`
- `02 · Components`
- `03 · Auth & session`
- `04 · Shell & navigation`
- `05 · New chat`
- `06 · Conversation`
- `07 · Composer`
- `08 · Files`
- `09 · Agents`
- `10 · Connected tools`
- `11 · System states`
- `12 · Motion & prototypes`
- `13 · Handoff & QA`
- `99 · Reserved / legacy`

---

## 17. Definition of done

A design pass is complete when all of the following are true:

- [ ] Every P0/P1 row in this document has a named screen or component.
- [ ] Every applicable state in the universal checklist has a frame.
- [ ] Desktop and mobile layouts exist for every P0 screen.
- [ ] Light and dark themes exist for every P0 screen.
- [ ] Empty, loading, error, busy, offline, read-only, expired, and long-content states are drawn.
- [ ] Approval, destructive, and OAuth flows have success and failure frames.
- [ ] Agent creation fits 1280×800 and 1440×900 without scrolling.
- [ ] All copy is approved and uses the terminology table.
- [ ] Contrast and focus pass WCAG 2.2 AA checks.
- [ ] Keyboard and screen-reader behavior is annotated for every interactive component.
- [ ] Reduced-motion behavior is specified.
- [ ] Tokens are used everywhere; no unexplained literal colors.
- [ ] Legacy CSS dependencies are removed or explicitly isolated in the implementation plan.
- [ ] Prototypes cover first sign-in, first message, approval, file, and agent creation.
- [ ] Frontend has reviewed and accepted the handoff.
- [ ] No P2 screen has been drawn unless promoted by amendment.

---

## 18. Out of scope

- Platform operator/admin dashboard and tenant management UI.
- Billing, pricing, plans, and subscription screens.
- Marketing site, emails, and sales collateral.
- Native mobile apps.
- Localization and RTL layout in this revamp.
- Full legacy feature parity (goals, plans, helper agents, projects, insights, documents/visualize).
- Workspace chooser, invitations, member management, multi-workspace switching.
- Raw command, path, credential, or host-execution UI.
- MCP server configuration UI for members.
- Shared/teammate chat viewing.
- Full observability dashboards as primary product chrome.
- The v2 floating dock, alternate topbar, alternate sidebar, and agent menu.

---

## 19. Risks and dependencies

| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Connected tools says read-only while agents can be read/write | Trust and legal confusion | Resolve copy and permission model before final screens |
| R2 | Legacy CSS still styles live components | Revamp regressions | Namespace new design; retire old CSS; visual regression tests |
| R3 | Auth has many failure states not represented in current screens | Users stranded or confused | Design all gate states and error notices |
| R4 | Streaming/approval races (already answered, expired, uncertain send) | Duplicate or contradictory actions | Design race states explicitly; test with mocked slow APIs |
| R5 | Agent dialog overflow and mobile overlap | Cannot create agents on common laptops/phones | Design to height targets; test 390×844, 1280×800, 1440×900 |
| R6 | Follow-up model output is unreliable | Empty or malformed rows | Design zero-row and failure states; hide cleanly |
| R7 | File previews include untrusted HTML and large files | Security and performance | Sandboxed preview, download fallback, size limits |
| R8 | Legacy docs say screens are live when they are not | Wrong scope | Code is truth; this register is the design truth |
| R9 | P2 promotion becomes scope creep | Design slips | Amendment + cost estimate required |
| R10 | Mobile keyboard/safe-area behavior is untested | Composer or actions hidden | Device testing; sticky composer; 44px controls |

**Dependencies:** final terminology decision; read/write connector policy; whether agent instructions are added and how handles are handled; search placement; whether an Agents page exists; whether the queue is server-stored; whether coding UI is in the next release.

---

## 20. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Product |  | Approve / request changes |  |
| Design |  | Approve / request changes |  |
| Frontend |  | Approve / request changes |  |
| Security/Privacy |  | Approve / request changes |  |

**After sign-off:** no new screen, overlay, navigation entry, message type, or approval variant is added without updating this document. The design system may absorb P2 surfaces, but it may not be extended with new patterns for them.

---

## Appendix A — Route and source map

**Routes**

- `/` → `frontend/app/page.tsx` → `SessionEntry`
- `/login` → `frontend/app/login/page.tsx` → `LoginScreen`
- `/auth/complete` → `SessionEntry`
- `/t/[tenantId]` → `frontend/app/t/[tenantId]/layout.tsx` → `TenantWorkspace`
- `/t/[tenantId]/chat` → `TenantChat`
- `/t/[tenantId]/connected-tools` → `ConnectedToolsPage`
- `/connected-tools` → `ConnectedToolsFallback`
- `/select-tenant` → redirect
- `/invite/[token]` → redirect

**Core components**

- [frontend/components/tenant/tenant-chat.tsx](../frontend/components/tenant/tenant-chat.tsx)
- [frontend/components/tenant/chat-transcript.tsx](../frontend/components/tenant/chat-transcript.tsx)
- [frontend/components/tenant/chat-composer.tsx](../frontend/components/tenant/chat-composer.tsx)
- [frontend/components/tenant/chat-list.tsx](../frontend/components/tenant/chat-list.tsx)
- [frontend/components/tenant/follow-up-rows.tsx](../frontend/components/tenant/follow-up-rows.tsx)
- [frontend/components/tenant/file-card.tsx](../frontend/components/tenant/file-card.tsx)
- [frontend/components/tenant/file-viewer.tsx](../frontend/components/tenant/file-viewer.tsx)
- [frontend/components/tenant/agent-picker.tsx](../frontend/components/tenant/agent-picker.tsx)
- [frontend/components/tenant/tenant-agent-dialog.tsx](../frontend/components/tenant/tenant-agent-dialog.tsx)
- [frontend/components/tenant/connected-tools-screen.tsx](../frontend/components/tenant/connected-tools-screen.tsx)
- [frontend/components/auth/session-gate.tsx](../frontend/components/auth/session-gate.tsx)
- [frontend/components/auth/login-card.tsx](../frontend/components/auth/login-card.tsx)
- [frontend/components/auth/tenant-workspace.tsx](../frontend/components/auth/tenant-workspace.tsx)
- [frontend/legacy/chat.tsx](../frontend/legacy/chat.tsx) (legacy reference only)

**Foundations**

- [frontend/styles/v2/tokens.css](../frontend/styles/v2/tokens.css)
- [frontend/styles/v2/base.css](../frontend/styles/v2/base.css)
- [frontend/styles/v2/shell.css](../frontend/styles/v2/shell.css)
- [frontend/styles/v2/tenant-chat.css](../frontend/styles/v2/tenant-chat.css)
- [frontend/styles/v2/chat-files.css](../frontend/styles/v2/chat-files.css)
- [frontend/styles/v2/connectors.css](../frontend/styles/v2/connectors.css)
- [frontend/lib/use-theme.ts](../frontend/lib/use-theme.ts)

**State and copy sources**

- [frontend/lib/tenant-chat.ts](../frontend/lib/tenant-chat.ts)
- [frontend/lib/tenant-connectors.ts](../frontend/lib/tenant-connectors.ts)
- [frontend/lib/tenant-files.ts](../frontend/lib/tenant-files.ts)
- [frontend/lib/tenant-network.ts](../frontend/lib/tenant-network.ts)
- [frontend/lib/tenant-agents.ts](../frontend/lib/tenant-agents.ts)
- [frontend/lib/tenant-uploads.ts](../frontend/lib/tenant-uploads.ts)
- [frontend/lib/login.ts](../frontend/lib/login.ts)
- [frontend/lib/agent-look.ts](../frontend/lib/agent-look.ts)

**Design references**

- [docs/truex-design-spec.html](./truex-design-spec.html) — old v2 spec; inventory source only.
- [docs/V2_UI_COMPONENTS.md](./V2_UI_COMPONENTS.md) — old catalog; status labels stale.
- [docs/CHAT_UI_SCHEMA.md](./CHAT_UI_SCHEMA.md) — legacy UI schema.
- [docs/FOLLOW_UPS.md](./FOLLOW_UPS.md) — follow-up contract.
- [docs/mockups/follow-up-suggestions.html](./mockups/follow-up-suggestions.html) — follow-up mockup.

---

## Appendix B — State taxonomy

**Message states:** `complete`, `stopped`, `failed`, `interrupted`, `not_sent`.

**Run statuses:** `accepted`, `running`, `completed`, `stopped`, `failed`, `uncertain`.

**Live phases:** `waiting`, `streaming`, `retrying`, `stopping`, `reconnecting`, `settled`.

**Read-only reasons:** archived, `THREAD_LOST`, `MODEL_UNAVAILABLE`, `AGENT_UNAVAILABLE`.

**Approval statuses:** `pending`, `allow`, `allow_for_chat`, `deny`; races: already answered (`APPROVAL_RESOLVED`), expired (`APPROVAL_NOT_FOUND`).

**Network decisions:** `allow_once`, `allow_for_chat`, `keep_blocked`; grants: `once`, `chat`, `none`.

**Tool statuses:** `inProgress`, `completed`, `failed`; error codes: `REFUSED`, `TOOL_ERROR`, `TIMEOUT`, `UNKNOWN`.

**Connector statuses:** `not_connected`, `active`, `needs_reconnect`, `needs_admin_approval`.

**File preview kinds:** `markdown`, `csv`, `html`, `image`, `text`, `none` (download only).

**File states:** writing, saving, saved, unsaved, missing, error, loading, unsupported, too large.

**Agent fields:** name ≤60, purpose ≤280, max 3 connectors, max 10 skills, 12 looks, 5 tints, personal/workspace scope.

**Message limits:** 32,000 characters; counter appears at 30,000. Title ≤120 characters. Up to 10 attachments, subject to workspace upload settings.

---

## Appendix C — Documentation reconciliation

The following older docs must not be treated as implementation truth. Reconcile or archive them before final handoff:

- `V2_UI_COMPONENTS.md` claims “Select workspace LIVE”, “Confirm name LIVE”, “Manage workspaces BUILT”, a 5-second recheck, and a Share flow. None are live.
- `CHAT_UI_SCHEMA.md` describes the legacy chat extensively; useful for inventory, not current behavior.
- `truex-design-spec.html` describes the v2 shell, dock, session panel, and agents board; most markup is unmounted.
- `onboarding-flow.html` describes admin/member screens that have no frontend route.
- `join-tenant-v3-dev-spec.html` describes the invite join flow that currently redirects to `/login`.

**Standing rule:** if a doc and the running code disagree, the code wins and the doc gets a note.
