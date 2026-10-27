# Truex v2: Component Catalog

The component inventory for the v2 redesign. Each entry lists what the component shows, its data keys with example values, every visual state, and its buttons and what they do. Use it to draw screens and to build them.

Source of truth: `shared/contracts.ts`, `shared/protocol/v2/*` (pinned Codex), `platform-next/src/modules/chats/chat.ts`, `frontend/lib/*`, `docs/CHAT_UI_SCHEMA.md` (code-level detail) and `docs/truex-design-spec.html` (tokens and layout). Written 2026-10-19.

## How to read this

Each component has an availability tag that says where its data comes from today:

| Tag | Meaning |
|---|---|
| `LIVE` | Data reaches the browser on the current platform (legacy `platform/` stack). |
| `V1` | Also available on the new chat v1 stack (`platform-next` + `runtime-adapter`). |
| `PROTO` | The pinned Codex runtime produces it, but the platform doesn't forward or render it yet. Needs platform work, no Codex change. |
| `NEW` | Needs new backend data or a new endpoint. |

Chat v1 today carries only text messages, stop, usage and timings. Everything else (plan, goal, approvals, tools, helpers) is `LIVE` on the legacy stack and must be ported to platform-next before v2 can show it there.

Key notation: `key: type = example`. `?` marks optional keys. Enums list every value.

## Contents

1. [Global enums](#1-global-enums)
2. [App shell](#2-app-shell)
3. [Composer](#3-composer)
4. [Conversation stream (AI response)](#4-conversation-stream-ai-response)
5. [Human-in-the-loop requests (plan approval, questions, MCP approval)](#5-human-in-the-loop-requests)
6. [Plan mode](#6-plan-mode)
7. [Goal](#7-goal)
8. [Session panel (activity bar)](#8-session-panel-activity-bar)
9. [Agents and helpers](#9-agents-and-helpers)
10. [MCP / connected tools](#10-mcp--connected-tools)
11. [Charts and observability](#11-charts-and-observability)
12. [Auth, tenant and onboarding screens](#12-auth-tenant-and-onboarding-screens)
13. [Primitives](#13-primitives)
14. [Design tokens](#14-design-tokens)
15. [Stream event → component map](#15-stream-event--component-map)

---

## 1. Global enums

These values drive most visual states. Every component below references them.

| Enum | Values | Drives |
|---|---|---|
| `TurnState` | `idle` · `starting` · `running` · `interrupting` | Send/Stop button, live header, typing caret |
| `RunStatus` (v1) | `accepted` · `running` · `completed` · `stopped` · `failed` · `uncertain` | Message footer, retry affordance |
| `MessageState` (v1) | `complete` · `stopped` · `failed` | Assistant bubble end state |
| `Message.delivery` | `pending` · `accepted` · `failed` · `unknown` | "Sending…" / "Delivery unconfirmed" under user bubble |
| `PlanStep.status` | `pending` · `inProgress` · `completed` | Step mark (dot / spinner / check) |
| `GoalStatus` | `active` · `paused` · `blocked` · `usageLimited` · `budgetLimited` · `complete` | Goal bar tone, pill, actions |
| `GoalReview.decision` | `accepted` · `reopened` | "Ready for review" vs "Accepted" |
| `SubAgentStatus` | `pendingInit` · `running` · `interrupted` · `completed` · `errored` · `shutdown` · `notFound` | Helper chip, lane bar |
| `StepKind` | `thinking` · `message` · `command` · `tool` · `fileChange` · `webSearch` · `agent` · `other` | Step icon in timelines |
| `StepSpan.status` | `running` · `completed` · `failed` · `declined` | Gantt bar colour |
| `McpToolCallStatus` | `inProgress` · `completed` · `failed` | Tool call card |
| `McpServerConnectionStatus` (`PROTO`) | `notStarted` · `starting` · `connected` · `authenticationRequired` · `failed` · `cancelled` · `disabled` | MCP server status dot |
| `McpAuthStatus` (`PROTO`) | `unknown` · `unsupported` · `notLoggedIn` · `bearerToken` · `oAuth` | MCP sign-in state |
| `ApprovalMode` | `ask` · `readOnly` · `auto` | Composer approval picker |
| `ToolDecision` | `allowedOnce` · `allowedSession` · `allowedChat` · `allowedAlways` · `declined` · `expired` · `interrupted` | Approval record badge |
| `ApprovalRecord.outcome` | `answered` · `auto` · `expired` · `interrupted` | Approval record footer |
| `ErrorReason` | `rateLimited` · `quota` · `credentials` · `providerDown` · `contextWindow` · `other` | Error card label, hint, action |
| `StreamStatus` | `Connected` · `Reconnecting` · `Disconnected` | Connection banner |
| `PrivacyKind` | `email` · `phone` · `card` · `iban` · `ssn` · `aadhaar` · `pan` · `ip` · `secret` | Privacy findings |
| `AgentTint` | `ice` · `mint` · `butter` · `peach` · `lilac` | Agent badge frame colour |
| `AgentSource` (v1) | `builtin` · `personal` · `tenant` | Agent picker grouping |
| `ReasoningEffort` | `none` · `minimal` · `low` · `medium` · `high` · `xhigh` | Model chip |
| `UserRole` | `user` · `admin` | Admin-only controls |
| `Visualization.mode` | `inline` · `wide` | Visual width |
| `DocumentKind` | `code` · `text` · `sheet` · `slides` · `document` | File icon |

---

## 2. App shell

### 2.1 AppShell `LIVE` `V1`

Three columns: left sidebar, center stage, right session panel. Composer and dock float at the bottom of the stage.

```ts
shell: {
  sidebarOpen: boolean = true,          // 268px open, 0 closed
  panelOpen: boolean = false,           // session panel, width var(--pw) = 360px
  panelSize: "normal" | "wide" | "detail" = "normal",
  panelTab: "activity" | "agents" | "goal" | "plan" | "insights" = "activity",
  followActivity: boolean = true,       // auto-switch panel tab on new goal/plan/helper
  theme: "light" | "dark" | "system" = "system",
  viewport: "desktop" | "tablet≤900" | "mobile≤720",
  streamStatus: StreamStatus = "Connected",
}
```

| State | What changes |
|---|---|
| Empty (no chat) | Stage shows Hero + composer centered |
| Chat open | Stage shows thread + composer pinned bottom |
| ≤900px | Session panel becomes an overlay (fixed, z 30) |
| ≤720px | Full-bleed stage, sidebar becomes a left drawer |
| Reconnecting | Top banner "Reconnecting…" (stream retrying) |
| Disconnected | Banner "Live updates stopped unexpectedly. Reopen the conversation to reconnect." + Reconnect |

Keyboard (`mod` = ⌘/Ctrl, fire even while typing): mod+K search palette, mod+B sidebar, mod+. session panel, mod+J new chat (ignored while busy). Esc closes the top layer.

### 2.2 Sidebar `LIVE` `V1`

```ts
sidebar: {
  brand: { word: "truex", sub: "workspace" },
  tenant: { id: "t_123", name: "Default tenant", role: "admin" },
  nav: [{ key: "agents", label: "Agents", active: false }],
  newChatButton: { label: "New chat", shortcut: "⌘J" },
  searchTrigger: { label: "Search", shortcut: "⌘K" },
  groups: [ { label: "Today" | "Yesterday" | "Previous 7 days" | "Older", chats: ChatListItem[] } ],
  hasMore: boolean,                    // v1 pages 30 chats at a time
}
```

States: loading (skeleton rows), empty ("No conversations yet"), list, load-more, error ("Couldn't load conversations" + Retry).

#### ChatListItem

```ts
{
  id: "6710f…",
  title: "Q3 pricing review",          // v1: first 60 chars of first message; renamable
  agent: { name: "General Agent", handle: "generalagent", tint: "ice" },
  lastMessageAt: "2026-10-19T04:12:00Z", // shown "4:12 AM" / "Yesterday" / "Sep 3"
  status: "active" | "archived",
  running: boolean,                    // activeRun != null → pulse dot
  goal?: { objective: "Ship pricing page", status: "active" },  // LIVE only
  readOnly?: "modelDisabled" | "runtimeLost",   // v1: chat can't take new turns
  selected: boolean,
}
```

Row actions (hover menu `⋯`): Rename, Archive / Restore. v1 has no delete.

| Row state | Visual |
|---|---|
| default / hover / selected | `--surface-3` on hover/selected |
| running | pulse dot before title |
| goal active | small target icon |
| read-only | lock icon, tooltip "This chat can no longer take messages" |
| renaming | inline input, Enter saves, Esc cancels |

### 2.3 Topbar `LIVE` `V1`

```ts
{
  title: "Q3 pricing review",
  agentChip: { name: "Researcher", model: "Opus 5.5", tint: "ice" },
  actions: ["share", "theme", "panelToggle"],   // Share is not wired today
  panelToggleBadge?: "live" | number,           // dot while running
}
```

### 2.4 Hero (empty chat) `LIVE` `V1`

```ts
{
  greeting: "Good evening, Ashok",               // display font, italic accent word
  placeholderRotation: ["Ask anything…", "Plan a launch…", "Summarise this deck…"],
  suggestions: string[],                         // SuggestedQuestions chips
}
```

### 2.5 FloatingDock `LIVE`

Bottom-centered magnifying icon dock (Aceternity style, 56px high, 20px radius, blur 14px).

```ts
items: [
  { key: "agent",    icon: "bot",    label: "Agent",    popover: "AgentPicker" },
  { key: "tools",    icon: "plug",   label: "Tools",    popover: "ConnectedTools" },
  { key: "files",    icon: "doc",    label: "Files",    sheet: "AssistantTools" },
  { key: "activity", icon: "pulse",  label: "Activity", badge?: "live" },
]
```

States per item: rest, hover (magnify), active (popover open), badge (pulse dot).

### 2.6 SearchPalette `LIVE`

```ts
{ open: boolean, query: "pricing", results: [{ kind: "chat" | "agent" | "command", id, title, sub }], activeIndex: 0 }
```

States: empty query (recent chats), results, no results ("No matches for 'x'"), keyboard navigation (↑↓ Enter Esc).

### 2.7 UserMenu `LIVE` `V1`

```ts
{ name: "Ashok", email: "a@x.com", picture?: url, tenant: "Default tenant",
  items: ["Account", "Manage workspaces", "Connected tools", "Developer details (toggle)", "Theme", "Sign out"] }
```

### 2.8 Popover / Menu / Sheet / Dialog `LIVE`

| Primitive | Keys | States |
|---|---|---|
| Popover | `anchor`, `placement: "top" \| "bottom"`, `open` | closed, open (rise .16s) |
| Menu | `items: { key, label, icon?, danger?, disabled? }[]`, `activeIndex` | arrow keys, Home/End, Esc returns focus |
| Sheet (side drawer) | `title`, `description`, `open` | slides in 24px, .22s |
| Dialog | `title`, `body`, `primary`, `secondary`, `danger?` | modal over scrim (blur 2px) |
| ConfirmDialog | `message: "Clear this goal? Its progress will no longer be tracked."`, `confirmLabel`, `tone: "danger" \| "default"` | |

---

## 3. Composer

### 3.1 Composer `LIVE` `V1`

```ts
composer: {
  text: "Draft the pricing page",
  placeholder: "Message Researcher…",
  mode: "chat" | "goal" | "plan",            // goal = drafting a goal objective; plan = ask for a plan first (NEW)
  agent: AgentSummary,                       // see 9.6
  model: { name: "Opus 5.5", reasoningEffort: "high" },   // chip; v1 pins model per chat
  approvalMode: "ask" | "readOnly" | "auto", // flag APPROVAL_MODES
  budget?: { tokens: 100000 | null, valid: true },        // goal mode only
  attachments: [],                           // NEW in v2 (upload lives in Files today)
  slashMenu: { open: false, query: "", items: SlashCommand[], activeIndex: 0 },
  turnState: TurnState,
  charCount: 1240, maxChars: 32000,          // v1 cap
  rateLimited?: { retryAfterSec: 34 },       // v1: 20 sends/min/user
  disabledReason?: "readOnly" | "noModel" | "sending",
  notice?: "Delivery unconfirmed. Check the conversation before sending again.",
}
```

Send button states:

| Condition | Button | Label / icon |
|---|---|---|
| empty text | Send, disabled | arrow-up |
| text present, idle | Send | arrow-up, ⏎ submits, ⇧⏎ newline |
| `starting` / sending | Send, busy | spinner |
| `running` | **Stop** | square; v1 rejects new messages while busy |
| `running` + steer enabled (LIVE) | Send + Stop | message joins the running turn, tagged "Follow-up" |
| `interrupting` | Stop, busy | "Stopping…" |
| goal mode + running goal | Stop pauses the goal, then interrupts | |
| read-only chat | hidden; banner "This chat is read-only because its model was disabled." | |

Composer rows (top to bottom): attachments row (v2), textarea (auto-grow, 15px), toolbar: mode switch · agent chip · model chip · approval picker · tools pill · char counter · Send/Stop. Below: `PrivacyNote` ("Truex checks messages for personal data") and composer note line.

### 3.2 ModeSwitch `LIVE` (goal) / `NEW` (plan)

```ts
{ value: "chat" | "goal" | "plan", options: [
  { key: "chat", label: "Chat" },
  { key: "goal", label: "Goal", hint: "The assistant keeps working until it's done, paused or out of budget." },
  { key: "plan", label: "Plan first", hint: "Review the steps before the assistant starts." },
]}
```

Goal mode adds a `BudgetField` and changes the placeholder to "Describe the outcome you want". Submitting with an existing goal asks "Replace the current goal with this one?" (skipped if the old goal is complete).

### 3.3 BudgetField `LIVE`

```ts
{ value: 100000 | null, options: ["No budget", "25k tokens", "100k tokens", "250k tokens", "Custom…"],
  custom: "50k", valid: true, help: "Enter a whole number of tokens, like 50000 or 50k (up to 10M)." }
```

States: preset, custom input, invalid (help in error colour).

### 3.4 ApprovalModePicker `LIVE` (flag)

| value | Label | Description |
|---|---|---|
| `ask` | Ask me every time | Default |
| `readOnly` | Auto-allow read-only tools | Uses the MCP `readOnlyHint` |
| `auto` | Autopilot | Only when `APPROVAL_MODES_AUTOPILOT=on` |

Plan approval and secret questions always ask, whatever the mode.

### 3.5 SlashMenu `LIVE`

```ts
SlashCommand: { name: "/goal", args: "<objective> | show | pause | resume | clear | budget <tokens>", description: "Set or manage the goal" }
```

Commands: `/goal [show|pause|resume|clear|budget <tokens>|<objective>]`, `/model <name>`, `/effort <none|minimal|low|medium|high|xhigh>`, `/compact`, `/fork`, `/archive`, `/unarchive`, `/tools`, `/mcp`, `/agents`, `/help`. Prefix `//` sends a literal slash. Commands are blocked while a turn runs. Keys: ↑/↓ cycle, Tab accepts, Esc closes. States: closed, filtering, no match (input sent as a plain message), active row.

### 3.6 SuggestedQuestions `LIVE`

```ts
{ questions: ["What changed since last week?", "Draft an email to the team"], onSelect: fills composer }
```

### 3.7 HelperChip (above composer) `LIVE`

```ts
{ running: 2, elapsed: "1:24", label: "2 helpers running · 1:24", action: "View" }  // hidden when 0
```

### 3.8 ConnectedToolsPill `LIVE` (unmounted today)

```ts
{ servers: [{ id, name: "notion", enabled: true }, { name: "slack", enabled: false }], max: 3, more: 2 }
```

States: loading "Loading tools…", failed "Tools unavailable", empty "Connect tools", list (≤3 chips + "+N"), off chip (strikethrough dot).

---

## 4. Conversation stream (AI response)

### 4.1 Turn group `LIVE` `V1`

One user message plus everything the agent did in response. Anchor id `turn-{turnId}`.

```ts
Turn: {
  turnId: "019a…",
  user: UserMessage,
  steps: (Thinking | ActivityLine | ToolCall | WebSearch | HelperGroup | ApprovalRecord | Visualization | DocumentCard | CompactionDivider)[],
  answer: AssistantMessage,
  receipt?: TurnReceipt,
  error?: TurnError,
  status: "running" | "completed" | "failed" | "interrupted",
}
```

Order of what streams in: `turn.started` → thinking / activity / plan / approvals / helpers → `message.delta`… → `message.final` → `usage.updated` → `turn.completed`.

### 4.2 UserMessage `LIVE` `V1`

```ts
{
  id: "c_8f2…",                 // clientMessageId
  text: "Compare our pricing with Acme and Globex",
  at: "2026-10-19T04:10:00Z",
  delivery: "pending" | "accepted" | "failed" | "unknown",
  steer?: true,                 // sent while running → "Follow-up" tag
  command?: CommandRecord,      // slash command → shows CommandResultCard below
  attachments?: ConversationFile[],   // NEW
}
```

| State | Visual |
|---|---|
| accepted | right-aligned bubble, radius 16 16 4 16 |
| pending | bubble + "Sending…" |
| failed / unknown | bubble + "Delivery unconfirmed" (warning text) |
| follow-up | small "Follow-up" tag above bubble |
| command | "Goal" / "Context" / "Settings" tag above bubble |

Actions: Copy (v1). Edit is out of scope for v1.

### 4.3 AssistantMessage (AI response) `LIVE` `V1`

```ts
{
  id: "answer:{turnId}:{itemId}",
  agent: { name: "Researcher", tint: "ice" },
  text: "## Summary\nAcme charges **$49/seat**…",   // GFM markdown, never raw HTML
  streaming: boolean,              // true until message.final
  state: "complete" | "stopped" | "failed",   // v1 MessageState
  parts: ({ type: "markdown", text } | { type: "visualization", id })[],  // inline visuals
  citations?: [{ title, url }],    // from webSearch (PROTO)
  receipt?: TurnReceipt,
}
```

| State | Visual |
|---|---|
| waiting for first token | agent avatar + "Thinking…" shimmer, watchdog 180s |
| streaming | markdown grows, blinking caret at end |
| silent > 120s mid-reply | v1 fails the run → error card |
| complete | caret gone, receipt footer appears |
| stopped | partial text + muted line "Stopped" |
| failed | partial text (if any) + TurnError card |

Markdown elements to design: h1–h4, paragraphs, bold/italic, inline code, code block (language label + Copy), ordered/unordered lists, task lists, tables, blockquote, links, horizontal rule, images (data only).

Actions: Copy message. Retry / regenerate / edit are not in v1.

### 4.4 ThinkingBlock `LIVE` (deferred in v1)

```ts
{ id: "thinking:{turnId}:{itemId}", text: "Comparing three plans…", summary?: "Comparing plans",
  streaming: boolean, wordCount: 142, open: false }
```

States: hidden (empty), streaming (spinner, "Thinking"), done (check, "142 words"), collapsed (default), expanded (plain text body). v1 defers the whole thinking feature (`backlog/features/01-live-thinking.md`).

### 4.5 ActivityLine (live status) `LIVE`

A single changing line during a turn, from `activity.updated`.

```ts
{ label: "Searching the web" | "Calling notion · search" | "Spawned Researcher" | "Working on your request",
  icon: "globe" | "plug" | "bot" | "chart" | "table" | "doc" | "pulse" }
```

### 4.6 ToolCallCard (MCP tool call) `PROTO`

The runtime emits `mcpToolCall` items; the legacy UI only shows a label. v2 card:

```ts
{
  id: "item:{turnId}:{itemId}",
  server: "notion", serverIcon?: url,
  tool: "search_pages",
  title: "Searched Notion pages",          // plain-words label, never raw args by default
  status: "inProgress" | "completed" | "failed",
  durationMs?: 820,
  arguments?: { query: "pricing" },        // developer details only
  result?: { content: [...], structuredContent?: {...} },
  error?: { message: "Rate limited by Notion" },
  approval?: ApprovalRecord,               // if it needed permission
}
```

| State | Visual |
|---|---|
| inProgress | spinner + "Calling notion · search_pages" |
| completed | check + title + duration, collapsible result preview |
| failed | x icon (error colour) + error message |
| declined | "Not allowed" badge (from approval) |

Group consecutive calls: "Used 3 tools · notion, slack" collapsible row.

### 4.7 WebSearchCard `PROTO`

```ts
{ action: { type: "search", query: "acme pricing 2026" } | { type: "open_page", url } | { type: "find_in_page", url, pattern },
  status: "inProgress" | "completed", sources?: [{ title, url, favicon }] }
```

Labels: "Searched for 'acme pricing 2026'", "Opened acme.com/pricing", "Looked for 'enterprise' on acme.com".

### 4.8 HelperGroup (subagent card in chat) `LIVE`

```ts
{ id: "agents:{turnId}", helpers: [{ threadId, name: "Researcher", tone: 0, status: "running",
  task: "Find competitor pricing", elapsed: "0:38", preview: "…Acme lists three tiers" }] }
```

Row: avatar (tone) · name · task title (48 chars) · StatusChip · time. "View" opens the Agents tab detail.

### 4.9 CommandResultCard `LIVE`

```ts
{ label: "Goal" | "Conversation branch" | "Context" | "Settings" | "Archive" | "Restore" | "Chat commands",
  state: "running" | "succeeded" | "failed" | "unknown",
  summary: "Your new conversation branch is ready.",
  details?: { Status: "In progress", "Time spent": "3m 12s", "Tokens used": "12.3k", "Token budget": "100k" },
  actions: ["Check goal status", "Clear goal…", "Open conversation branch", "Check saved result"] }
```

| state | Chip |
|---|---|
| running | "Awaiting confirmation" + spinner |
| succeeded | "Confirmed" |
| failed | "Failed" (warn) |
| unknown | "Unconfirmed" |

### 4.10 CompactionDivider `PROTO`

`contextCompaction` item. Full-width divider: "Earlier messages were summarized to free up context".

### 4.11 TurnError card `LIVE` `V1`

```ts
{ reason: ErrorReason, label: "Rate limited", message: "The model provider is limiting requests right now.",
  httpStatus?: 429, willRetry?: boolean, providerTip?: "Check credits on OpenRouter.",
  ref: { code: "PROVIDER_RATE_LIMITED", requestId?: "req_…", turnId: "019a…" },
  action: "resume" | "compact" | "retry" | null }
```

| reason | Label | Action button |
|---|---|---|
| `rateLimited` | Rate limited | Try again |
| `quota` | Out of credits | none + provider tip |
| `credentials` | Access denied | none + provider tip |
| `providerDown` | Provider unavailable | Try again |
| `contextWindow` | Conversation too long | Compact conversation |
| `other` | Stopped by an error | Try again |
| `willRetry: true` | "Retrying…" inline, no card | |

`ErrorRef` line: "Error ref PROVIDER_RATE_LIMITED · 019a…" (copyable, small mono).

### 4.12 TurnReceipt + LiveUsage `LIVE` `V1`

Quiet line under a finished answer; click expands TraceCard (§11.1).

```ts
receipt: { duration: "4.2s", tokens: "12.3k tokens", privacy: { tone: "ok" | "warn", text: "No personal data" | "2 email addresses in a tool output" }, open: false }
liveUsage: { text: "3.1k tokens so far" }    // while running; hidden at 0
```

v1 keeps usage `{ input, cached, cacheWrite, output, reasoning }` and timings `{ acceptedAt, dispatchedAt, firstTextAt, completedAt }` per run.

### 4.13 Visualization (inline chart / widget) `LIVE`

Model-authored, sandboxed HTML. No fixed chart schema: the model draws SVG/canvas.

```ts
{ id: "uuid", title: "Pricing by tier", description: "Seats vs monthly cost", mode: "inline" | "wide",
  status: "loading" | "preparing" | "loaded" | "error" | "timeout", height: 360, expanded: false,
  followUp?: { title: "Compare annual", prompt: "Show annual pricing instead" } }
```

Controls: Expand / Close expanded view, Reload visual, Download HTML, Ask about this visual. Follow-up proposal: "Add to my message" / "Dismiss". Error copy: "The visual may not have rendered correctly. Try reloading or ask Truex to revise it."

### 4.14 DocumentCard `LIVE`

```ts
{ id, name: "pricing-v2.xlsx", kind: "sheet", size: 48213, createdAt, mediaType,
  sourceId?: "f_prev",       // revision of another file → "Version 2"
  actions: ["Download", "Open"] }
```

### 4.15 ApprovalRecord (after a decision) `LIVE`

Read-only audit line that replaces the request card once answered.

```ts
{ requestId, at: "4:53 PM", outcome: "answered" | "auto" | "expired" | "interrupted", autoMode?: "readOnly" | "auto" | "grant",
  items: [
    { kind: "toolApproval", action: "notion · create_page", decision: "allowedOnce" },
    { kind: "question", question: "Which region?", answer: "EU", secret?: true },
  ] }
```

| decision | Badge | Tone |
|---|---|---|
| allowedOnce | Allowed once | allowed |
| allowedSession / allowedChat | Allowed for this chat | allowed |
| allowedAlways | Always allowed | allowed |
| declined | Not allowed | declined |
| expired | No answer — timed out | muted |
| interrupted | No answer — stopped | muted |
| auto + readOnly | Auto-allowed (read-only) | allowed |
| auto + auto | Auto-accepted (Autopilot) | allowed |

Footer: "You answered at 4:53 PM" / "Recommended option chosen" / "Closed". Secret answers show "Answer hidden".

### 4.16 Scroll and follow `LIVE`

```ts
{ following: true, threshold: 80 /*px from bottom*/, jumpToLatest: { visible: false, unread: 0 } }   // jump button is NEW
```

---

## 5. Human-in-the-loop requests

All requests share one card shell and arrive through `approval.requested`. One card per pending request. v2 should render it inline at its turn (today it sits below the whole thread).

### 5.1 RequestCard shell `LIVE`

```ts
PendingRequest: {
  requestId: "req_42",
  method: "item/tool/requestUserInput" | "mcpServer/elicitation/request" (PROTO),
  expiresAt: "2026-10-19T04:20:00Z",       // countdown "Expires in 0:42"
  detail: { questions: InputQuestion[] },
}
cardState: "open" | "sending" | "error" | "expired"
```

| State | Visual |
|---|---|
| open | icon + title + "Expires in m:ss" |
| sending | clicked button reads "Sending…", controls disabled |
| error | alert: 409 "This was already answered." · 404/410 "This request is no longer available." · else "Your answer could not be sent. Please try again." + ErrorRef |
| expired | controls locked + "No reply in time. Continuing with the recommended option." (approvals/secret: "This question has expired. Send a message to continue.") |
| resolved | card disappears, ApprovalRecord appears in its place |

Titles: "Permission needed" (tool approval) · question `header` · "Your input is needed" · "{header} ready for review" (plan).

### 5.2 PlanApprovalCard (plan mode) `LIVE`

The agent proposes an ordered list of steps; the user approves or asks for changes.

```ts
{
  header: "Plan",                                   // → "Plan ready for review"
  question: "Does this plan look right?",
  steps: [
    { step: "Collect competitor pricing pages", status: "pending" },
    { step: "Build comparison table", status: "pending" },
    { step: "Draft the pricing page", status: "pending" },
  ],
  explanation?: "I'll keep enterprise out of scope.",
  expiresAt, state: "open" | "revising" | "sending" | "expired" | "error",
  feedback: "",
}
```

Buttons:

| State | Primary | Secondary |
|---|---|---|
| open | **Approve plan** → answer `Approve` | **Revise** → opens feedback |
| revising | **Send feedback** (disabled until text) → `Revise` + `user_note: <text>` | Cancel |

Revise textarea: label "What should change?", placeholder "For example: split step 2, skip the report", ⌘⏎ sends, Esc cancels. No steps: "The drafted steps are in the message above."

### 5.3 ToolApprovalCard (MCP approval) `LIVE`

Asked before an MCP tool with side effects runs.

```ts
{
  kind: "toolApproval",
  action: "notion · create_page",                   // "Action" line; fallback "Connected business service"
  server: "notion", tool: "create_page",            // NEW: split out for icon + name
  readOnly: false,                                  // from MCP readOnlyHint
  argsPreview?: { title: "Pricing v2" },            // NEW (backend gap: approvals carry no args today)
  options: ["Allow", "Allow for this session", "Allow and don't ask me again", "Cancel"],
}
```

Buttons (display label → submitted value):

| Button | Style | Sends | Recorded as |
|---|---|---|---|
| Allow once | solid (primary) | `Allow` | allowedOnce |
| Allow for this chat | soft | `Allow for this session` | allowedChat |
| Always allow | soft | `Allow and don't ask me again` | allowedAlways |
| Don't allow | ghost | `Cancel` | declined |

Option `description` shows as tooltip. Buttons stack vertically ≤520px.

### 5.4 QuestionCard `LIVE`

```ts
InputQuestion: {
  id: "region", header: "Region", question: "Which region should I use?",
  options?: [{ label: "EU", description: "Frankfurt" }, { label: "US" }] | null,
  isOther: boolean,        // adds "Something else…"
  isSecret: boolean,       // password input, answer hidden in record
}
cardState: { step: 0, total: 3, answers: { region: "EU" }, missing: [] }
```

| Variant | Control |
|---|---|
| Single choice | option buttons (label + description), click answers |
| Choice + other | options + "Something else…" → text input |
| Free text | input, placeholder "Type your answer" |
| Secret | password input, placeholder "Enter a value" |
| Multi-question | "1 of 3" step indicator, Back / Next / **Send answer** |

Validation: "Question 2 of 3 needs an answer before you can send."

### 5.5 McpElicitationCard `PROTO`

MCP servers can ask the user directly. Not forwarded today.

```ts
{ serverName: "salesforce", mode: "form" | "url" | "openai/userVerification",
  message: "Pick the account to update",
  requestedSchema?: { properties: { account: { type: "string", enum: [...] } }, required: ["account"] },  // form
  url?: "https://login.salesforce.com/…", elicitationId?: "el_1",                                      // url (sign-in)
  title?, description?, challenge? }                                                                    // userVerification
```

Buttons: form → Submit / Decline / Cancel; url → "Open sign-in page" then "I've finished" / Cancel; verification → Verify / Cancel.

---

## 6. Plan mode

### 6.1 PlanSteps `LIVE`

Ordered checklist from `plan.updated`. Used in PlanApprovalCard, the Plan tab and goal checkpoints.

```ts
plan: {
  steps: [
    { step: "Collect competitor pricing", status: "completed" },
    { step: "Build comparison table",     status: "inProgress" },
    { step: "Draft the pricing page",     status: "pending" },
  ],
  explanation?: "Starting with public pages only.",
  progress: { done: 1, total: 3, current: 1, label: "1 of 3 done" },
  awaitingApproval: boolean,
}
```

StepMark: `completed` → check ("Done") · `inProgress` → spinner ("In progress") · `pending` → dot ("Pending"). Status is mark + text, never colour alone.

### 6.2 PlanPanel (Plan tab) `LIVE`

Header "Plan" + chip "Awaiting approval" (warn) or "1 of 3 done", progress bar, PlanSteps. Empty: "No plan yet" / "When the assistant breaks a request into steps, they appear here."

### 6.3 Plan-first flow `NEW`

Composer mode "Plan first" → agent replies with a plan → PlanApprovalCard → Approve starts execution, the plan becomes live in the Plan tab, steps tick as `plan.updated` arrives. Revise loops back with feedback.

---

## 7. Goal

A goal is a long-running objective the agent works on across turns until done, paused or out of budget. One goal per conversation.

### 7.1 Goal data `LIVE`

```ts
Goal: {
  objective: "Ship the new pricing page",
  status: GoalStatus,                 // active
  tokenBudget: 100000 | null,
  tokensUsed: 42300,                  // runtime count, drives the budget bar
  tokensObserved?: 45100,             // Truex count; display max(tokensUsed, tokensObserved)
  timeUsedSeconds: 192,               // "3m 12s"
  createdAt: 1760846400,              // identifies the goal
  updatedAt: 1760846592,
}
GoalReview: { decision: "accepted" | "reopened", feedback?: "Add annual pricing", at }
```

| status | Label | Tone | Hint |
|---|---|---|---|
| active | In progress | good | The assistant is working toward this goal. |
| paused | Paused | neutral | Resume the goal when you want the assistant to continue. |
| blocked | Needs input | warn | The assistant stopped. It needs your input or hit an error… |
| usageLimited | Usage limit reached | warn | Work stopped because model usage ran out… |
| budgetLimited | Budget reached | warn | The token budget is used up. Extend it to let the assistant keep going. |
| complete (no review) | Ready for review | review | |
| complete + accepted | Accepted | good | |

### 7.2 GoalBar (pinned above composer) `LIVE`

```ts
{
  objective, statusLabel, tone: "good" | "neutral" | "warn" | "review",
  meta: "3m 12s · 42.3k / 100k",      // or "3m 12s · 45.1k tokens" without budget
  budgetPct?: 42,                     // progress bar only with a budget
  running: boolean, turnCount?: 3,    // "· turn 3" shown when ≥2
  panel: null | "edit" | "budget",
  reopening: boolean, busy: boolean, error?: string,
  failure?: TurnFailure,              // GoalReason under the warn block
}
```

Strip: target icon · objective · meta · budget bar · status pill (pulse dot) · actions.

| State | Strip actions | Extra row / buttons |
|---|---|---|
| Active, idle | Pause · ⋯ · ✕ | |
| Working (active + running) | Pause after this turn · ⋯ · ✕ | spinner "Working on the goal · turn 3. Stop pauses it now." + "Pause after this turn" |
| Pausing (paused + running) | | "Pausing after this turn…" + **Keep going** |
| Paused | Resume · ⋯ · ✕ | |
| Needs input | ⋯ · ✕ | hint + GoalReason + **Provide input** (soft) + **Resume goal** (solid) |
| Usage limit | ⋯ · ✕ | hint + GoalReason + **Resume goal** |
| Budget reached | ⋯ · ✕ | **Extend by 25k** · **Extend by 50k** |
| Context window stop | ⋯ · ✕ | + **Compact conversation** |
| Ready for review | ✕ | Review panel (7.3) |
| Accepted | ✕ | **Start a follow-up goal** |
| Busy | all disabled | |
| Error | | inline alert |

Overflow ⋯ menu: Edit objective · Set budget · Mark complete (confirm "Mark this goal complete? The assistant stops working on it and the result is accepted."). ✕ Clear confirms "Clear this goal? Its progress will no longer be tracked."

Edit panel: textarea "Objective" (max 4000), note "Time and tokens so far carry over. If the assistant is working, it picks up the change.", Cancel / **Save objective**.
Budget panel: BudgetField, note "Counted toward the budget so far: 42.3k tokens (45.1k in total).", Cancel / **Save budget**.

### 7.3 Goal review panel + GoalCompletion `LIVE`

```ts
{ text: "The assistant marked this goal complete after 12m 4s and 88k tokens. Does the result meet your goal?",
  summary: { preview: "I drafted the page with three tiers…", truncated: true, expanded: false },
  documents: [{ name: "pricing-page.docx", kind: "document", href }],   // "2 documents created"
  reopenFeedback: "" }
```

Buttons: **Not yet** → feedback textarea ("What still needs work? (optional)") → Cancel / **Reopen goal** (goal back to active, feedback prefilled in composer). **Accept result** → Accepted.

### 7.4 GoalReason `LIVE`

```ts
{ label: "Rate limited (HTTP 429)", hint: "The model provider is limiting requests right now. Wait a moment, then resume.", tip?: "Check credits on OpenRouter." }
```

### 7.5 GoalTimeline (Goal tab) `LIVE`

```ts
{
  pill: "In progress", startedAt: "4:02 PM", objective,
  progressPct: 66,                       // 100 if complete, else plan done/total, else 0
  meta: { Budget: "100k cap" | "No budget", Used: "45.1k / 100k", Checkpoints: "2/3" | "—" },
  checkpoints: PlanStep[],               // current one marked while active
  history: GoalHistoryEntry[],           // newest first, last 60 kept
}
GoalHistoryEntry: { at, kind: "set" | "objective" | "budget" | "status" | "accepted" | "reopened" | "cleared",
  objective, status?, tokens?, tokenBudget?, feedback?, turnId?, tokensUsed? }
```

History row: icon (set target · objective pencil · budget gear · status pulse · accepted check · reopened play · cleared x), title ("Goal set", "Objective edited", "Budget set to 100k tokens", "Status: Paused", "You accepted the result", "You reopened the goal", "Goal cleared"), meta "Oct 19, 4:02 · 12k tokens · +3k since the last change", **View turn** link (scrolls to the turn; "This turn isn't loaded in the chat." if missing).

Empty: "No active goal" / "Give the assistant an outcome. It keeps working until it's done, paused or out of budget." History states: loading failed "Goal history couldn't be loaded.", empty "Goal changes will appear here."

### 7.6 Goal state machine

```
none ──set──▶ active ──pause──▶ paused ──resume──▶ active
active ──runtime──▶ blocked | usageLimited | budgetLimited | complete
blocked/usageLimited ──Resume goal──▶ active
budgetLimited ──Extend 25k/50k──▶ active
complete ──Accept──▶ complete(Accepted) ──Start follow-up──▶ composer goal mode
complete ──Reopen [feedback]──▶ active
any ──Clear──▶ none
```

---

## 8. Session panel (activity bar)

### 8.1 Panel frame `LIVE`

```ts
{
  title: "Session activity",
  tabs: [
    { key: "activity", label: "Activity" },
    { key: "agents",   label: "Agents",   badge: { count: 2, live: true } },
    { key: "goal",     label: "Goal",     badge: { dot: true } },        // when a goal is active
    { key: "plan",     label: "Plan",     badge: { text: "1/3" } },
    { key: "insights", label: "Insights" },
  ],
  activeTab: "activity",
  follow: true,            // "Follow activity" toggle; auto-switches to goal/plan/agents on new activity
  size: "normal" | "wide", // expand/shrink button (hidden ≤720px)
}
```

Header buttons: Follow activity (toggle, spark icon) · Expand/Shrink · Close. Tabs support ←/→, Home/End. Auto-follow: events within 300 ms coalesce (goal < plan < agents), a manual tab pick holds for 8 s, no switch while hovered or focused. Announces "Session activity is showing the Plan tab."

### 8.2 Activity tab `LIVE`

```ts
{
  live: {
    state: "Working" | "Idle",
    meta: "Goal in progress" | "Researcher" | "Waiting for a request",
    card?: { icon: "target" | "doc", title: "Build comparison table",   // current plan step or last activity label
             sub: "Waiting for your approval" | "Step 2 of 3 · Build comparison table" | "Started 4:02 PM",
             pct?: 66 },
    lastRun?: { label: "Last run: Draft pricing page", sub: "Completed in 4m 12s · 3 of 3 steps" },
  },
  recent: ActivityRow[],   // "View all" when > 8
}
ActivityRow: { icon: "check" | "stop" | "x" | "pulse" | "bot" | "chart" | "globe" | "table" | "doc" | "plug",
  title: "Request finished" | "Request stopped" | "Request failed: Rate limited" | "Retrying…" | "Started a helper" | "Helper finished" | "Searched the web",
  meta?: "4.2s" | "Helper agent", time: "4:53 PM" | "Yesterday" | "Sep 3", bad?: boolean }
```

Empty: "Business activity will appear here."

### 8.3 Agents tab → §9.2–9.4. Goal tab → §7.5. Plan tab → §6.2. Insights tab → §11.6.

---

## 9. Agents and helpers

Two kinds: **agents** (configured, user picks one per chat) and **helpers** (sub-agents the main agent spawns during a turn).

### 9.1 AgentsTimeline board (multi-agent chart) `NEW` (partly `LIVE`)

The "Agents · 2 running · 1 need you · Last 30m" board: one lane per agent, task bars on a time axis.

```ts
AgentsTimeline: {
  title: "Agents",
  counts: { running: 2, needYou: 1 },          // header: "● 2 running  ● 1 need you"
  window: "15m" | "30m" | "1h" | "today",      // "Last 30m" chip (menu)
  axis: { ticks: ["-25m", "-20m", "-15m", "-10m", "-5m"], now: "now" },
  lanes: AgentLane[],
  links: TaskLink[],                           // dashed connectors between tasks
}
AgentLane: {
  agentId: "ag_researcher",
  name: "Researcher",
  model: "Opus 5.5",
  providerIcon: "anthropic" | "openai" | "google" | …,
  laneStatus: "running" | "idle" | "needsYou" | "failed",   // badge next to name: "Idle", "Needs you"
  tasks: AgentTask[],
}
AgentTask: {
  id: "t1",
  title: "Competitor pricing",
  tools: ["google", "notion"],                 // MCP server icons used by the task (from mcpToolCall.server)
  startAt: "-27m", endAt?: "-18m",             // open end = running to "now"
  status: "completed" | "running" | "needsYou" | "failed" | "clipped",
  needYou?: { requestId: "req_42", label: "Needs you" },    // pending approval on that agent's thread
}
TaskLink: { from: "t1", to: "t3", kind: "handoff" }        // Researcher output → Writer task
```

| Task status | Bar | Text |
|---|---|---|
| completed | grey `--surface-3` fill | `--ink-2` |
| running | ice-blue fill, solid right edge at "now" | `--accent-fg` |
| needsYou | warm orange fill + inline "▲ Needs you" button | `--warning-text` |
| failed | soft red fill | `--error-text` |
| clipped (started before window) | left edge fades out | |

| Lane badge | When |
|---|---|
| none | running |
| Idle (neutral chip) | no running task |
| Needs you (orange chip) | any task needsYou |

Interactions: hover a bar → tooltip "{title} · {duration} · {tools}"; click → opens that chat/helper detail; "Needs you" → jumps to the request card; window chip → change range; hovering a bar highlights its links.

Data today: helpers have `startedAt`, `endedAt`, `status`, `task`, `nickname`/`role` (`LIVE`); per-step spans with lanes exist in `TurnTrace.steps` (`LIVE`). Missing: per-agent model and provider icon for helpers, tool icons per task, handoff links, cross-chat aggregation for top-level agents (`NEW`).

### 9.2 Helpers list (Agents tab) `LIVE`

```ts
{
  summary: "3 helpers · 2 running · 1 done",
  lanes?: Lane[],                                // mini Gantt when ≥2 helpers, axis "0s … 2:14"
  rows: HelperRow[],
  delegation: { mode: "explicitRequestOnly" | "proactive", maxConcurrent: 3 },  // 1–5
}
HelperRow: { threadId, name: "Researcher", tone: 0 | 1 | 2, role?: "explorer", task: "Find competitor pricing",
  status: SubAgentStatus, elapsed: "0:38", depth: 1, preview: "…Acme lists three tiers", lit: false }
```

Row: avatar · "Researcher · Find competitor pricing" · StatusChip · "0:38 · working… · level 2" · 3-line preview · chevron. Empty: "No helpers yet" / "When the assistant hands part of a task to a helper, it shows up here."

Delegation settings: "Delegation for new chats" · radios "Only when I ask" / "Whenever it helps" · select "Max helpers at once" 1–5.

### 9.3 HelperDetail `LIVE`

```ts
{ nav: { back: "All helpers", index: 2, count: 3 },
  ident: { name, sub: "explorer · Level 1 · Find competitor pricing" },
  stats: { Status: StatusChip, Duration: "1:02", Started: "4:02" },
  warn?: "This helper failed before finishing." | "This helper is no longer available.",
  tab: "output" | "task" | "transcript",
  output: { markdown, partial?: true }, task: { text, sentBy: "Sent by the main agent" },
  transcript: { state: "loading" | "ready" | "unavailable", messages: [{ id, text, final }] },
  actions: ["Copy output", "Stop"] }
```

### 9.4 StatusChip + HelperAvatar `LIVE`

| status | Label | Chip tone |
|---|---|---|
| pendingInit | Starting | running + spinner |
| running | Running | running + spinner |
| completed | Finished | done |
| interrupted | Stopped | stopped |
| shutdown | Closed | stopped |
| errored | Failed | warn ⚠ |
| notFound | Unavailable | warn ⚠ |

Avatar: first letter on `--tone-N-soft` with `--tone-N` text; sizes xs 18 / default 26 / lg 38. Tones cycle blue, green, orange; main agent grey.

### 9.5 AgentPicker `LIVE` `V1`

```ts
{ groups: [{ source: "builtin", label: "Built-in" }, { source: "personal", label: "Yours" }, { source: "tenant", label: "Team" }],
  agents: AgentSummary[], selectedId, query: "", footer: "New agent" }
```

### 9.6 AgentSummary / AgentCard `LIVE` `V1`

```ts
AgentSummary: {
  id: "ag_123", name: "Research Scout", handle: "researchscout",   // "@researchscout"
  description: "Finds and compares market data",                   // max 80
  provider: "anthropic", model: "Opus 5.5", reasoningEffort?: "high",
  look: 0–11, tint: "ice" | "mint" | "butter" | "peach" | "lilac",
  builtin: boolean, source: AgentSource, editable: boolean,
  mcpServers?: string[],                                            // NEW in card
}
```

AgentCard (roster "pinboard", spec §s-roster): tilted card (−4°…4.5°), robot look on tint frame, name, "@handle", meta "opus 5.5 · high", Built-in tag. Filters: All / Yours / Built-in + search. "New agent" card shows unless the Built-in filter or a search is active. Empty search: "No agents match".

### 9.7 AgentDialog (new / edit agent) `LIVE`

```ts
{ mode: "create" | "edit",
  fields: { name: "Research Scout" /*≤40*/, description /*≤80*/, systemPrompt /*≤20000*/, modelId, look, tint },
  preview: AgentBadge, errors: { name?: "Name is required" }, busy: boolean,
  done: { celebrate: true } }   // lanyard drop + confetti on create
```

Edits apply to new chats only (v1 decision). Built-in agents can't be edited.

---

## 10. MCP / connected tools

### 10.1 McpServer `LIVE` (+ `PROTO` status)

```ts
McpServer: {
  id: "mcp_9a…", name: "notion",            // 1–64 letters/digits/hyphens, single underscores
  scope: "user" | "tenant",                 // badge "Yours" / "Team"
  enabled: boolean,                         // false → "Unavailable"
  transport: "http",
  urlHost?: "mcp.notion.com",
  hasKey: boolean,                          // key stored, never shown
  auth: { kind: "none" | "bearer" | "header", headerName?: "x-api-key" },
  agentIds: string[], attached: boolean, editable: boolean, shadowed?: true,
  warnings?: ["This connector uses plain HTTP, so its API key and data travel unencrypted…"],
  runtimeStatus?: McpServerConnectionStatus,    // PROTO
  authStatus?: McpAuthStatus,                   // PROTO
  tools?: [{ name: "search_pages", readOnly: true }],   // PROTO
}
```

| Status dot | runtimeStatus | Copy |
|---|---|---|
| grey | notStarted / disabled | Not connected / Disabled |
| pulse | starting | Connecting… |
| green | connected | Connected · 12 tools |
| orange | authenticationRequired | Sign in required → "Sign in" button |
| red | failed | Couldn't connect → "Retry" |
| grey | cancelled | Cancelled |

### 10.2 ConnectedTools sheet `LIVE`

Title "Connected tools", description "MCP servers attached to {agent}. Changes apply to new chats."

```ts
{ servers: McpServer[], selected: ["mcp_1"], state: "loading" | "ready" | "error", busy, notice?, error? }
```

Rows: checkbox · name · scope badge · host · status dot · warnings · ⋯ (Edit, Delete — APIs exist, UI missing). Unavailable: "(unavailable — remove attachment)". Missing: "Missing profile: {id}". Button **Save attachments** → "Saved. Start a new chat to use these MCP servers."

### 10.3 AddServerForm `LIVE`

| Field | Control | Rule |
|---|---|---|
| Name | text, placeholder "sap-tools" | required, regex above, 409 on clash |
| Endpoint URL | url, "https://example.com/mcp" | required; plain HTTP warns |
| Authentication | select: None / Bearer token / API key header | |
| Header name | text "x-api-key" | only for header auth |
| API key | password | required unless None; write-only |

Button **Create server** → "Server created and selected. Save attachments to enable it for this agent."

---

## 11. Charts and observability

Three levels: receipt line (§4.12) → TraceCard → developer details.

### 11.1 TraceCard (per turn) `LIVE`

```ts
TurnTrace: {
  turnId, startedAt, totalMs: 4200, status: "completed", model: "Opus 5.5",
  steps: StepSpan[],
  usage: TurnUsage | null, helperUsage: TokenCounts | null,
  rateLimits: RateLimitView | null,
  privacy: { scannedChars: 18000, findings: [{ kind: "email", source: "toolOutput", count: 2, sample: "j***@***.com" }] },
}
```

Sections: "Where the time went · 4.2s total" (StepTimeline) · "What it used · Opus 5.5" (TokenBar) · "Your data" (PrivacyCard) · toggle "Developer details".

Developer details: Turn / Thread / Status ids; "What the model saw" (reconstructed, masked context, sections with char counts; "No longer available, context is kept only while the session is live."); "Show trace JSON"; "Copy trace JSON" → "Copied".

### 11.2 StepTimeline (Gantt) `LIVE`

```ts
StepSpan: { id, kind: StepKind, label: "Searched the web", agent: "main" | "Researcher", agentThreadId,
  startMs: 0, durationMs: 820 | null, status: "running" | "completed" | "failed" | "declined" }
layout: { lanes: ["Assistant", "Researcher"], spanMs: 4200, rows per lane, bar { leftPct, widthPct, row } }
```

| Bar | Colour |
|---|---|
| main agent | `--tone-main` |
| helper | `--tone-0` |
| slowest (when >1 step) | `--warning-text` + "Slowest" tag |
| failed / declined | `--error-text` |
| running | pulse animation 1.4s |

Axis: "0s" and total only. Below: ordered step list (text alternative) with "Running…", "Failed after 1.2s", "Declined" or duration. Empty: "No steps were recorded for this turn."

### 11.3 TokenBar → StackedBar + Meter `LIVE`

```ts
TurnUsage: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens,
  contextWindow: 200000 | null, contextUsedTokens: 61000 | null }
segments: [ { key: "newInput", label: "New input", tone: "seg-new" }, { key: "cached", label: "Cached input", tone: "seg-cached" },
            { key: "output", label: "Output", tone: "seg-output" }, { key: "reasoning", label: "Reasoning", tone: "seg-reasoning" } ]
```

StackedBar: 14px bar, legend always shows values, zero entries muted, empty bar when total 0. Helper note "Helpers used another 8.2k tokens." Meter "Context window" "31% of context" / "61k of 200k tokens".

| Meter state | Threshold | Fill |
|---|---|---|
| normal | < 75% | `--accent-2` on `--accent-soft` |
| warn | ≥ 75% | `--warning-text` on `--warning-bg` |
| crit | ≥ 90% | `--error-text` on `--error-bg` |

Empty: "Token usage was not reported for this turn."

### 11.4 ColumnChart `LIVE`

```ts
Column: { id, label: "Response 3", segments: [{ value: 4200, tone: "seg-time", label: "Time" }], highlight?: true }
props: { title: "Time per response", summary: "Average 3.1s, slowest 6.4s", format, height: 64 }
```

SVG, one column per turn, baseline only (no ticks), `<title>` tooltip "Response 3: 4.2s", slowest column in warning fill.

### 11.5 ShareBar (tokens by agent) `LIVE`

```ts
Share: { key: "main", label: "Main agent", value: 42000, tone: "tone-main" } | { key: "helpers", label: "Helpers", tone: "tone-0" }
```

Hover/focus a segment → tooltip "Main agent · 42k · 84%", others fade to .55, ←/→ cycle. Legend table: swatch · name · tokens · share %.

### 11.6 InsightsPanel (Insights tab) `LIVE`

```ts
kpis: [
  { label: "Average time",  value: "3.1s",  sub: "6 responses" },
  { label: "Slowest",       value: "6.4s",  sub: "Slowest 5% 6.1s" },
  { label: "Tokens",        value: "88k",   sub: "62% cached" | "12k from helpers" },
  { label: "Helpers",       value: "3",     sub: "2 finished" },          // only with helpers
  { label: "Personal data", value: "None" | 2, sub: "Pattern checks on sent text", warn: count > 0 },
]
```

Cards in order: KPI row · Tokens by agent (ShareBar + legend) · Time by agent (horizontal bars; note "Helpers run in parallel, so their times overlap.") · Main agent context (meter; "Only the main agent's context is shown.") · Time per response (ColumnChart) · Tokens per response (stacked: New input / Cached / Output) · Usage limits (one Meter per window, "62% used", "Resets in 2h 14m"; reached → "Usage limit reached. New requests may wait until it resets.") · Streaming details (collapsed; per turn 3-part bar first output / stream / finalize + "First output 0.8s · stream 2.9s · total 4.2s").

```ts
RateLimitView: { limitName, primaryUsedPercent: 62, primaryWindowMins: 300, primaryResetsAt, secondaryUsedPercent, secondaryWindowMins, secondaryResetsAt, reached: null | "primary" }
TurnTiming: { turnId, acceptMs, ttftMs: 800, streamMs: 2900, finalizeMs: 120, totalMs: 4200, deltaCount, maxGapMs, nonStreaming, status }
```

Empty: "No insights yet" / "Timing and usage for each response will appear here."

### 11.7 PrivacyCard + PrivacyNote `LIVE`

```ts
{ tone: "ok" | "warn", scannedChars: 18000,
  lines: ["2 email addresses in a tool output", "1 card number in your message"],   // masked samples only
  ok: "No personal data found in 18,000 characters." }
```

---

## 12. Auth, tenant and onboarding screens

| Screen | Key data | States |
|---|---|---|
| LoginScreen | `mode: "poc" \| "google"`, Google button | idle, redirecting, error ("Sign-in failed. Try again.") |
| SelectTenant | `memberships: [{ tenantId, name, role }]` | list, single (auto-skip), none |
| InviteJoin (`/invite/[token]`) | `{ tenantName, inviter, email, expiresAt }` + capabilities board | valid, expired, already member, wrong account |
| NameConfirm | `{ name: prefilled from Google }` | editing, saving, error; resumes until saved |
| ManageWorkspaces | memberships, switch, admin invite list | |
| SessionGate | `{ status: "loading" \| "signedIn" \| "signedOut" }` | spinner, redirect |

---

## 13. Primitives

| Component | Variants / keys | States |
|---|---|---|
| Button | `solid` (primary), `soft` (secondary), `ghost`, `danger`; sizes `sm`, default, `lg`; `icon-btn` 10px radius | rest, hover, pressed (scale), focus-visible ring, disabled, busy (spinner + label "Sending…") |
| Text button / link | `link`, `text-btn` | |
| Chip (`ag-chip`) | `is-running`, `is-done`, `is-stopped`, `is-warn` | optional spinner / ⚠ |
| Status pill (`goal-status`) | `s-running` (pulse), `s-paused`, `s-done`, `s-ended` | |
| Pulse dot | `live`, `idle` | 1.6s pulse |
| Spinner | 0.7s rotate | |
| StepMark | `done`, `current`, `pending` | |
| Progress bar | `value 0–100`, `label` | |
| Tile / icon tile | `sm`, `lg` (empty states) | |
| EmptyState | `{ icon, title, body, action? }` | |
| ErrorBanner | `{ message, ref?, action? }` | role=alert |
| Toast | `{ text: "Goal paused.", tone }` | auto-dismiss |
| Tabs | `{ items, active, badge }` | arrow-key nav |
| Field | label 12.5px, input, hint (mono 12px), error | |
| Select / Menu | | |
| Kbd | `⌘K` | |
| LiveDuration | `{ since \| until, trend: 1 \| -1 }` | ticks on shared 1s clock |
| Eyebrow | 11px mono uppercase .06em | |

---

## 14. Design tokens

Full values: `docs/truex-design-spec.html` and `docs/CHAT_UI_SCHEMA.md` §8. Summary:

| Group | Tokens (light → dark) |
|---|---|
| Surfaces | `--bg` #FFFFFF→#171717 · `--surface-3` #F6F9FA→#242424 · `--line` #E3ECEF→#2A2A2A · `--line-strong` #D8E0E4→#363636 |
| Ink | `--ink` #1F2A30→#EEF4F6 · `--ink-2` #5F6D73→#B7C3C8 · `--ink-3` #849198→#8B999F · `--ink-disabled` #B4BEC3 |
| Accent | `--accent` #3691CD · `--accent-2` #2A7DB4→#5AA8DC · `--accent-soft` #EAF5F8→#14283A · `--accent-soft-2` #BCDEE8→#1F4461 · `--accent-fg` #2A72A3→#BCDEE8 |
| Status | success #E7F4ED/#35624E · warning #FFF3D9/#7D5D1D · error #FBE7E7/#8D4545 · info #EAF5F8/#2A72A3 · neutral #F6F9FA/#5F6D73 |
| Helper tones | tone-0 #2872b8/#eef5fc · tone-1 #0f7a55/#e6f5ee · tone-2 #b84a1b/#fcece4 · tone-main #6b6b6b/#f0f0f0 |
| Chart segments | seg-new `--accent` · seg-cached `--accent-soft-2` · seg-output `--ink-2` · seg-reasoning `--ink-3` · seg-time `--accent-soft-2` |
| Agent tints | ice · mint · butter · peach · lilac (12 robot looks) |
| Type | Figtree (UI, 14px/1.5 base) · Newsreader italic (accent words) · JetBrains Mono (numbers, meta). Scale: 44/32/24/20/17/15/14/13/12.5/12/11.5/11/10.5 |
| Radius | 20 dock/dialog · 18 composer · 16 panels, bubbles · 14 popover · 12 cards · 10 icon buttons, inputs · 9 buttons, rows · 8 small · 999 pills |
| Shadow | sm panels · md composer · lg dock, popovers, dialogs |
| Motion | rise 6px (.16–.35s) · pulse 1.6s · spin .7s · caret blink 1s · panel width .32s cubic-bezier(.2,.8,.2,1). No motion beyond the spec. |
| Breakpoints | ≤900 panel overlay · ≤760 agent dialog one column · ≤720 full-bleed, sidebar drawer · ≤520 request buttons stack |
| Layout | thread max 740px · message gap 22px · topbar 56px · sidebar 268px · panel 360px |

---

## 15. Stream event → component map

| Event | Payload keys | Component |
|---|---|---|
| `snapshot` / `run.snapshot` (v1) | full state | rebuilds everything |
| `run.accepted` (v1) | `runId` | UserMessage → accepted |
| `turn.started` | `turnId` | Turn group, live header "Working", Stop button |
| `message.delta` / `text.delta` (v1) | `delta`, `messageIndex` | AssistantMessage streaming |
| `message.final` | `text` | AssistantMessage complete |
| `reasoning.delta` | `delta`, `method` | ThinkingBlock |
| `activity.updated` | `label` | ActivityLine, Activity tab row |
| `plan.updated` | `plan`, `explanation` | PlanSteps, Plan tab badge |
| `goal.updated` / `goal.cleared` | `goal` | GoalBar, Goal tab |
| `approval.requested` | `PendingRequest` | PlanApprovalCard / ToolApprovalCard / QuestionCard |
| `approval.resolved` | `requestId`, `audit` | ApprovalRecord |
| `subagent.spawned` / `.status` / `.completed` | `agent`, `label` | HelperGroup, Agents tab, AgentsTimeline |
| `subagent.event` | `kind`, `delta`, `text` | Helper preview / transcript |
| `usage.updated` | `usage` | LiveUsage, context meter |
| `limits.updated` | `rateLimits` | Usage limits meter |
| `error` | `reason`, `message`, `willRetry` | "Retrying…" or TurnError |
| `turn.completed` / `run.completed` (v1) | `turn.status`, `timing`, `trace` | TurnReceipt, Activity row, Insights |
| `stream.error` | `code` | Disconnected banner |
| `mcpToolCall` item (`PROTO`) | `server`, `tool`, `status`, `result`, `error` | ToolCallCard |
| `webSearch` item (`PROTO`) | `action` | WebSearchCard |
| `contextCompaction` item (`PROTO`) | | CompactionDivider |
| `mcpServer/elicitation/request` (`PROTO`) | `mode`, `message`, `requestedSchema` / `url` | McpElicitationCard |
| `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed` (`PROTO`) | connection and sign-in status | MCP status dot, Sign in button |
