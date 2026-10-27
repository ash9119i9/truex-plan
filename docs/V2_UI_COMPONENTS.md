# Truex v2 UI component catalog

Every screen, component, chart and card in the app. Each entry gives its anatomy (the parts you see, in order), its data (real field names and every allowed value), its states, and its buttons with what they do. Use it to design the v2 revamp.

Verified against the code on 2026-10-19 (`truex_planv2` @ `b9cfd72`). Visual tokens come from `docs/truex-design-spec.html` and `frontend/styles/v2/tokens.css`. For implementation detail see `docs/CHAT_UI_SCHEMA.md`, which is older (2026-10-01).

Status tags:

| Tag | Meaning |
|---|---|
| `LIVE` | Built and on the current tenant chat (`/t/[tenantId]/chat`, platform-next) |
| `BUILT` | Built in the legacy chat stack (`frontend/legacy`, platform). Not yet on platform-next |
| `PROTOCOL` | The runtime sends this data, but nothing in the app shows it yet |
| `NEW` | New in v2. Proposed here; it has no code yet |

---

## Contents

1. [Foundations and shared primitives](#1-foundations-and-shared-primitives)
2. [App shell](#2-app-shell)
3. [Composer](#3-composer)
4. [Chat stream: one AI turn](#4-chat-stream-one-ai-turn)
5. [Plan mode](#5-plan-mode)
6. [Requests and approvals (questions, MCP approval, elicitation)](#6-requests-and-approvals)
7. [Goals](#7-goals)
8. [Agents and helper agents](#8-agents-and-helper-agents)
9. [MCP connectors](#9-mcp-connectors)
10. [Session panel (activity bar)](#10-session-panel-activity-bar)
11. [Insights and charts](#11-insights-and-charts)
12. [Conversation tools and slash commands](#12-conversation-tools-and-slash-commands)
13. [Auth and workspace screens](#13-auth-and-workspace-screens)
14. [Events → components map](#14-events--components-map)
15. [Open items for v2 design](#15-open-items-for-v2-design)

---

## 1. Foundations and shared primitives

### 1.1 Color tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` (`--brand-500`) | `#3691CD` | `#3691CD` | Primary action |
| `--accent-2` | `#2A7DB4` | `#5AA8DC` | Hover, dots, progress, focus |
| `--accent-pressed` | `#226A9B` | `#226A9B` | Pressed |
| `--accent-soft` | `#EAF5F8` | `#14283A` | Selected / secondary (ice) |
| `--accent-soft-2` (`--signature`) | `#BCDEE8` | `#1F4461` | Pastel border, default agent hue |
| `--accent-fg` | `#2A72A3` | `#BCDEE8` | Blue text/icons, focus ring |
| `--on-accent` | `#FFFFFF` | `#FFFFFF` | Text on accent |
| `--bg` / `--surface` | `#FFFFFF` | `#171717` | Page / cards |
| `--surface-3` | `#F6F9FA` | `#242424` | Soft surface, hover |
| `--line` | `#E3ECEF` | `#2A2A2A` | Borders |
| `--line-strong` | `#D8E0E4` | `#363636` | Strong borders, controls |
| `--ink` / `--ink-2` / `--ink-3` | `#1F2A30` / `#5F6D73` / `#849198` | `#EEF4F6` / `#B7C3C8` / `#8B999F` | Text: primary / secondary / muted |
| `--ink-disabled` | `#B4BEC3` | `#4E5C62` | Disabled |
| `--success-bg` / `-text` | `#E7F4ED` / `#35624E` | `#16291F` / `#A8D8BE` | Done |
| `--warning-bg` / `-text` | `#FFF3D9` / `#7D5D1D` | `#2E2512` / `#E6C27A` | Needs attention |
| `--error-bg` / `-text` | `#FBE7E7` / `#8D4545` | `#2F1A1A` / `#EDB0B0` | Failed |
| `--info-bg` / `-text` | `#EAF5F8` / `#2A72A3` | `#14283A` / `#BCDEE8` | Info |
| `--neutral-bg` / `-text` | `#F6F9FA` / `#5F6D73` | `#242424` / `#8B999F` | Idle / stopped |
| `--tone-0` / `-1` / `-2` | `#2872b8` / `#0f7a55` / `#b84a1b` | `#3691cd` / `#199e70` / `#d95926` | Helper agent series (cycles by index % 3) |
| `--tone-main` | `#6b6b6b` | `#8f8f8f` | Main agent series |

Dark theme applies with `prefers-color-scheme: dark` or `[data-theme="dark"]`. `[data-theme="light"]` forces light.

### 1.2 Type, radius and motion

| Key | Value |
|---|---|
| Sans / display | Figtree, display weight 600, tracking -0.035em |
| Accent | Newsreader italic 400 (the *em* words in headings) |
| Mono | JetBrains Mono (times, counts, IDs) |
| Body | 14px / 1.5 |
| Radius | 16 (cards), 12 (goal strip), 9 (buttons), 5 (kbd) |
| Motion | `pulse`, `spin`, `rise` (6px up and fade in), `blink` (caret), `fade`. All are 0ms under `prefers-reduced-motion` |
| Focus | 2px `--accent-fg` outline, 2px offset |

### 1.3 Status tones (shared by every chip, pill and dot)

| Tone class | Colors | Used for |
|---|---|---|
| `is-running` / `s-running` | info + spinner or pulse | Running, in progress |
| `is-done` / `s-done` | success + check | Finished, accepted, completed |
| `is-warn` / `s-paused` | warning + ⚠ | Needs you, paused, budget/limit reached, failed helper |
| `is-stopped` | neutral | Stopped, closed, unconfirmed |
| `is-bad` | error | Failed request, invalid field |

### 1.4 Primitives

| Component | Anatomy | Props / values | States |
|---|---|---|---|
| **Button** | label, optional icon | variant: `btn-solid` (primary), `btn-soft` (secondary), `btn-ghost` (tertiary/decline), `text-btn` (inline link), `icon-btn` (icon only, needs `aria-label`) | default, hover, pressed, disabled, busy (label changes to "…ing…") |
| **StatusPill** | pulse dot + label | tone (1.3) | static, pulsing |
| **Chip** (`ag-chip`) | spinner/⚠/check + label | tone + label | — |
| **StepMark** | check / spinner / dot | `done` / `current` / `pending` | — |
| **ProgressBar** | track + fill, `role=progressbar` | `value` 0–100 | — |
| **Meter** | track + fill + caption, `role=meter` | `value` 0–1, `high` 0.75 (warn), `critical` 0.9 (crit) | ok / `is-warn` / `is-crit` |
| **LiveDuration** | `<time>` with rolling digits | `ms`, `trend` 1 (elapsed) or -1 (countdown); format `m:ss` / `h:mm:ss` | ticking |
| **Kbd** | `<kbd>` | text, e.g. `⌘K` | — |
| **Tooltip** (`dock-tip`) | label + kbd | — | shown on hover/focus |
| **EmptyState** (`empty-tab`) | icon, title, one muted line | icon, title, body | — |
| **ErrorBanner** | `role=alert`, message, ErrorRef | message | — |
| **ErrorRef** | "Ref: {code · requestId \| turnId}" + "Copy" | `code?`, `requestId?`, `turnId?`; hidden if all are empty | idle → "Copied" (2s) / "Select to copy" if the clipboard is blocked |
| **Popover** | `role=dialog` box | placement class (`pop-agent`, `pop-user`) | open/closed; closes on outside click or Esc |
| **Sheet** | right slide-over: title, description, close X, body | title, description | open/closed; closes on backdrop click or Esc; focus is trapped |
| **Scrim** | dim overlay | `center`, `celebrate` | — |

---

## 2. App shell

```
┌──────────┬──────────────────────────────────────────┬──────────────────┐
│ Sidebar  │ Topbar  [crumb]   [status pill]  [actions]│  Session panel   │
│          ├──────────────────────────────────────────┤  (activity bar)  │
│ Search   │                                          │  Activity│Agents │
│ New      │   Hero (empty)  or  Chat stream          │  Goal│Plan│Insig │
│ Agents   │                                          │                  │
│ Today    │   Goal strip / Plan card / Request card  │                  │
│ Earlier  │   Composer                               │                  │
│ Settings │             [ Floating dock ]            │                  │
└──────────┴──────────────────────────────────────────┴──────────────────┘
```

### 2.1 Shell / Panel — `BUILT`

| Key | Type | Values |
|---|---|---|
| `kind` | enum | `sidebar` \| `activity` |
| `open` | bool | when closed: `aria-hidden` and `inert` |
| `overlay` | bool | activity panel becomes a fixed drawer (narrow screens) |
| `width` | px | sets `--pw`; `fitPanel()` decides whether the panel fits beside the stage |

### 2.2 Sidebar — `LIVE` (tenant variant) / `BUILT`

Anatomy: brand "truex / agents" → **Search** `⌘K` → **New conversation** `⌘J` (tenant variant: "New chat") → nav **Agents** → groups **Today** / **Earlier** (Earlier is collapsible and shows a count) → rows → **Show more** ("{n} remaining") → footer **Settings**.

**ConvoRow**

| Key | Type | Values |
|---|---|---|
| `_id` | string | |
| `title` | string | empty shows "New conversation" / "New chat" |
| `createdAt` | date | group: `Today` (same local day) or `Earlier` |
| time label | derived | today `h:mm AM`; under 7 days short weekday; otherwise short date |
| running | bool | `pulse` + "Answering" (tenant) |
| active | bool | `is-active`, `aria-current` |

| State | Shows |
|---|---|
| loading / busy | rows disabled |
| load error | inline error + **Retry** |
| empty (tenant) | "New chat" copy |
| Earlier collapsed | rows hidden; kept in localStorage `truex-sidebar-earlier-expanded` |

Limits: first page 10 rows (`SIDEBAR_INITIAL_COUNT`), then 25 per page.
Row hover menu (tenant): **Rename** (max 200 chars; Save/Cancel), **Archive** (confirm: "Archive this chat? It leaves your list and can't be continued.").

### 2.3 Topbar — `BUILT` / `LIVE` (tenant header)

Layout: 56px grid `[crumb 1fr][status pill][actions 1fr]`.

| Part | Data | Values |
|---|---|---|
| Crumb | `sidebarShown`, `title` | shows the "truex" wordmark when the sidebar is hidden; `/ {title}` |
| Status pill | `agentName`, `stateText`, `busy` | stateText: `ready` \| `working` \| `working on goal` \| `reconnecting…`; pulse animates while busy; click opens "Edit {agent}" |
| Theme toggle | `isDark` | sun/moon, "Switch to light/dark theme" |
| **Share** | — | placeholder; it does nothing yet |

Tenant header: "truex" link, workspace name, person name (title = email), theme toggle, **Sign out**.

### 2.4 Hero (empty chat) — `LIVE` / `BUILT`

| Part | Values |
|---|---|
| Greeting | by hour: <5 "Working late", <12 "Good morning", <18 "Good afternoon", else "Good evening"; adds ", {name}" |
| Agent dot | `agentHue` (default `#BCDEE8`) |
| Headline | "What should we *work on* today?" |
| Composer | hero variant (see 3.1) |

### 2.5 FloatingDock — `BUILT`

| Key | Type | Values |
|---|---|---|
| `items[]` | DockItem | `{id, label, icon, kbd?, active?, badge?, onClick}` |
| `icon` | enum | `sidebar` \| `search` \| `plus` \| `bot` \| `activity` \| `user` |
| `groups` | number[] | separator positions, spec `[3,5]` |
| Magnify | const | base 40px, peak 60px, reach 140px, cos² falloff; icon 0.9→1.25; off under reduced motion |

States: `active` (pip + `aria-pressed`), `badge` (dot), hover magnify, tooltip with kbd.

### 2.6 SearchPalette — `BUILT`

Anatomy: scrim → dialog → input "Search conversations…" + `esc` → listbox of rows (doc icon, title, mono time) → empty "No matches for "{q}"".
Keys: `↑`/`↓` move, `Enter` opens, `Esc` closes. Data: `SearchItem {id, title, time}`; filters on title only.

### 2.7 UserMenu — `BUILT`

User card (avatar initial, name, email, "{workspace} · Admin") → theme toggle ("Light mode" / "Dark mode") → **Settings** → **Manage workspaces** → **Sign out**.
Data: `name`, `email`, `workspace`, `role` (`user` \| `admin`), `showWorkspaces`.

### 2.8 Keyboard shortcuts

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Toggle search palette |
| `⌘J` | New conversation |
| `⌘B` | Toggle sidebar |
| `⌘.` | Toggle session panel |
| `Enter` / `Shift+Enter` | Send / new line (IME-safe; touch devices use the button) |
| `⌘/Ctrl+Enter` | Send revise feedback (plan card) |
| `Esc` | Close palette, popover, sheet or dialog; cancel revise |
| `←` `→` `Home` `End` | Move between session panel tabs |

---

## 3. Composer

### 3.1 Composer — `LIVE` (text only) / `BUILT` (full)

Anatomy (top to bottom):

1. Goal head (goal mode only): target icon, "**New goal** The assistant keeps working until the goal is done, paused or out of budget.", X "Cancel goal"
2. Above slot: PrivacyNote (3.4), pending notices
3. Textarea (auto-grows to 240px; 3 rows in the hero, 2 in chat)
4. Below slot: slash menu, notices
5. Bar: **Goal** chip · Budget select (goal mode) · Approval mode chip (3.3) · Tools chip · *spacer* · char count · dispatch status · **Stop** / **Send**

| Key | Type | Values |
|---|---|---|
| `draft` | string | max 32,000 chars (`MAX_MESSAGE_CHARS`); the counter appears from 30,000 as "{n} / 32,000" |
| `placeholder` | string | tenant: "Message {agent}" / "Choose an agent to start". Legacy hero rotates every 3.2s: "Ask anything, or type / for commands", "Summarize last week's pipeline changes", "Compare Q2 vs Q3 revenue by region", "Draft a reply to the customer escalation". Goal mode: "Describe the outcome you want. The assistant works until it's done." |
| `goalMode` | bool | |
| `dispatchState` | enum | `creating` "Creating…" \| `steering` "Steering…" \| `sending` "Sending…" \| `null` |
| `busy` | bool | a turn is running |
| `ending` | enum | `saving` "Saving the reply" \| `stopping` "Stopping" (tenant) |
| variant | enum | `is-hero`, `goal-mode`, `is-focus` |

**Send button states**

| Condition | Button | Label / aria |
|---|---|---|
| empty or invalid draft | Send, disabled | "Send" |
| ready | Send ↑ | "Send" |
| goal mode | Send ↑ | "Start goal" |
| turn running, steer enabled | Send ↑ | "Steer" (title "Steer the current response") |
| turn running, steer off (`LIVE`) | **Stop** ■ | "Stop" |
| saving / stopping | disabled | "Saving the reply" / "Stopping" |
| over the char limit | disabled + error note | `draftProblem` message |

Slow reply hint after 15s (`SLOW_REPLY_MS`). Failures show as a `tchat-note is-bad` alert under the bar.

### 3.2 BudgetField (goal mode and goal strip) — `BUILT`

| Key | Type | Values |
|---|---|---|
| option | enum | "No budget" (`null`), "25k tokens" (25,000), "100k tokens" (100,000), "250k tokens" (250,000), "Custom…" |
| custom | text | accepts `50000`, `50,000` or `50k`; integer > 0 and ≤ 10,000,000; max 12 chars; placeholder "e.g. 50k" |
| output | `BudgetValue` | `{tokens: number \| null, valid: boolean}` |
| error | string | "Enter a whole number of tokens, like 50000 or 50k (up to 10M)." (shown after blur) |

### 3.3 ApprovalModePicker — `BUILT` (alpha, behind a flag)

Native select + "Alpha" tag.

| `mode` | Label | Help text |
|---|---|---|
| `ask` | Ask me every time | Every question and tool use waits for your answer. |
| `readOnly` | Auto-allow read-only tools | Tools that only read data run without asking. |
| `auto` | Autopilot | Runs tools and picks recommended answers; plans and secrets still ask. (only when `config.autopilot`) |

Config: `GET /api/features` → `{enabled, defaultMode, autopilot, nameHeuristic}`. Precedence: session mode → new-chat draft → `defaultMode`. Change → `POST /api/sessions/:id/approval-mode {mode}`; open requests are re-checked.

### 3.4 PrivacyNote — `BUILT`

Warning note above the textarea: shield icon + "This looks like {a phone number and an email address}. It will be sent to the model." + X "Dismiss privacy note".
Scans the draft 250ms after typing stops. It never blocks sending, and once dismissed it stays hidden until the draft is cleared.

### 3.5 SlashMenu — `BUILT` (disabled: `SLASH_COMMANDS_ENABLED=false`)

Opens when the draft matches `^/[a-z]*$`. Rows: command name + description. `//` sends literal text. The command list is in 12.2.

### 3.6 HelperChip (above composer) — `BUILT`

Pill: pulse + "{n} helpers running · {LiveDuration}" + **View** (opens the Agents tab). Hidden when no helper is running.

### 3.7 Attachments in composer — `NEW`

The live composer is text only. Uploads exist only in the Tools sheet (4.10). v2 needs an attach button, file chips (DocumentIcon, name, size, remove X), an upload progress state and an error state (over 1 MB: "Choose a document of up to 1 MB."). Accepted types: `.pdf .docx .xlsx .pptx .txt .md .csv .tsv .abap .cds .json .xml .yaml .sql .js .ts`.

---

## 4. Chat stream: one AI turn

```
article.msg.user        [goal tag] bubble  "Follow-up" / "Sending…"
article.msg.agent       avatar · agent name · "thinking…"
  ├─ ThinkingBlock      ▸ Reasoning · 214 words
  ├─ Working            ◌ Working
  ├─ ToolActivityRow*   🔌 hubspot · search_contacts · 1.2s      (NEW)
  ├─ HelperGroup        3 helpers · 2 running · 1 done
  ├─ ApprovalRecord     ● Allowed once · You answered at 4:12
  ├─ AnswerBody         markdown + inline Visualization + caret
  ├─ TurnReceipt        12.4s · 8.2k tokens · No personal data ▸
  └─ SuggestedQuestions → "Compare with Q2?"  → "…"
PlanApprovalCard / QuestionCard   (pinned above the composer)
```

### 4.1 UserMessage — `LIVE`

| Key | Type | Values |
|---|---|---|
| `id` | string | anchor `#request-{id}` |
| `role` | const | `user` |
| `text` | string | collapses past 600 chars or 8 lines → "Show full message" / "Show less" |
| `delivery` | enum | `pending` "Sending…" \| `accepted` (no note) \| `failed` / `unknown` "Delivery unconfirmed" |
| `steer` | bool | note "Follow-up" |
| `command` | CommandRecord? | shows a goal tag (target icon + label) and a CommandResult (12.3) |
| `turnId` | string? | |

### 4.2 AssistantMessage (AI response) — `LIVE`

Anatomy: avatar (spark, background = agent hue) → meta (agent name + "thinking…" while active) → ThinkingBlock → Working → tool/helper/approval items → **AnswerBody** → TurnReceipt or LiveUsage → SuggestedQuestions.

**AnswerBody**

| Key | Type | Values |
|---|---|---|
| `text` | markdown | GFM; raw HTML never renders |
| `streaming` | bool | blinking caret at the end |
| visual refs | parsed | a standalone line `[truex-visualization:<uuid>]` → inline Visualization (4.8) |
| suggestions | parsed | a trailing `[truex-suggestions]` block is removed and becomes SuggestedQuestions |
| code block | part | header buttons **Wrap lines** (toggle, `aria-pressed`) and **Copy code** |

| State | Shows |
|---|---|
| placeholder | running, nothing streamed yet: avatar + "thinking…" |
| streaming | text + caret; no copy |
| final | **Copy answer** → "Copying…" → "Copied" / "Couldn't copy. Select the text and copy it." |
| stopped | partial text kept, receipt status `interrupted` |
| failed | error banner + ErrorRef (an inline failure item is `NEW`, see 4.12) |

### 4.3 ThinkingBlock — `BUILT` (deferred on `LIVE`)

| Key | Type | Values |
|---|---|---|
| `text` | string \| `{text}[]` | from `reasoning.delta` (`item/reasoning/textDelta` or `summaryTextDelta`) |
| `streaming` | bool | |

| State | Shows |
|---|---|
| streaming | spinner + "Thinking…" |
| done | check + "Reasoning" + "{n} words" (or "Complete") |
| collapsed / expanded | chevron toggles the body |
| empty and not streaming | hidden |

### 4.4 Working indicator — `BUILT`

Spinner + "Working" (`role=status`). Shown while the turn is active, no answer text has arrived and thinking is done. v2 can show the latest `activity.updated.label` here instead (for example "Searching the web").

### 4.5 ToolActivityRow (MCP / dynamic tool call) — `PROTOCOL` → `NEW`

The runtime sends these items, but the platform hides them today (only reasoning and messages pass). For v2, show a business-safe row and never the raw command or a file path.

| Key | Type | Values |
|---|---|---|
| `id` | string | |
| `type` | enum | `mcpToolCall` \| `dynamicToolCall` |
| `server` | string | connector name, e.g. `hubspot` (mcpToolCall) |
| `tool` | string | e.g. `search_contacts` |
| `toolTitle` / `connectorName` | string? | friendly label when available |
| `status` | enum | `inProgress` \| `completed` \| `failed` |
| `arguments` | JSON | show behind a "Details" disclosure only |
| `result` | McpToolCallResult? | content blocks; summarise them |
| `error` | McpToolCallError? | message |
| `readOnlyHint` | bool? | show a "read-only" badge |
| `durationMs` | number? | "1.2s" |

| State | Shows |
|---|---|
| `inProgress` | spinner + "{connector} · {tool}" + live timer |
| `completed` | check + duration; can expand to a result summary |
| `failed` | ⚠ `is-bad` + error message |
| declined | "Not allowed" (links to the ApprovalRecord) |

Group several calls in one turn: "Used 4 tools · 6.3s ▸".

### 4.6 WebSearchRow — `PROTOCOL` → `NEW`

| Key | Type | Values |
|---|---|---|
| `id` | string | |
| `query` | string | |
| `action.type` | enum | `search` (`query`, `queries[]`) \| `openPage` (`url`) \| `findInPage` (`url`, `pattern`) \| `other` |

Display: globe icon + "Searched "{query}"" / "Opened {host}" / "Looked for "{pattern}" in {host}". Sources show as favicon chips.

### 4.7 ContextCompactionMarker — `PROTOCOL` → `NEW`

`{type: "contextCompaction", id}`. A divider line: "Earlier messages were summarised to free up context." Also show it after `/compact` or the "Compact conversation" action.

### 4.8 Visualization (Visualize) — `BUILT`

Anatomy: figure → caption (title + description) → controls **Expand** / **Close expanded view**, **Reload visual**, **Download HTML**, **Ask about this visual** → status → sandboxed iframe → follow-up bar (**Add to my message** / **Dismiss**). Expanded view opens in a dialog.

| Key | Type | Values |
|---|---|---|
| `id` | uuid | |
| `title`, `description` | string | |
| `html` | string | runs in a sandbox (`allow-scripts`, no network, `img-src data:`) |
| `mode` | enum | `inline` \| `wide` |
| state | `{modelContent, privateContent}` | up to 16 KiB, remembered per chat |
| messages from the frame | enum | `ready`, `error`, `resize` (height 160–900), `state`, `followup` (`prompt` ≤ 2000, `title` ≤ 250) |

| State | Shows |
|---|---|
| loading | "Loading visual…" / "Preparing visual…" |
| loaded | interactive frame |
| error | "This visual could not be loaded. {err}" |
| timeout (12s) | "The visual may not have rendered correctly…" |
| no session | "Open this conversation to view the visualization." |
| expanded | dialog |

### 4.9 DocumentCard (generated or uploaded file) — `BUILT` (Tools sheet only) → `NEW` inline

| Key | Type | Values |
|---|---|---|
| `id`, `name`, `size`, `createdAt`, `mediaType` | | |
| `sourceId` | string? | set on a revision → "Revised version" |
| kind (icon) | enum | `document` \| `sheet` \| `slides` \| `code` \| `text` |
| type label | enum | PDF, Word, Excel, PowerPoint, CSV, TSV, Text, Markdown, ABAP, CDS, JavaScript, TypeScript, JSON, XML, YAML, SQL, HTML, Properties, Java, Python, Shell |

Row: icon + name + "{type} · {KB} KB [· Revised version]" + **Discuss** + **Download**. v2: show this card inline in the reply that created the file.

### 4.10 Tools sheet (AssistantTools) — `BUILT`

Sections: **Capabilities** grid (7 cards: `explain`, `questions`, `web`, `documents`, `visualize` "Visualize", `goals` "Goal tracking", `collaboration`) → **Documents** (**Upload a document** / "Uploading…", **Refresh documents**, DocumentCard rows) → **Visualize** (saved visuals: title + **Open visual** / **Hide visual**) → **Conversation tools** (12.1).

### 4.11 SuggestedQuestions — `BUILT`

| Key | Type | Values |
|---|---|---|
| `questions` | string[] | up to 3, each ≤ 160 chars |
| `disabled` | bool | |

Shown under the last finished reply when nothing is running. Clicking a question sends it as a message 350ms later. Each link's aria-label is "Ask: {q}".

### 4.12 TurnError (inline) — `NEW` (today: page banner)

| Key | Type | Values |
|---|---|---|
| `reason` | enum | `rateLimited` \| `quota` \| `credentials` \| `providerDown` \| `contextWindow` \| `other` |
| `code` | enum | see 7.6 |
| `message` | string | user-safe copy (7.6); URLs and keys are already removed |
| `httpStatus` | number? | |
| `willRetry` | bool | shows "Retrying…" instead of failed |
| `turnId` | string | for ErrorRef |

Buttons by reason: `contextWindow` → **Compact conversation**; `rateLimited` / `providerDown` / `other` → **Try again**; `quota` / `credentials` → no retry, show the admin tip.

### 4.13 TurnReceipt and LiveUsage — `LIVE` (quiet line) / `BUILT` (full)

| Part | Values |
|---|---|
| LiveUsage (running) | "{tokens} tokens so far"; hidden at 0 |
| Receipt button | "{duration} · {tokens} tokens" + privacy icon and line + chevron; aria "Took {dur}, used {tokens}, {privacy}" |
| Expanded | TraceCard (11.7) |
| States | collapsed / expanded / warn (privacy findings: shield-alert icon) |

### 4.14 HelperGroup (helpers inline in a reply) — `BUILT`

Card head: "{n} helpers · {x} running · {y} done" + LiveDuration. Rows: avatar (xs) · name · task title · status chip · time · **Open** / **Hide**. Expanded row: output markdown (or "No output yet." / "No output was shared."), task text, **Open transcript**, **Stop** / "Stopping…". Data and statuses are in 8.6.

---

## 5. Plan mode

Plan mode is a numbered list of steps, each with a status. Before running a long task the agent asks for approval with two buttons: **Approve plan** and **Revise**. In Truex the agent's instructions decide when to plan: long tasks call `update_plan`, then send a `plan_approval` question. The user doesn't toggle a mode. The protocol also has `CollaborationMode.mode`: `plan` \| `default`.

### 5.1 PlanStep (data)

| Key | Type | Values |
|---|---|---|
| `step` | string | step text, e.g. "Pull Q3 pipeline from HubSpot" |
| `status` | enum | `pending` \| `inProgress` \| `completed` (`in_progress` is also accepted) |
| `explanation` | string? | on the plan update, shown as the plan intro |
| progress | derived | `{done, total, current, label: "{done} of {n} done"}` |

### 5.2 PlanSteps (list) — `BUILT`

```
① ✓  Pull Q3 pipeline from HubSpot          Done
② ◌  Compare against Q2 by region           In progress   ← aria-current="step"
③ ·  Draft summary for leadership           Pending
```

| Step status | Mark | Label |
|---|---|---|
| `completed` | check | Done |
| `inProgress` | spinner | In progress |
| `pending` | dot | Pending |

Read-only. Rebuilt from every `plan.updated` event and from snapshots.

### 5.3 PlanApprovalCard (the 2-button card) — `BUILT`

Pinned above the composer when the request has a single question with id `plan_approval`.

Anatomy:
1. Check icon + "{header \|\| Plan} ready for review" + expiry countdown (LiveDuration, trend -1)
2. Question text
3. PlanSteps (or "drafted steps are in the message above.")
4. Buttons: **Approve plan** (`btn-solid`) · **Revise** (`btn-soft`)
5. Revise mode: textarea "What should change?" + **Send feedback** + **Cancel**

| Key | Type | Values |
|---|---|---|
| `requestId` | string | |
| `questions[0].id` | const | `plan_approval` |
| options | const | `Approve`, `Revise` |
| `expiresAt` | ISO | drives the countdown |
| answer: approve | payload | `{answers: {plan_approval: {answers: ["Approve"]}}}` |
| answer: revise | payload | `{answers: {plan_approval: {answers: ["Revise", "user_note: <feedback>"]}}}` |

| State | Shows |
|---|---|
| pending | both buttons enabled, countdown |
| revising | textarea; **Send feedback** is disabled until the text is not blank |
| submitting | "Sending…", buttons disabled |
| answered | card closes; an ApprovalRecord appears in the stream |
| expired | "No reply in time. Continuing with the recommended option." (auto-Approve) |
| stopped | the user pressed Stop; record "No answer — stopped" |
| error | message + ErrorRef. 409 means it was already answered, 404/410 means it is gone or expired |

Keys: `⌘/Ctrl+Enter` sends feedback, `Esc` cancels revise.

### 5.4 Plan tab (session panel) — `BUILT`

Empty: "No plan yet" / "When the assistant breaks a request into steps, they appear here."
Filled: head "Plan" + chip ("Awaiting approval" or "{done} of {n} done") → ProgressBar → PlanSteps.
Tab badge: `{done}/{total}`.

---

## 6. Requests and approvals

Anything that pauses the agent for the user. Only `item/tool/requestUserInput` reaches the browser. Everything else is answered automatically on the server (6.6).

### 6.1 PendingRequest (data)

| Key | Type | Values |
|---|---|---|
| `requestId` | string | |
| `method` | const | `item/tool/requestUserInput` |
| `expiresAt` | ISO | server timeout (`requestTimeoutMs`) |
| `detail.questions[]` | InputQuestion | one or more; the card shows them one at a time ("{n} of {m}") |
| `responseSchema` | — | always `null` to the browser |

**InputQuestion**

| Key | Type | Values |
|---|---|---|
| `id` | string | `plan_approval` → PlanApprovalCard; prefix `mcp_tool_call_approval` → ToolApprovalCard |
| `kind` | enum? | `toolApproval` \| absent (clarification) |
| `header` | string? | card title |
| `question` | string | |
| `action` | string? | tool approval: what will run |
| `options` | `{label, description}[]` \| null | |
| `isOther` | bool? | shows "Something else…" with free text |
| `isSecret` | bool? | password field; the answer is hidden in the record |

### 6.2 QuestionCard (clarification) — `BUILT`

Anatomy: question icon + title (`header` or "Your input is needed") + "{n} of {m}" + countdown → question → option toggles (label + description) → "Something else…" / "Type your own answer" input (password if `isSecret`) → footer **Back** · **Next** / **Send answer** ("Sending…").

| State | Shows |
|---|---|
| pending | |
| one-click | a single question with options sends on click |
| missing answer | alert; focus moves to the first unanswered question |
| submitting | "Sending…" |
| answered | closes → ApprovalRecord |
| expired | "Continuing with the recommended option." (secret: "This question has expired. Send a message to continue.") |

Answer payload: `{answers: {<questionId>: {answers: ["<text>"]}}}`.

### 6.3 ToolApprovalCard (MCP tool approval) — `BUILT`

The same card as 6.2 with `kind: "toolApproval"`. MCP tool approvals arrive as `requestUserInput` (the policy turns native MCP elicitation off).

Anatomy: shield icon + "Permission needed" + countdown → "Action" + `action` text (e.g. `Allow hubspot to run tool "update_deal"`) → buttons:

| Runtime option | Button label | Style | Decision recorded |
|---|---|---|---|
| Allow | **Allow once** | `btn-solid` | `allowedOnce` |
| Allow for this session | **Allow for this chat** | `btn-soft` | `allowedChat` / `allowedSession` |
| Allow and don't ask me again | **Always allow** | `btn-soft` | `allowedAlways` |
| Cancel | **Don't allow** | `btn-ghost` | `declined` |

| State | Shows |
|---|---|
| pending | 4 buttons, countdown |
| submitting | "Sending…" |
| answered | ApprovalRecord with the decision |
| expired | declined, never auto-allowed: "This question has expired. Send a message to continue." |
| auto by mode | no card; a record "Auto-allowed (read-only)" / "Auto-accepted (Autopilot)" |

v2 additions (`NEW`): connector logo + tool title, a read-only/write badge from `readOnlyHint`, and an "arguments" disclosure.

### 6.4 McpElicitationCard — `PROTOCOL` (auto-declined today) → `NEW`

The protocol lets an MCP server ask the user for structured input (`mcpServer/elicitation/request`). The app declines these today. If v2 adds it:

| Key | Type | Values |
|---|---|---|
| `serverName` | string | |
| `threadId`, `turnId` | string | |
| mode | enum | `form` \| `url` \| `openai/userVerification` \| `openai/form` |
| `form.message` | string | |
| `form.requestedSchema` | object | `{type: "object", properties: {...}, required?}`; field types: string (`format`: `email` \| `uri` \| `date` \| `date-time`, min/max length), number/integer (min/max), boolean, enum (single or multi select) |
| `url` | `{elicitationId, message, url}` | open-link flow |
| `userVerification` | `{challenge, description, title}` | |
| response | enum | `accept` (with `content`) \| `decline` \| `cancel` |

Buttons: **Submit** (accept) · **Decline** · **Cancel**. For URL mode: **Open link** · **Done** · **Cancel**.

### 6.5 ApprovalRecord (audit line in the chat) — `BUILT`

Group "Your decision": a dot (tone) + title + badge, or question + answer, then a footer "{summary} at {h:mm}".

| Key | Type | Values |
|---|---|---|
| `requestId`, `at`, `turnId` | | |
| `outcome` | enum | `answered` "You answered" \| `auto` \| `expired` / `interrupted` "Closed" |
| `autoMode` | enum? | `readOnly` "Auto-allowed (read-only)" \| `auto` "Auto-accepted (Autopilot)" \| `grant` "Allowed for this chat" |
| `items[].kind` | enum | `toolApproval` \| `question` |
| tool `decision` | enum | `allowedOnce` "Allowed once" · `allowedSession` / `allowedChat` "Allowed for this chat" · `allowedAlways` "Always allowed" · `declined` "Not allowed" · `expired` "No answer — timed out" · `interrupted` "No answer — stopped" |
| question `answer` | string? | "Answer hidden" if secret; "(chosen by Autopilot)" / "(chosen automatically, no reply in time)"; "No answer" |
| tone | enum | `allowed` (green) \| `declined` (red) \| `muted` |

### 6.6 What happens to every request type

| Request | Today |
|---|---|
| Clarification (`requestUserInput`) | QuestionCard; on timeout the recommended option is chosen |
| Plan approval | PlanApprovalCard; auto-Approve on timeout |
| MCP tool approval | ToolApprovalCard; declined on timeout |
| Secret question | password input; declined on timeout |
| MCP elicitation | declined automatically; no UI |
| Command / file-change / permission approval | denied automatically (the runtime is read-only); no UI |

Stop while a card is open records `interrupted`. While a request is waiting the turn is paused: steer is allowed if it is enabled, and Stop always works.

---

## 7. Goals

A goal is a long-running objective for one chat. The agent keeps working until the goal is done, paused, or out of budget, then the user accepts or reopens the result. There is one goal per chat.

### 7.1 Goal (data)

| Key | Type | Values |
|---|---|---|
| `objective` | string | max 4,000 chars |
| `status` | enum | `active` \| `paused` \| `blocked` \| `usageLimited` \| `budgetLimited` \| `complete` |
| `tokenBudget` | number \| null | null means no budget; presets 25k / 100k / 250k; max 10M |
| `tokensUsed` | number | runtime count |
| `tokensObserved` | number? | Truex count; display `max(tokensUsed, tokensObserved)` |
| `timeUsedSeconds` | number | |
| `createdAt`, `updatedAt` | epoch | `createdAt` identifies the goal |
| used % | derived | `min(100, round(used / budget × 100))` |
| `review` | GoalReview? | `{objective, goalCreatedAt, decision: accepted \| reopened, feedback? (≤ 4000), at}` |

| Status | Label | Tone |
|---|---|---|
| `active` | In progress | running, pulse |
| `paused` | Paused | warn |
| `blocked` | Needs input | warn |
| `usageLimited` | Usage limit reached | warn |
| `budgetLimited` | Budget reached | warn |
| `complete` (not reviewed) | Ready for review | — |
| `complete` + accepted | Accepted | done |

### 7.2 State machine

```
(none) ──set objective──▶ active ◀──resume── paused
   ▲                       │  ▲  └──pause──▶ paused
   │                       │  └─resume / extend budget─┐
 clear (any state)         ├──▶ blocked / usageLimited / budgetLimited
                           └──▶ complete ──accept──▶ Accepted
                                   └──reopen (+feedback)──▶ active
```

Rules: only a `complete` goal can be reviewed (otherwise 409 `GOAL_NOT_COMPLETE`). Setting, editing, clearing or reopening a goal removes the old review. Pause lets the current turn finish.

### 7.3 GoalBar (goal strip above the composer) — `BUILT`

Strip (38px, max 740px): target icon · objective (ellipsis) · meta "{duration} · {used} / {budget}" (or "{n} tokens") · ProgressBar (hidden ≤ 720px) · status pill · actions.

| Button | Shown when | Does (`POST /api/sessions/:id/capabilities`) |
|---|---|---|
| **Pause goal** | active | `thread/goal/set {status: "paused"}` |
| **Pause after this turn** / **Keep going** | a goal turn is running | pause / `{status: "active"}` |
| **Resume goal** | paused, blocked, usageLimited | `{status: "active"}` |
| **⋯ More** → **Edit objective** | not complete | panel: textarea (3 rows, 4000) + **Cancel** / **Save objective** → `{objective}` |
| **⋯** → **Set budget** | not complete | BudgetField + **Cancel** / **Save budget** → `{tokenBudget}` |
| **⋯** → **Mark complete** | not complete | confirm → `{status: "complete"}` + review accepted |
| **Extend by 25k** / **Extend by 50k** | budgetLimited | `{tokenBudget: budget + n, status: "active"}` |
| **Compact conversation** | failure reason `contextWindow` | `thread/compact/start` |
| **Provide input** | blocked | focuses the composer |
| **Accept result** | complete | `POST /goal/review {decision: "accepted"}` |
| **Not yet** → **Reopen goal** | complete | textarea "What still needs work? (optional)" → `{decision: "reopened", feedback}` |
| **Start a follow-up goal** | accepted | opens goal mode |
| **Clear goal** (X) | always | confirm → `thread/goal/clear` |

Running line: spinner + "Working on the goal · turn {n}. Stop pauses it now."

### 7.4 GoalReason (why it stopped) — `BUILT`

Shown inside the strip when the status is `blocked` or `usageLimited` and a failure exists: label (+ " (HTTP {status})") + hint + provider tip.

| `reason` | Label | Next step |
|---|---|---|
| `rateLimited` | Rate limited | Resume |
| `quota` | Out of credits | admin tip |
| `credentials` | Access denied | admin tip |
| `providerDown` | Provider unavailable | Resume |
| `contextWindow` | Conversation too long | Compact |
| `other` | Stopped by an error | Resume; shows the raw safe message |

Provider tips are matched by name: OpenRouter, Bedrock/AWS, OpenAI, Anthropic/Claude, Gemini/Google/Vertex, plus a generic fallback.

### 7.5 GoalReview panel and GoalCompletion — `BUILT`

**Closing summary**: a 280-char preview + "Show more" / "Show less". **{n} documents created**: files made during the goal (visuals excluded), each DocumentIcon + name + **Download**. Buttons: **Not yet** · **Accept result**.

### 7.6 Turn and goal error codes (user copy)

| Code | Reason | Message |
|---|---|---|
| `PROVIDER_QUOTA_EXCEEDED` | quota | The model provider account has run out of usage or credits. Ask your administrator to check the provider account, then try again. |
| `PROVIDER_RATE_LIMITED` | rateLimited | The model provider's rate limit has been reached. Try again later, or ask your administrator to check the provider quota or change the configured model. |
| `PROVIDER_AUTH_FAILED` | credentials | The model provider denied access. Ask your administrator to check the configured API key and model permissions. |
| `CONTEXT_LIMIT` | contextWindow | This conversation exceeds the model's context limit. Compact the conversation or start a new one with a shorter message. |
| `SESSION_BUDGET_EXCEEDED` | other | This conversation has reached its usage budget. Ask your administrator to review the budget before continuing. |
| `PROVIDER_UNAVAILABLE` | providerDown | The model provider is temporarily unavailable. Try again later. |
| `PROVIDER_CONNECTION_FAILED` | providerDown | The connection to the model provider was interrupted. Check the conversation for a partial response before trying again. |
| `PROVIDER_INVALID_REQUEST` | other | The model provider rejected the request. Shorten your message or ask your administrator to check the model configuration. |
| `PROVIDER_POLICY` | other | The model provider could not process this request under its usage policy. Rephrase your request. |
| `TOOL_ACCESS_DENIED` | other | The assistant could not access a required resource. Ask your administrator to check tool permissions. |
| `TURN_BUSY` | other | The assistant cannot accept another message during this operation. Wait for it to finish. |
| `TURN_STALLED` | other | The assistant stopped responding and this response was cancelled. Check the conversation for a partial response, then send your message again. |
| `RUNTIME_UNAVAILABLE` | other | The assistant runtime stopped. Reopen this conversation to resume it. |
| `RUNTIME_OVERLOADED` | other | The assistant runtime is busy. Wait a moment, then try again. |
| `ROLLBACK_FAILED` | other | The conversation could not be restored to the previous turn. Refresh it to check its current state. |
| `STORAGE_UNAVAILABLE` | other | Conversation updates could not be saved, so live updates stopped. Reopen the conversation; if this continues, ask your administrator to check the assistant's storage. |
| `ADAPTER_INTERNAL` | other | The assistant hit an internal error while handling this response. Check the conversation before trying again; contact support if this continues. |
| `RUNTIME_FAILED` | other | The assistant could not finish this response. Check the conversation before trying again; contact support if this continues. |
| `CAPABILITY_DENIED` (403) | — | This operation or setting is not available in Truex |

### 7.7 Goal tab (GoalTimeline) — `BUILT`

Empty: target icon, "No active goal" + History if there is any.
Filled: status pill + "Started {time}" → objective → ProgressBar + "{pct}%" → details **Budget** / **Used** / **Checkpoints** ("{done}/{total}" or "—") → **Checkpoints** list (the plan steps, 5.2) → **History** (newest first, up to 60).

**History row**

| `kind` | Icon | Label |
|---|---|---|
| `set` | target | Goal set |
| `objective` | pencil | Objective edited |
| `budget` | gear | Budget set to {n}k tokens / Budget removed |
| `status` | pulse | Status: {label} |
| `accepted` | check | You accepted the result |
| `reopened` | play | You reopened the goal (+ feedback quote) |
| `cleared` | x | Goal cleared |

Row extras: time · "{n} tokens" · "+{n} since the last change" · **View turn** (scrolls to `#turn-{id}`, or shows "This turn isn't loaded in the chat."). Errors: "Goal history couldn't be loaded." Empty history: "Goal changes will appear here." Tab badge: a dot while a goal is active.

---

## 8. Agents and helper agents

### 8.1 Agent (data)

| Key | Type | Values |
|---|---|---|
| `id` | string | |
| `source` | enum | `builtin` \| `personal` \| `tenant` |
| `name` | string | 1–60 chars (legacy: 40) |
| `description` | string | 1–280 chars (legacy purpose: 80) |
| `look` | int | 0–11, default 2 (Navy) |
| `tint` | enum | `ice` (default) \| `mint` \| `butter` \| `peach` \| `lilac` |
| `model` | ModelView \| null | `{id, displayName, shortLabel, family}`; `family`: `anthropic` \| `google` \| `openai` \| `other` |
| `available` | bool | false → "Model unavailable" and the agent can't be picked |
| `status` | enum | `active` \| `archived` |
| `revision` | int | sent with edits; a mismatch gives `STALE_REVISION` |
| permissions | bool | `createdByMe`, `canEdit`, `canArchive`, `canPromote` |
| `handle` | string | legacy only, `@lowercase`, ≤ 20 chars; built-in `@generalagent` |
| limits | const | 50 personal agents per user, 200 per workspace |

**Looks** (robot avatar)

| # | Name | Face | Accessory |
|---|---|---|---|
| 0 | Graphite | line | — |
| 1 | Antenna | eyes | antenna |
| 2 | Navy (default) | line | — |
| 3 | Listener | happy | headphones |
| 4 | Scout | line | cap |
| 5 | Chef | eyes | chef hat |
| 6 | Builder | eyes | hard hat |
| 7 | Scarf | happy | scarf |
| 8 | Mint | eyes | antenna |
| 9 | Lilac | happy | bow |
| 10 | Peach | line | headphones |
| 11 | Captain | eyes | cap |

**Tints**: Ice `#EAF5F8` / `#3691CD` · Mint `#E7F4ED` / `#A9D5BE` · Butter `#FFF3D9` / `#EBCB8B` · Peach `#FBE9DD` / `#F0B999` · Lilac `#EFEDF8` / `#C4BDE3` (background / dot). They stay the same in dark mode.

### 8.2 Robot / Badge / Confetti — `LIVE`

| Component | Data | Notes |
|---|---|---|
| Robot | `look`, `size` (34 picker, 40 tile, 128 card, 150 badge) | SVG; decorative (`aria-hidden`) |
| Badge | `name` ("Unnamed" if empty), `handle` / `subtitle` ("personal agent" / "workspace agent"), `look`, `tint`, `modelLabel`, `tag` ("new specialist"), `shine` | lanyard ID card; drag to swing, springs back |
| Confetti | 56 pieces, 7 colors | success step only; off under reduced motion |

### 8.3 AgentPicker (new chat) — `LIVE`

Head "Choose an agent" + **New agent** → groups **Built-in** · **Your agents** ("Agents you create for yourself appear here.") · **Shared in this workspace** ("Agents shared with everyone in this workspace appear here.").

Row: avatar (tint background + Robot) · name · description · model `shortLabel` or tag "Model unavailable" · check if selected · actions **Edit** · **Share** · **Archive**.

| State | Shows |
|---|---|
| selected | `is-active`, `aria-pressed` |
| unavailable | `is-unavailable`, can't be picked |
| confirm share | "Share with everyone in this workspace? This can't be undone." **Share** / **Cancel** → `POST /api/v1/agents/:id/promote` |
| confirm archive | "Archive it? It leaves every list; existing chats keep working." **Archive** / **Cancel** → `POST /api/v1/agents/:id/archive` |
| busy | "Working…" |
| row error | inline red hint |

### 8.4 AgentDialog (create / edit) — `LIVE`

Two columns: form + live Badge preview ("live preview · drag it around").

| Field | Control | Rules |
|---|---|---|
| Name | input | required, ≤ 60 → "Give the agent a name." / "Keep the name under 61 characters." |
| Purpose | textarea (2 rows) + "{n}/280" | required → "Say what the agent is for." |
| Who can use it (create only) | radios **Just me** (`personal`) / **Everyone in this workspace** (`tenant`) | |
| Look | radio grid of 12 Robots | |
| Tint | 5 swatches | |
| Model | select | "Choose a model."; "Current model unavailable — choose another" |
| (legacy) Instructions | textarea | ≤ 20,000 |

Buttons: **Cancel** · **Create agent** / **Save changes** (busy "Creating…" / "Saving…"). Save is enabled only when the form is valid and, when editing, something changed.
Errors: `STALE_REVISION` "This agent was changed somewhere else…"; models empty "No models available".
API: `POST /api/v1/agents {clientRequestId, scope, name, description, modelId, look, tint}`; `PATCH /api/v1/agents/:id {revision, ...changes}`.
Success step (legacy): Confetti + Badge drop + "{name} is on the team" + **Say hi to {name}** · **Done**.

### 8.5 AgentsView (team pinboard) — `BUILT`

Top: "truex / agents" + **New agent** → hero "What the team can help with" / "{N} specialists · {yours} built by you…" → search "Search by name, handle or purpose" + pills **All** / **Yours** / **Built-in** → board of tilted polaroid cards.

Card: pin (red when live) · photo (Robot 128, lock badge "built-in", hover "Edit") · caption name · "@handle · by {creator}" (+ "in chat" pulse) · description · meta "{model} · {reasoning}" · button **Chat** / **Chatting** / **Read-only**. The last card is "New agent" ("build your own"). Footer: filter tag + "NN/NN".
Empty search: 'No agents match "{q}"' + **Clear search**.

### 8.6 Helper agent (SubAgent data)

| Key | Type | Values |
|---|---|---|
| `threadId` | string | |
| `nickname`, `role` | string | display name, e.g. "Researcher" |
| `depth` | int | 1 = started by the main agent, > 1 = nested |
| `status` | enum | see below |
| `task` | string? | first 48 chars become the title |
| `lastMessage` | string? | preview, up to 4,000 chars |
| `startedAt`, `endedAt` | ISO | |
| `model`, `reasoningEffort` | string? | from the `collabAgentToolCall` that spawned it |
| tone | derived | index % 3 → `tone-0` / `-1` / `-2` |

| `status` | Label | Chip |
|---|---|---|
| `pendingInit` | Starting | running |
| `running` | Running | running |
| `interrupted` | Stopped | stopped |
| `completed` | Finished | done |
| `errored` | Failed | warn |
| `shutdown` | Closed | stopped |
| `notFound` | Unavailable | warn |

Collab tools (protocol `collabAgentToolCall.tool`): `spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`, `sendMessage`, `followupTask`, `interruptAgent`, `listAgents`. Call status: `inProgress` \| `completed` \| `failed` \| `interrupted`. The call has `senderThreadId` → `receiverThreadIds[]`, which gives the handoff arrows in 8.9.

### 8.7 Agents tab (AgentsPanel) — `BUILT`

1. Summary: "{n} helpers · {x} running · {y} done · {z} stopped" + total time
2. Lanes (2+ helpers): one row per helper: name · bar positioned on a shared axis ("0s" → total) · time; the running bar animates
3. HelperRow list: avatar · name · role/task · StatusChip · "{duration} · working… · level {n}" · preview (3 lines) · chevron
4. **Delegation for new chats**: radios **Only when I ask** (`explicitRequestOnly`, default) / **Whenever it helps** (`proactive`) + **Max helpers at once** 1–5 (default 3)

Empty: bot icon "No helpers yet" / "When the assistant hands part of a task to a helper, it shows up here." Tab badge: running count (live) or total.

### 8.8 HelperDetail — `BUILT`

Nav **All helpers** + "{i} of {n}" with prev/next → identity (large avatar, name, "role · Level n · task") → stats **Status** / **Duration** / **Started** → warnings ("This helper failed before finishing." / "This helper is no longer available.") → tabs:

| Tab | Content |
|---|---|
| **Output** | markdown; "Stopped before finishing. Partial output:"; empty "Working… output appears when this helper finishes." / "No output yet."; **Copy output**; **Stop** / "Stopping…" → `POST /api/sessions/:id/agents/:threadId/interrupt` |
| **Task** | full task text or "No task was recorded." + "Sent by the main agent" |
| **Transcript** | loads on open: "Loading…", messages, **Refresh transcript** / "Refreshing…"; "Transcript isn't available." |

### 8.9 AgentActivityTimeline chart — `NEW` (from the v2 mock)

A swimlane chart of every agent's work over a time window. It replaces the simple Lanes in 8.7 and can sit on the Agents tab or a dashboard.

```
✦ Agents  ● 2 running  ● 1 need you                         [ Last 30m ▾ ]
               −25m      −20m      −15m      −10m      −5m        now
[✳] Researcher │ [G][N] Competitor pricing ┐          [N][S] Customer interviews ▌
    Opus 5.5   │                           ┆
[✳] Writer     │                           └─▶ [F][N] Draft pricing page        ▌
    Sonnet 5.5 │
[◎] Reviewer Idle│ ◐ PR #482 billing
    GPT-6 Sol  │
[✦] Ops Needs you│ [H] Sync CRM            [S][GH] Rotate API keys   [▲ Needs you]
    Gemini 3.8 │
```

**Header**

| Key | Type | Values |
|---|---|---|
| `title` | const | "Agents" with a sparkle icon |
| `runningCount` | int | blue dot · "{n} running" |
| `needYouCount` | int | orange dot · "{n} need you"; hidden at 0 |
| `range` | enum | `15m` \| `30m` (default, "Last 30m") \| `1h` \| `session` |

**Axis**: ticks every 5 minutes as relative labels (`−25m … −5m`), the right edge is a **now** chip, faint vertical grid lines. Bars that started before the window fade in from the left edge.

**Lane (one per agent)**

| Key | Type | Values |
|---|---|---|
| `agentId` / `threadId` | string | main agent and each helper |
| `name` | string | "Researcher" |
| `avatar` | image | model family logo (Anthropic / OpenAI / Google) or Robot look |
| `modelLabel` | string | `shortLabel`, e.g. "Opus 5.5" |
| `laneStatus` | enum | `running` (no badge) \| `idle` (grey "Idle") \| `needsYou` (orange "Needs you") \| `failed` (red "Failed") |

**Bar (one per task)**

| Key | Type | Values |
|---|---|---|
| `id` | string | |
| `title` | string | task title, e.g. "Competitor pricing" |
| `startedAt`, `endedAt` | ISO \| null | null end = runs to now |
| `state` | enum | see the table below |
| `tools[]` | `{server, icon}` | connector logos used in this task (from MCP tool calls), max 3 + "+n" |
| `dependsOn` | barId? | handoff from another agent's bar → dashed connector arrow |
| `pendingRequestId` | string? | for `needsYou` |

| Bar `state` | Look | Interaction |
|---|---|---|
| `done` | grey `--surface-3`, grey text | click → HelperDetail Output |
| `running` | blue gradient, `--accent-fg` text, solid right edge at "now" | click → live detail |
| `needsYou` | `--warning-bg`, warning text, inline **▲ Needs you** button | button → opens the pending ToolApprovalCard / QuestionCard |
| `failed` | `--error-bg`, error text | click → error + **Retry** |
| `stopped` | neutral, dashed outline | click → partial output |
| `queued` | outline only | — |

Data mapping: lanes come from `subagent.spawned/status/completed` (main agent = lane 0), bars from `task` + `startedAt/endedAt`, tool icons from `mcpToolCall.server` grouped by thread, arrows from `collabAgentToolCall.senderThreadId → receiverThreadIds`, and `needsYou` from a pending request on that thread.
Gaps: helper requests are not routed per thread today, and tool calls are hidden from the browser (4.5). Both need backend work.
Accessibility: give the chart a text list alternative ("Researcher: Customer interviews, running, 8 minutes"), the same way StepTimeline does.

---

## 9. MCP connectors

### 9.1 Connector (data)

| Key | Type | Values |
|---|---|---|
| `id` | string | |
| `name` | string | `[A-Za-z0-9_-]{1,64}`, e.g. `sap-tools` |
| `transport` | const | `http` (local stdio is blocked) |
| `url` | URL | "https://example.com/mcp"; shown as `urlHost` |
| `auth.kind` | enum | `none` \| `bearer` \| `header` |
| `auth.headerName` | string? | header auth only, e.g. `x-api-key` (1–128 chars, reserved headers rejected) |
| `apiKey` | secret | write-only; the UI only sees `hasKey` |
| `scope` | enum | `user` \| `tenant` |
| `enabled` | bool | false → "(unavailable — remove attachment)" |
| `agentIds[]` | string[] | which agents use it |
| `warnings[]` | string[]? | |

### 9.2 Connected tools sheet (McpSettings) — `BUILT`

Sheet "Connected tools" / "MCP servers attached to {agent}. Changes apply to new chats." (no agent: "Select an agent to manage its tools.")

1. **Available servers**: checkbox rows "{name} · {transport}"; disabled rows can only be unchecked; "Missing profile: {id} · unknown"; empty "No MCP servers configured yet."
2. **Save attachments** → `POST /api/agents/:id/mcp {profileIds}` → "Saved. Start a new chat to use these MCP servers."
3. **Add an MCP server** (disclosure): Name · Endpoint URL · Authentication (**None** / **Bearer token** / **API key header**) · Header name (header only) · API key (password, when auth isn't none) · **Create server** → `POST /api/mcp` → "Server created and selected. Save attachments to enable it for this agent."

States: "Loading configuration…", busy (fields disabled), error banner, name clash (409).

### 9.3 ConnectedTools pill (composer) — `BUILT` (not mounted)

Plug icon + up to 3 tool chips (dot + name; disabled chips greyed) + "+N"; or "Loading tools…" / "Tools unavailable" / "Connect tools". Click opens the sheet (`/mcp`).

### 9.4 Connector status and edit — `NEW`

Missing today: live connection status (`connected` / `connecting` / `auth required` / `error`, from `mcp.status`, which is hidden now), the tool list per server, edit, delete, OAuth, and a tenant-wide admin view. The platform API already supports delete/patch.

---

## 10. Session panel (activity bar)

### 10.1 Frame — `BUILT`

Head: pulse icon + "Session activity" + **Follow** (toggle, "Follow activity") + **Expand** / **Shrink** + **Close** X.

| Tab key | Label | Badge | Body |
|---|---|---|---|
| `activity` | Activity | — | 10.3 |
| `agents` | Agents | `{running}` live or `{total}` | 8.7 |
| `goal` | Goal | dot when active | 7.7 |
| `plan` | Plan | `{done}/{total}` | 5.4 |
| `insights` | Insights | — | 11.1 |

Tab keyboard: `←` `→` wrap, `Home` / `End`. Tabs other than Activity remount on switch.

### 10.2 Follow activity (auto-switch tab)

| Key | Value |
|---|---|
| Followable tabs | `goal` < `plan` < `agents` (the most specific wins) |
| Triggers | a fresh active `goal.updated`; `plan.updated` with changed steps when no goal is active; a new helper |
| Batch window | 300ms (`FOLLOW_BATCH_MS`) |
| Manual hold | 8s after the user picks a tab (`MANUAL_HOLD_MS`) |
| Stale | 60s |
| Action | panel open → switch (unless the pointer or focus is inside); closed + wide screen (> 900px) + fits → open |
| Pref | localStorage `truex-follow-activity` = `on` (default) / `off` |
| Announce | "Session activity is showing the {Goal\|Plan\|Agents} tab." |

### 10.3 Activity tab — `BUILT`

1. **Live head**: pulse + "Working" / "Idle" + meta ("Goal in progress" / agent name / "Waiting for a request")
2. **Live card** (running): icon tile · current step / live label / "Working on your request" · sub "Waiting for your approval" / "Step {n} of {total}" / "Started {time}" · "{pct}%" · ProgressBar
   Or the **Last run card**: "Last run: {label}" · "Completed in {dur}" / "Ended in {dur}" · "{done} of {total} steps"
3. **Recent** + **View all** / **Show less** (8 rows by default)
4. **Timeline rows**: dot icon · title · meta (duration / "Helper agent") · time

| Event | Row title | Icon |
|---|---|---|
| `turn.started` | Working on your request | pulse |
| `turn.completed` (completed) | Request finished | check |
| `turn.completed` (failed) | Request failed: {reason} | x, `is-bad` |
| `turn.completed` (interrupted) | Request stopped | stop |
| `turn.completed` (other) | Request ended | pulse |
| `error` | Retrying… (`willRetry`) / failure | x |
| `subagent.spawned` | Started a helper | bot |
| `subagent.status` | Helper status changed | bot |
| `subagent.completed` | Helper finished | bot |
| `activity.updated` | `{label}`, e.g. "Searching the web" | matched: chart, globe, table, doc, plug, pulse |
| `approval.requested` | `NEW`: "Waiting for your approval" | shield |
| `mcpToolCall` | `NEW`: "Used {connector}" | plug |

Empty: "Business activity will appear here."

---

## 11. Insights and charts

### 11.1 Insights tab — `BUILT`

Empty: "No insights yet" / "Timing and usage for each response will appear here."

**KPI tiles**

| Tile | Value | Sub-line |
|---|---|---|
| Average time | avg turn duration | "{n} responses" |
| Slowest | max duration | "Slowest 5% {p95}" |
| Tokens | total | "{n} from helpers" or "{pct} cached" |
| Helpers | count | "{n} finished" |
| Personal data | findings count or "None" (warn tone) | "Pattern checks on sent text" |

**Cards**

| Card | Chart | Series / axes | Notes |
|---|---|---|---|
| Tokens by agent | ShareBar (horizontal 100% stacked) | Main agent (`tone-main`) + helpers (`tone-0..2`) | legend table: tokens + share ("0%", "<1%", rounded) |
| Time by agent | horizontal bars | one row per agent | "Helpers run in parallel, so their times overlap." |
| Main agent context | Meter | used / window | warn ≥ 75%, crit ≥ 90%; "{used} of {window} · {pct}"; "Only the main agent's context is shown." |
| Time per response | ColumnChart | x = turn, y = duration | the slowest column is highlighted |
| Tokens per response | stacked ColumnChart | New input / Cached / Output | key legend |
| Usage limits | Meters per window | primary / secondary used % | "Usage limit reached. New requests may wait…"; window label: Weekly / Daily / {n}-hour / {n}-minute limit; "resets in {h}h {m}m" |
| Streaming details | disclosure, 3-segment bar per turn | first output · stream · finalize | "Turn {n} · {status} · non-streaming"; "First output {} · stream {} · total {}" |

### 11.2 Chart primitives

| Primitive | Type | Props | Behaviour |
|---|---|---|---|
| StackedBar / ShareBar | horizontal part-to-whole | `segments[{label, value, tone}]`, formatter | `role=img` with a full text alt; `is-empty` state |
| Meter | 0–1 gauge | `value`, `high` 0.75, `critical` 0.9, caption, detail | `role=meter` |
| ColumnChart | SVG vertical columns (optionally stacked), one per turn | slot 12, bar 8, height 64, `highlight` | `<title>` tooltip per column; full-height hit area; 1px gap between stacked segments |
| StepTimeline | Gantt swimlane per agent | `steps: StepSpan[]` | see 11.4 |
| AgentActivityTimeline | swimlane over wall-clock time | see 8.9 | `NEW` |

### 11.3 Data used by the charts

| Type | Keys |
|---|---|
| `TurnUsage` | `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, `totalTokens`, `contextWindow`, `contextUsedTokens` |
| `TurnTiming` | `acceptMs`, `ttftMs`, `streamMs`, `adapterStreamMs`, `idleStreamMs`, `maxGapMs`, `deltaRate`, `finalizeMs`, `totalMs`, `deltaCount`, `nonStreaming`, `status` |
| `TurnTrace` | `turnId`, `startedAt`, `totalMs`, `status` (`completed` \| `failed` \| `interrupted`), `model`, `steps[]`, `usage`, `helperUsage`, `rateLimits`, `privacy` |
| `StepSpan` | `kind`, `label`, `startMs`, `durationMs`, `status` (`running` \| `completed` \| `failed` \| `declined`), agent lane |
| `RateLimitView` | `limitName`, `primaryUsedPercent`, `secondaryUsedPercent`, `primaryWindowMins`, `secondaryWindowMins`, `primaryResetsAt`, `secondaryResetsAt`, `reached`, `at` |
| `TraceSummary` | `turns`, `avgTotalMs`, `p95TotalMs`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, `helperTokens`, `privacyFindings` |

### 11.4 StepTimeline — `BUILT`

Lanes per agent (main first, helpers marked). Bars are placed by `startMs` and duration as a % of the turn (minimum width 1.5%). Axis runs from "0s" to "{span}".

| `kind` | Label |
|---|---|
| `thinking` | Thinking |
| `message` | Writing the reply |
| `command` | Ran a command |
| `tool` | Used a tool |
| `fileChange` | Changed files |
| `webSearch` | Searched the web |
| `agent` | Worked with a helper |
| `other` | Other step |

Marks: `is-slowest` (tag "Slowest"), `is-running` ("Running…"), `is-failed` ("Failed after {dur}" / "Declined"). It also renders a text list alternative.

### 11.5 TokenBar — `BUILT`

StackedBar segments: **New input** (`seg-new`), **Cached input** (`seg-cached`), **Reply** (`seg-output`), **Reasoning** (`seg-reasoning`). Cached and reasoning are taken out of input and output so the segments don't overlap. Below it: "Helpers used another {n} tokens." and a context Meter ("{pct} of context"). Empty: "Token usage was not reported for this turn."

### 11.6 PrivacyCard — `BUILT`

| State | Shows |
|---|---|
| ok | shield-check icon, "No personal data detected" + "Checked {n} characters for emails, phone numbers, card and account numbers, IDs and access keys. Pattern checks can miss things." (it never says "clean") |
| warn | shield-alert icon, "Personal data detected" + findings "{count} {label}s in {source}" + masked sample + "This was sent to the model as part of the turn. Samples are masked." |

Kinds: `email`, `phone`, `card`, `iban`, `ssn`, `aadhaar`, `pan`, `ip`, `secret`. Sources: `userMessage` "your message", `toolOutput` "a tool output", `command` "a command", `fileContent` "file content", `assistant` "the reply". Scan limit 200,000 chars.

### 11.7 TraceCard (expanded receipt) — `BUILT`

Sections: **Where the time went** ({dur} total) → StepTimeline · **What it used** ({model}) → TokenBar · **Your data** → PrivacyCard · checkbox **Developer details**.
Developer details: IDs Turn / Thread / Status · **What the model saw** (states loading / ready / gone "No longer available, context is kept only while the session is live." / error; "Reconstructed" tag; "Long sections were shortened.") · **Show trace JSON** / **Hide trace JSON** · **Copy trace JSON** ("Copied" for 1.5s).

### 11.8 Formatters

| Formatter | Rule |
|---|---|
| Duration | < 1s "{n}ms"; < 10s "{x.x}s"; < 60s "{n}s"; else "{m}m {s}s" |
| Tokens | < 1000 raw; else "{x.x}k" (rounded from 100k) |
| Percent | "<1%" or "{n}%" |
| Reset | "resets now" / "resets in {m}m" / "{h}h {m}m" / "{d}d {h}h" |
| Time of day | `h:mm` |

---

## 12. Conversation tools and slash commands

### 12.1 QuickTools ("Conversation tools") — `BUILT`

| Control | Does |
|---|---|
| **Fork conversation** | `thread/fork` → opens the new branch |
| **Compact context** | `thread/compact/start` |
| Model settings: **Model** (input "Model identifier (optional)") + **Reasoning effort** (`none` \| `minimal` \| `low` \| `medium` (default) \| `high` \| `xhigh` \| `ultra`) + **Apply settings** | `thread/settings/update {model?, effort}` |
| **Archive conversation** | `thread/archive` |
| Result line | "Done." or an error |

### 12.2 Slash commands — `BUILT` (off)

| Command | Args | Result message |
|---|---|---|
| `/goal` | none or `show` | shows the goal |
| `/goal <objective>` | text | "Goal updated." |
| `/goal pause` · `resume` | — | pause / resume |
| `/goal budget <tokens>` | `50k` | usage hint if invalid |
| `/goal clear` | — | "Goal cleared." |
| `/fork` | — | "Created a conversation branch." |
| `/compact` | — | "Context compaction requested." |
| `/model <id>` | no spaces | "Model changed to X." |
| `/effort <level>` | see 12.1 | "Reasoning effort changed to X." |
| `/archive` · `/unarchive` | — | "Conversation archived." / "Conversation restored." |
| `/tools` · `/mcp` · `/agents` | — | opens that panel |
| `/help` | — | shows the command list |

Extra arguments give: "{name} takes no arguments. Use /help for command syntax, or prefix with // to send it as a question."

### 12.3 CommandResult (card after a command) — `BUILT`

| Key | Values |
|---|---|
| label | help "Chat commands" · goal "Goal" · fork "Conversation branch" · compact "Context" · settings "Settings" · archive "Archive" · unarchive "Restore" · else "Command" |
| `state` | `running` "Awaiting confirmation" (spinner) · `succeeded` "Confirmed" · `failed` "Failed" · `unknown` "Unconfirmed" |
| details | goal: Status, Time spent, Tokens used, Token budget · settings: Model, Reasoning effort |
| buttons | **Check goal status** · **Clear goal…** · **Open conversation branch** · **Check saved result** |

---

## 13. Auth and workspace screens

| Screen | Key content | States |
|---|---|---|
| Login (`LIVE`) | split layout; eyebrow "Sign in or create an account"; h1 "Pick up where your *agents* left off"; 3-step progress **Account / Access / Workspace** ("0 of 3"); **Continue with Google** | cookies blocked banner; signed in → redirect |
| SessionGate (`LIVE`) | wraps the app | `loading` · `ready` · `signedOut` · `blocked` ("Can't open this workspace") · `unavailable` ("Truex is unavailable"); rechecks every 5s; syncs login/logout across tabs |
| Select workspace (`LIVE`) | list of tenants | — |
| Invite / join (`BUILT`) | invite board + capability list | valid / expired / used |
| Confirm name (`LIVE`) | the Google name prefilled, editable | saving / error; `POST /auth/profile/name` |
| Manage workspaces (`BUILT`) | switch, team invites (admin) | — |

---

## 14. Events → components map

The browser receives these SSE event types (`DomainType`):

| Event | Key fields | Updates |
|---|---|---|
| `snapshot` | full state | everything (on reconnect) |
| `turn.started` | — | AssistantMessage placeholder, Activity live card, composer → Stop |
| `message.delta` / `message.final` | `delta` / `text`, `messageIndex` | AnswerBody |
| `reasoning.delta` | `delta`, `method` | ThinkingBlock |
| `item.started` / `item.completed` | `item {id, type, …}` | ThinkingBlock (reasoning); ToolActivityRow / WebSearchRow / Compaction (`NEW`) |
| `activity.updated` | `label` | Working line, Activity row |
| `plan.updated` | `plan[]`, `explanation` | PlanSteps, Plan tab, goal Checkpoints, follow → Plan |
| `approval.requested` | PendingRequest | PlanApprovalCard / QuestionCard / ToolApprovalCard, timeline `needsYou` |
| `approval.resolved` | `requestId`, `audit` | closes the card → ApprovalRecord |
| `goal.updated` / `goal.cleared` | `goal` | GoalBar, Goal tab, topbar "working on goal" |
| `subagent.spawned` / `status` / `completed` | `agent: SubAgent`, `label` | HelperGroup, HelperChip, Agents tab, AgentActivityTimeline |
| `subagent.event` | helper `message.delta` / `final` / `reasoning.delta` / `turn.*` | HelperDetail live output |
| `usage.updated` | `usage` | LiveUsage, context Meter |
| `limits.updated` | `rateLimits` | Usage limits card |
| `error` | `message`, `code`, `reason`, `httpStatus`, `willRetry`, `turnId` | TurnError / banner, Activity row |
| `turn.completed` | `timing`, `trace`, `turn.status` | TurnReceipt, Insights, Activity last-run card, composer → Send |
| `resync.required` | — | refetch the snapshot |

Hidden from the browser today: `session.created`, `thread.started`, `mcp.status`, `diff.updated`, `runtime.event`, and items other than reasoning and messages. That hides `mcpToolCall`, `dynamicToolCall`, `webSearch`, `collabAgentToolCall`, `contextCompaction` and `imageGeneration`. Commands and file changes stay hidden by policy.

Stream ends: `saved`, `unavailable`, `notFound`, `signedOut`, `lost`. Reconnect backoff: 250ms → 1s → 2s → 4s → 8s. 40s of silence counts as a lost connection.

---

## 15. Open items for v2 design

1. **Tool activity in the chat**: show MCP tool calls, web search and compaction (4.5–4.7). The platform's public filter has to let these item types through, without commands or paths.
2. **Inline turn errors** (4.12) instead of only a page banner.
3. **AgentActivityTimeline** (8.9): helper approvals and tool calls need to be tied to a thread.
4. **MCP elicitation card** (6.4) and **connector status** (9.4): today these are auto-declined or hidden.
5. **Attachments in the composer** (3.7).
6. **Share** button in the topbar has no flow.
7. **Thinking** is deferred on the live chat; decide whether v2 shows it.
8. **Steer** is off on the live chat (Send becomes Stop); the legacy stack supports it.
9. On the live tenant chat (platform-next) only text chat, agents, models, the receipt line and auth are built. Plan, goals, approvals, helpers, insights, documents and visuals exist only in the legacy stack and need porting.
