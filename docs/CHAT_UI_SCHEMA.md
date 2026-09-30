# TrueX Chat Interface: UI Schema Reference

A single reference for redesigning the chat UI and UX. It documents every component in `frontend/`: its props, state, data types, visual states, interactions and styles. It also covers the API and streaming contracts and the design tokens underneath. Types are quoted from the source (`shared/contracts.ts`, `frontend/lib/*`, `platform/src/*`). Generated 2026-10-01 from branch `feat/auth-mcp-backend`, including its uncommitted changes.

## Contents

1. App Shell & Layout: page layout tree, app state in `page.tsx`, sidebar, topbar, hero, dock, popovers, search palette, sheets, keyboard shortcuts
2. Composer & Input: composer, textarea, slash commands, approval modes, budget field, suggestions, helper chip, quick tools
3. Message Stream & Items: message and entry data model, event-to-entry pipeline, thinking, command results, approvals, request cards, plan steps, visualizations, documents, errors, activity panel
4. Goals: goal statuses and state diagram, GoalBar, GoalReason, GoalCompletion, GoalTimeline, budgets, error text
5. Agents, Subagents, Tools & MCP: agent model, robot looks and tints, New agent dialog, agent menu, helpers panel, delegation settings, MCP settings
6. Observability & Insights: traces, steps, token usage, receipts, charts, insights panel, privacy cards, developer mode
7. Data Contracts, API & Streaming: every endpoint, the event stream and its 19 event types, entity types, auth and access matrix, feature flags, enums, entity relationships
8. Design Tokens, Styles & Responsive: colours (light and dark), type, radii, shadows, z-index, motion, breakpoints, class inventory, legacy vs v2 CSS, icons, accessibility, spec gaps

A few components appear in two sections because they belong to both. For example, HelperChip is in sections 2 and 5, and the goal composer mode is in sections 2 and 4. Each section's own notes cover its details.

## Redesign gaps found in the code

These are gaps across the whole UI. Each section's final notes have more.

What's missing or not surfaced:
- Messages have no copy, retry or edit actions, and code blocks have no syntax highlighting or copy button (3.18).
- `RuntimeItem` is never mounted, so tool calls never appear in the conversation (3.6).
- Approval and question cards always render below the whole conversation. Failed turns show only in the bottom error banner and the activity timeline (3.7, 3.13).
- The composer has no attachment, model or agent picker. Upload lives in the Tools panel, the model is set via `/model` or QuickTools, and the agent is picked in the dock popover (2.16).
- Only the owner can write to a chat, and others see it read-only. There is no read-only chat design yet (7.4).
- MCP servers have no live status, no sign-in-required state and no user vs tenant badge. The MCP UI also has no edit or delete, although those API endpoints exist (5.14).
- Agents have no edit, delete or "All agents" view, and the platform has no endpoints for them (5.17).
- There is no cost or currency data, and no token counts per helper or per step (6).
- UserMenu always shows "Account" and has no sign-out. Share does nothing. The sidebar has no empty state (1).

What's broken or dead:
- HelperChip "View" looks for `.helper-group`, but the rendered class is `.hcard`, so it always falls back to opening the agents panel (2.16).
- These components exist but are never rendered: `ProjectSidebar`, `ui/select`, `ConnectedTools`, `Capabilities` and the "tools" Sheet (1, 5.15, 5.16).
- `app/observability.css` is effectively empty. Tailwind is installed, but nothing uses it (8.12).
- The `s-ended` goal pill tone is defined, but no status produces it (4).

About the styles:
- Legacy `app/*.css` and v2 `styles/v2/*.css` are both live, and v2 wins where class names clash. Sheets, MCP settings, visualizations, documents and the project sidebar are styled only by legacy CSS (8.12).
- There are no spacing, z-index or motion tokens. Section 8 lists the raw values in use so they can become tokens.
- 11 legacy files use lucide-react icons with stroke 2, while v2 uses its own icons with stroke 1.75 (8.13).
- Small `--ink-3` text and white text on `#3691CD` are likely below WCAG AA. This is estimated, not measured (8.14).

About the backend contract:
- `fetch` and `EventSource` don't send credentials. Google cookie sessions will break if the frontend and API run on different origins (7.1, 7.5).

---



## 1. App Shell & Layout

Source root: `/Users/ashok/truex-plan/frontend`. All types below are quoted from source (`shared/contracts.ts` = `/Users/ashok/truex-plan/shared/contracts.ts`).

Styles: `app/globals.css` imports, in order: `tailwindcss`, legacy `app/shell.css`, `app/chat.css`, `app/panels.css`, `app/observability.css`, `app/responsive.css`, then v2 `styles/v2/tokens.css`, `base.css`, `shell.css`, `dock.css`, `chat.css`, `session.css`, `agent-dialog.css`. v2 rules override legacy ones (the v2 shell.css header says legacy `.sidebar`, `.topbar`, `.brand`, `.muted`, `.eyebrow` still leak and are reset explicitly).

Design tokens (styles/v2/tokens.css): `--bg --surface --surface-2 --surface-3 --ink --ink-2 --ink-3 --ink-disabled --line --line-strong --accent --accent-2 --accent-fg --accent-hover --accent-pressed --accent-ink --accent-text --accent-soft --accent-soft-2 --on-accent --brand-50…700 --signature --glow-1 --glow-2 --radius --shadow-sm/md/lg --font-sans --font-display --font-accent --font-mono --display-weight --display-track --accent-scale --accent-style --accent-weight --border-control --error-bg/text --warning-bg/text --success-bg/text --info-bg/text --neutral-bg/text --warn`, plus `--tone-0/1/2/main(-soft)`. Dark theme under `@media (prefers-color-scheme: dark)` and `[data-theme]`; reduced-motion block present.

Fonts (layout.tsx, Google Fonts link): Figtree 400–800, Newsreader italic 400–500, JetBrains Mono 400/500, Caveat 600/700.

---

### Page layout tree

```
<html lang="en" data-theme?>                     app/layout.tsx (THEME_BOOT_SCRIPT in <head>)
└─ <body>
   └─ Home (app/page.tsx)
      └─ Shell  div.shell.layout-main[.is-ready]
         ├─ Panel kind="sidebar" (aside.panel.sidebar[.is-open], label "Conversations")
         │   └─ Sidebar
         │       ├─ .brand  (Icon spark + "truex / agents")
         │       ├─ button.search-trigger  (Search ⌘K)
         │       ├─ button.btn-new         (New conversation ⌘J)
         │       ├─ nav.side-nav → button.side-link "Agents"
         │       ├─ .side-scroll
         │       │   ├─ p.side-error (+ Retry)       [sessionsFailed]
         │       │   └─ .side-group ×2 ("Today", "Earlier")
         │       │       └─ .convo-row → button.convo + span.convo-menu → SessionMenu (project-sidebar.tsx)
         │       └─ button.side-link.side-foot "Settings"
         ├─ main.stage
         │   ├─ Topbar (header.topbar: .crumb | button.status-pill | .top-actions)
         │   ├─ div.scroll[role=log]
         │   │   ├─ [empty]   Hero → composerForm (Composer + SmoothTextarea) + "No agents" note
         │   │   └─ [!empty]  div.thread → ChatMessages + RequestCard × pending
         │   └─ div.bottom
         │       ├─ div.error-banner[role=alert] (message + ErrorRef + ×)   [error]
         │       ├─ GoalBar                                                [session && goal]
         │       ├─ HelperChip                                             [!empty]
         │       ├─ composerForm                                           [!empty]
         │       └─ div.dock-wrap
         │           ├─ Popover.pop-agent → AgentMenu                      [pop === "agent"]
         │           ├─ Popover.pop-user  → UserMenu                       [pop === "user"]
         │           └─ FloatingDock (6 items, groups [3,5])
         ├─ p.sr-only[role=status aria-live=polite]  (follow.announce)
         ├─ Panel kind="activity" (aside.panel.activity[.is-open][.is-overlay], --pw, label "Session activity")
         │   └─ SessionActivity
         ├─ SearchPalette           (div.scrim > div.palette, fixed, z 50)
         ├─ AgentDialog
         ├─ Sheet "Capabilities, documents & visuals" → AssistantTools   [panel === "tools"]
         └─ Sheet "Connected tools" → McpSettings | "Select an agent…"   [panel === "mcp"]
```

Components out of this slice but rendered by the shell: Composer, AgentMenu, AgentDialog (components/v2), ChatMessages, RequestCard, GoalBar, HelperChip, SessionActivity, AssistantTools, McpSettings, ApprovalModePicker, BudgetField, SmoothTextarea, PrivacyNote, ErrorRef.

Frame dimensions (styles/v2/shell.css): `.shell` flex row, padding 10px, gap 10px, height 100%. Sidebar panel open width 268px (inner padding 14px 12px, gap 6px). Activity panel width `var(--pw, 360px)` (360 min / 560 max). `.stage` flex 1, `--surface-2` bg, 1px `--line` border, `--radius`. `.panel-inner` `--surface`, border, `--shadow-sm`. Panel open/close transition: width .32s cubic-bezier(.2,.8,.2,1), opacity .2s; disabled until `.shell.is-ready`.

Responsive breakpoints:
- ≤900px: activity panel becomes fixed drawer (right/top/bottom 10px, z 30, `--shadow-lg`). Crossing from >900 to ≤900 closes both panels (page.tsx resize handler). Follow-activity never auto-opens the panel.
- ≤720px: shell padding 0; stage no border/radius; sidebar fixed left drawer (z 30, radius `0 16px 16px 0`); activity full height, width `min(--pw, 100vw)`; `.bottom` padding `0 16px 12px`; topbar columns `auto 1fr auto`, `.crumb` hidden, status pill in column 1. fitPanel allows only one drawer at a time.
- `(hover: none)`: conversation row menu always visible, time hidden.

---

### App-level state in `Home` (app/page.tsx)

Data / session state:

| State | Type | Initial | Controls |
|---|---|---|---|
| agents | `AgentSummary[]` | `[]` | Agent menu list, agent dialog, topbar name |
| agentId | `string` | `""` | Selected agent (first on load, or session's agent) |
| sessions | `Session[]` (`PublicSession`) | `[]` | Sidebar list + search palette items |
| session | `Session \| null` | `null` | Open conversation; `null` = draft |
| approvalModes | `ApprovalModesConfig` | `approvalModesOff` | Approval mode picker availability |
| draftMode | `ApprovalMode \| null` | `null` | Mode chosen before session exists |
| modeError | `string` | `""` | `.composer-notice.approval-mode-error` |
| entries | `Entry[]` | `[]` | Transcript (ChatMessages) |
| events | `DomainEvent[]` | `[]` | Activity feed (last 100 of selected types) |
| pending | `PendingRequest[]` | `[]` | RequestCards; approval badge |
| plan | `PlanStep[]` | `[]` | Plan tab, RequestCard |
| timings | `TurnTiming[]` | `[]` | Activity timings |
| observability | `ObservabilityState` | `emptyObservability` | Traces, live usage, rate limits |
| traceSummary | `TraceSummary \| null` | `null` | Activity panel |
| text | `string` | `""` | Composer value |
| error / errorDetail | `string` / `ErrorRef \| null` | `""` / `null` | `.error-banner` |
| notice | `string` | `""` | `.composer-notice` |
| commandOpen / commandIndex | `boolean` / `number` | `false` / `0` | Slash-command menu `.slash-menu` |
| loading | `boolean` | `true` | Topbar "Loading agents…" |
| busy | `boolean` | `false` | Disables sidebar rows, new chat, composer |
| running | `boolean` | `false` | Turn in progress: pulse, stop button, dock badge |
| status | `string` | `"Not connected"` | Stream status: "Reconnecting" / "Disconnected" / … |
| streamKey | `number` | `0` | Bumped by Reconnect to resubscribe |
| slowReconnect | `boolean` | `false` | After 30s reconnecting: "still reconnecting…" |
| retrying | `boolean` | `false` | "retrying…" state text |
| sessionsFailed | `boolean` | `false` | Sidebar "Couldn't refresh · Retry" |
| health | `any` | `null` | `/healthz` result (fetched, not rendered) |
| panel | `"mcp" \| "tools" \| "agents" \| null` | `null` | Which Sheet is open (no caller sets `"tools"` or `"agents"` in page.tsx; the tools sheet is currently unreachable from the shell) |
| inspectorTab | `string` | `"activity"` | Activity panel tab |
| subAgents | `SubAgentState` | `emptySubAgents` | Helper agents |
| delegation | `DelegationPrefs` | `defaultDelegation` | Helper prefs (localStorage) |
| mcpVersion | `number` | `0` | Bumped on MCP save (not otherwise read) |
| goal / goalReview | `Goal \| null` / `GoalReview \| null` | `null` | GoalBar, state text |
| documents | `ConversationFile[]` | `[]` | Loaded when goal awaits review |
| failure | `TurnFailure \| null` | `null` | Last turn failure |
| goalMode | `boolean` | `false` | Composer in goal mode |
| goalBudget / goalBudgetValid | `number \| null` / `boolean` | `null` / `true` | BudgetField |
| draftProjectId | `string \| null` | `null` | Project a new chat is created in (`.composer-project` chip) |

Layout / UI state:

| State | Type | Initial | Controls |
|---|---|---|---|
| panels | `{ sidebar: boolean; activity: boolean }` | both `false` | Requested panel visibility |
| panelSizes | `Record<"list" \| "detail", PanelSize>` | `{ list: "min", detail: "max" }` | Activity width per mode; `detail` = agents tab with a helper open |
| helperOpen | `boolean` | `false` | Agents tab detail view open |
| vw | `number` | `1440` (then `innerWidth`) | Fit calculations |
| paletteOpen | `boolean` | `false` | SearchPalette |
| pop | `null \| "agent" \| "user"` | `null` | Dock popovers |
| agentDialogOpen | `boolean` | `false` | AgentDialog |
| composerFocused | `boolean` | `false` | Pauses rotating hero placeholder |
| shellReady | `boolean` | `false` | Adds `.is-ready` after first rAF (enables transitions) |

Refs: `agentBtn`, `userBtn` (dock buttons, popover ignoreRef), `scroll` (`.scroll`), `composer` (textarea; autosize to max 240px), `following` (auto-scroll when within 80px of bottom), `generation` (latest-request token), `sessionRef`, `seen` (event cursor dedupe, cap 2000), `sending`, `commandAttempt`, `draftModeRef`, `suggesting`.

Derived values:
- `empty = !session && !entries.length` → Hero vs thread; composer inside Hero vs `.bottom`.
- `fit = fitPanel(vw, PANEL_W[panelSize], CHAT_MIN[panelSize], panels.sidebar, panels.activity)`; `sidebarShown = panels.sidebar && fit.sidebar`.
- `crumbTitle`: session title from list → session.title → "Untitled conversation"; draft with entries → "New conversation"; else `""`.
- `stateText` (status pill), in priority order: "still reconnecting…" / "reconnecting…" / "disconnected" / "retrying…" / "working on goal" / "working" / "ready".
- Topbar agent name: "Loading agents…" while loading, else agent name or "No agent".
- Composer placeholder: goal mode "Describe the outcome you want. The assistant works until it’s done."; running "Add a thought to steer the current turn…"; empty → rotating placeholder; else `PLACEHOLDERS[0]`.

Key handlers: `open(id)` (load session, sets `?session=id` in URL), `startDraft(projectId?)` (reset to new chat), `newChat()` (startDraft unless busy), `toggleSidebar()` (opening sidebar shrinks activity panel to min if that fits, else closes it), `toggleActivity()` (closing calls `follow.dismiss()`), `togglePop(next)`, `stopTurn()` (pauses active goal then interrupts), `openAgents(threadId?)` (activity panel → agents tab, scroll to `#agent-card-{id}`).

On mount: health check, `GET /api/agents`, `GET /api/sessions`, `loadApprovalModes()`, `loadDelegation()`, and opens `?session=` if present.

---

### Keyboard shortcuts

Global (`useHotkeys` in page.tsx; fire even while typing; Shift/Alt ignored; `mod` = ⌘ or Ctrl):

| Combo | Action | Shown on |
|---|---|---|
| mod+K | Toggle search palette | Sidebar search trigger, dock tooltip |
| mod+B | Toggle sidebar | Dock tooltip |
| mod+. | Toggle activity panel | Dock tooltip |
| mod+J | New chat (ignored when busy) | Sidebar New button, dock tooltip |

Local:
- Search palette: Esc close, ↑/↓ move, Enter open, mouse hover sets active.
- Popover: Esc or outside mousedown closes.
- Composer textarea: Enter send, Shift+Enter newline, Esc exits goal mode / closes slash menu, ↑/↓ cycle slash commands (wraps), Tab accepts command. IME composition ignored.
- Project/session menu (project-sidebar Menu): ↓ on trigger opens, ↑/↓/Home/End move, Esc closes and refocuses trigger, Tab closes.
- NameInput: Enter submit, Esc cancel, blur cancels.
- Sheet: Esc via native `<dialog>`.

---

### RootLayout

- File: `app/layout.tsx`. Purpose: HTML document, theme boot script, font links. Parent: Next.js root.
- Props: `{ children: React.ReactNode }` (required).
- Metadata: title "Truex · Agent workspace", description "A workspace for conversations with your agents".
- `<html lang="en" suppressHydrationWarning>`; `<script>` = `THEME_BOOT_SCRIPT` sets `data-theme` before paint.
- State: none. CSS: `./globals.css`.

### ErrorPage

- File: `app/error.tsx`. Purpose: route-level error boundary. Parent: Next.js (below root layout).
- Props:
  ```ts
  { error: Error & { digest?: string }; retry?: () => void; reset?: () => void }
  ```
- State: none. Effect logs `[truex] page error`.
- Renders `main.app-error > div.app-error-card[role=alert]`: h1 "Something went wrong", body copy, `p.app-error-ref` "Reference: {digest}" when digest exists, `button.button.button-primary` "Try again" (retry ?? reset ?? `location.reload()`).
- CSS: `.app-error`, `.app-error-card` (app/shell.css:752+), `.button`, `.button-primary`.

### GlobalError

- File: `app/global-error.tsx`. Purpose: last-resort boundary replacing the root layout; renders own `<html><body>`. Imports `./globals.css`.
- Props: same as ErrorPage.
- Copy: h1 "Truex couldn’t load", "Something went wrong while starting the workspace. Try again, or refresh the page." Same card/button structure. Logs `[truex] app error`. Note: no theme boot script or fonts here.

### NotFound

- File: `app/not-found.tsx`. Props: none. `main.app-error > div.app-error-card` (no role), h1 "Page not found", "This page doesn’t exist or has moved.", `a.button.button-primary[href="/"]` "Go to the workspace".

### Home

- File: `app/page.tsx` (default export, `"use client"`). Purpose: the entire workspace; owns all app state (see above). Parent: RootLayout. Props: none.

### Shell

- File: `components/v2/shell.tsx`. Purpose: page frame, flex row of sidebar, stage, activity panel. Parent: Home.
- Props:
  ```ts
  { children: ReactNode; className?: string }
  ```
- Renders `div.shell.layout-main{.className}`. Home passes `"is-ready"` once `shellReady`.
- State: none. CSS: `.shell` (styles/v2/shell.css); `.layout-main` legacy.

### Panel

- File: `components/v2/shell.tsx`. Purpose: clip-reveal side panel (outer animates width/opacity; inner keeps fixed width). Parent: Shell (two instances).
- Props:
  ```ts
  {
    kind: "sidebar" | "activity";
    open: boolean;
    /** Activity only: floats as a fixed drawer (fitPanel overlay). */
    overlay?: boolean;        // default false
    /** Activity only: px width, set inline as --pw. */
    width?: number;
    label?: string;           // aria-label
    className?: string;
    innerClassName?: string;
    children: ReactNode;
  }
  ```
- Output: `aside.panel.{kind}[.is-open][.is-overlay]` with `style="--pw: {width}px"`, `aria-hidden` and `inert` when closed, `div.panel-inner` inside.
- Visual states: closed (width 0, opacity 0), open, overlay (fixed right drawer, `--shadow-lg`), pre-ready (no transition; at ≤900 forced closed).
- State: none.

### Sidebar

- File: `components/v2/sidebar.tsx`. Purpose: left nav with brand, search, new chat, Agents link, grouped conversation list, Settings. Fetches nothing. Parent: Panel kind="sidebar".
- Data type:
  ```ts
  export interface SidebarSession {
    _id: string;
    title?: string;
    createdAt: string;
  }
  ```
  Home passes `PublicSession[]` (see Data types).
- Props (generic `S extends SidebarSession`):
  ```ts
  {
    sessions: S[];
    activeId?: string | null;
    onOpen: (id: string) => void;
    onNew: () => void;
    /** Opens the search palette. */
    onSearch: () => void;
    /** Agents nav link is the active view. */
    agentsActive?: boolean;          // default false
    onAgents?: () => void;
    onSettings?: () => void;
    /** Hover/focus-revealed affordance at the row's right (e.g. SessionMenu). */
    renderRowMenu?: (session: S) => ReactNode;
    /** Shows an inline error line with Retry. */
    loadError?: string | null;
    onRetry?: () => void;
    /** Disables row, new and nav buttons while a turn is running. */
    busy?: boolean;                  // default false
  }
  ```
  Note: `busy` disables `.btn-new` and `.convo` rows only; the Agents and Settings links are not disabled despite the comment.
- Home wiring: `onAgents` → opens agent popover (`setPop("agent")`), `onSettings` → `setPanel("mcp")`, `loadError` = "Couldn’t refresh" when `sessionsFailed`, `agentsActive` never passed (always false), `renderRowMenu` → `SessionMenu`.
- Helpers exported:
  - `convoGroup(createdAt, now = new Date()): "Today" | "Earlier"` (local calendar day).
  - `convoTime(createdAt, now = new Date()): string`: "h:mm AM/PM" today, short weekday within 7 days, else "Sep 3"; `""` for invalid date.
- State: none (computes `now` on each render).
- Structure & classes:
  - `.brand` > `span.brand-mark` (24×24 ink tile, Icon spark 14/2), `span.brand-word` "truex", `span.brand-slash` "/", `span.brand-sub` "agents".
  - `button.search-trigger` (34px; Icon search 15, `span.search-label` "Search", `kbd` "⌘K").
  - `button.btn-new` (36px, ink background; Icon plus 16/2, "New conversation", `kbd` "⌘J").
  - `nav.side-nav[aria-label=Main]` > `button.side-link[.is-active]` Icon bot "Agents" (`aria-current="page"` when active).
  - `div.side-scroll` > optional `p.side-error[role=alert]` "{loadError} · " + `button.side-retry` "Retry"; `div.side-group` per non-empty group with `div.eyebrow` label; rows `div.convo-row[.is-active][.has-menu]` > `button.convo[.is-active]` (`span.convo-title` ellipsized, fallback "New conversation"; `span.convo-time` mono 11px) + `span.convo-menu` (menu).
  - `button.side-link.side-foot` Icon gear "Settings".
- Visual states: row hover (`--surface-2`), active (`--accent-soft`, `aria-current="true"`), disabled (busy), menu reveal on hover/focus/expanded (time hidden), empty (no groups render; no empty-state message), error line.
- Children: Icon.

### Topbar

- File: `components/v2/topbar.tsx`. Purpose: 56px stage header, grid `[crumb 1fr][status pill auto][actions 1fr]`. Parent: `main.stage`.
- Props:
  ```ts
  {
    /** When false the "truex" wordmark shows in the crumb. */
    sidebarShown: boolean;
    /** Crumb title; empty hides the slash too. */
    title?: string | null;
    agentName: string;
    /** e.g. "ready" | "working" | "working on goal" | "reconnecting…" */
    stateText: string;
    /** Animates the pulse; idle when false. */
    busy: boolean;
    onStatusClick?: () => void;
    /** Extra icon buttons rendered before the theme toggle. */
    actions?: ReactNode;
    isDark: boolean;
    onToggleTheme: () => void;
  }
  ```
- Structure: `header.topbar` > `div.crumb` (`span.brand-word.sm` "truex" when sidebar hidden; `span.muted` "/" + `span.crumb-title` when title) · `button.status-pill` (title "Edit {agentName}"; `span.pulse[.idle]`, agent name, "·", `span.muted` state) · `div.top-actions` (actions, theme `button.icon-btn` sun/moon with aria-label "Switch to light/dark theme", Share `button.icon-btn` placeholder with no-op onClick).
- Home wiring: `busy = running`; `onStatusClick` opens agent popover; `actions` = `button.text-btn` "Reconnect" when session and status "Disconnected" (sets Reconnecting, bumps streamKey).
- Visual states: pulse animating vs idle; crumb wordmark vs title; ≤720 crumb hidden.
- State: none. Children: Icon. CSS: `.stage .topbar`, `.crumb`, `.crumb-title`, `.top-actions` (v2 shell.css); `.status-pill`, `.pulse`, `.icon-btn`, `.text-btn`, `.muted` (v2 base.css).

### Hero

- File: `components/v2/hero.tsx`. Purpose: empty-state greeting with composer. Parent: `.scroll` when `empty`.
- Props:
  ```ts
  {
    /** Agent color for the greeting dot (spec default #BCDEE8). */
    agentHue?: string;          // default "#BCDEE8"
    /** Appended as ", {name}" when given. */
    name?: string | null;
    /** Composer, rendered inside .hero-composer. */
    children?: ReactNode;
  }
  ```
  Home passes only `children` (no agentHue, no name).
- State: `mounted` (boolean) so greeting is computed client-only; renders `&nbsp;` before mount.
- Helper: `greetingFor(hour)`: <5 "Working late", <12 "Good morning", <18 "Good afternoon", else "Good evening".
- Structure: `div.hero` > `div.hero-greet` (`span.agent-dot` inline bg + greeting) · `h1` "What should we <em>work on</em> today?" · `div.hero-composer` (children). Home also renders "No agents are available. Contact your Truex administrator." (`p.muted.sm`) when loaded with zero agents.
- CSS: `.hero` (max 760, centered, `rise` animation), `.hero-greet` pill, `.hero h1` (display font, clamp 28–44px), `.hero h1 em` (accent font), `.hero-composer` (margin-top 28, textarea min 76px).

### FloatingDock

- File: `components/v2/floating-dock.tsx`. Purpose: macOS-style magnifying dock of workspace actions. Parent: `div.dock-wrap` in `.bottom`.
- Types:
  ```ts
  export type DockIconName = "sidebar" | "search" | "plus" | "bot" | "activity" | "user"; // keyof typeof DOCK_ICONS

  export type DockItem = {
    id: string;
    label: string;
    icon: DockIconName;
    kbd?: string;
    /** Toggle state. Leave undefined for plain actions (no aria-pressed, never active). */
    active?: boolean;
    badge?: boolean;
    onClick: () => void;
    /** Forwarded to the <button>, e.g. so a Popover can ignore clicks on its toggle. */
    buttonRef?: Ref<HTMLButtonElement>;
  };

  export type FloatingDockProps = {
    items: DockItem[];
    /** Item indexes that start a new group; a separator renders before each (spec: [3, 5]). */
    groups?: number[];   // default []
  };
  ```
- State: `sizes: number[] | null` (per-button px size, null = all BASE); refs `buttons` (button elements); memo `reduceMotion` (read once on mount; disables magnification).
- Magnification: BASE 40, PEAK 60, REACH 140px, cos² falloff by distance from cursor to button center; icon scale 0.9 → 1.25. Reset on mouse leave.
- Structure: `nav.dock[aria-label=Workspace]` > per item optional `span.dock-sep` + `DockButton`.
- Items passed by Home (groups `[3, 5]` → separators before Agent and Account):

  | id | label | icon | kbd | active | badge | onClick |
  |---|---|---|---|---|---|---|
  | sidebar | Sidebar | sidebar | ⌘B | `sidebarShown` | – | toggleSidebar |
  | search | Search | search | ⌘K | – | – | open palette |
  | new | New chat | plus | ⌘J | – | – | newChat |
  | agent | Agent | bot | – | `pop === "agent"` | – | togglePop("agent"), ref agentBtn |
  | activity | Activity | activity | ⌘. | `panels.activity` | `running && !panels.activity` | toggleActivity |
  | user | Account | user | – | `pop === "user"` | – | togglePop("user"), ref userBtn |

- CSS (styles/v2/dock.css): `.dock` (56px, radius 20, translucent surface + blur 14px, `--shadow-lg`), `.dock-sep`, `.dock-btn[.is-active]` (circle, `--surface-3`; active = `--accent`), `.dock-icon`, `.dock-pip` (4px dot below active), `.dock-badge` (9px `--accent-2` dot, `pulse` animation), `.dock-tip` (ink tooltip above, shown on hover/focus-visible, with `kbd`).

### DockButton (internal)

- File: `components/v2/floating-dock.tsx` (not exported). Parent: FloatingDock.
- Props: `{ item: DockItem; size: number; register: (el: HTMLButtonElement | null) => void }`.
- Renders `button.dock-btn[.is-active]` with inline width/height = size, `aria-label`, `aria-pressed` only for toggles, inline 18px SVG (stroke 1.75), pip when active, badge when `badge`, `span.dock-tip[role=tooltip]` label + kbd. State: none.

### Popover

- File: `components/v2/popover.tsx`. Purpose: anchored dialog above the dock. Parent: `.dock-wrap` (two instances).
- Props:
  ```ts
  export type PopoverProps = {
    open: boolean;
    onClose: () => void;
    /** Placement class, e.g. "pop-agent" or "pop-user". */
    className?: string;
    children: ReactNode;
    ignoreRef?: RefObject<HTMLElement | null>;
    "aria-label"?: string;
  };
  ```
- State: refs `ref` (root), `closeRef` (latest onClose). Renders nothing when closed.
- Behavior: document mousedown outside (and outside `ignoreRef`) closes; window Escape closes. No focus management.
- Output: `div.popover{.className}[role=dialog]`.
- Instances: `pop-agent` (centered, 280px, aria "Choose agent", child AgentMenu with `agents.map(a => ({ id, name, description, hue: tintOf(a.tint).dot }))`, `currentId`, `onPick` sets agentId and closes, `onNew` opens AgentDialog); `pop-user` (right-aligned, 300px, aria "Account", child UserMenu with `onSettings` → mcp sheet).
- CSS: `.popover` (absolute, bottom 100%+12px, z 20, radius 14, `rise`), `.pop-agent`, `.pop-user`, plus overrides of legacy `.menu`/`.menu-item`.

### UserMenu

- File: `components/v2/user-menu.tsx`. Purpose: account menu (user card, theme toggle, settings, sign out). Parent: Popover `.pop-user`.
- Props:
  ```ts
  export type UserMenuProps = {
    name?: string;
    email?: string;
    onSettings?: () => void;
    onSignOut?: () => void;
  };
  ```
  Home passes only `onSettings`, so the card shows the "Account" fallback and there is no Sign out item.
- State: none; uses `useTheme()` (`isDark`, `toggle`).
- Structure: `div.menu` > `div.user-card` (`span.avatar` initial of name/email or Icon user; name `span.strong.block` + email `span.muted.sm`, or `span.grow.strong` "Account") · `div.menu-sep` · `button.menu-item` theme ("Light mode"/"Dark mode", sun/moon) · separator if any action · `button.menu-item` "Settings" (gear) · `button.menu-item` "Sign out" (logout).
- CSS: `.user-card`, `.avatar` (34px ink circle) in dock.css; `.menu`, `.menu-item`, `.menu-sep` in base.css.

### SearchPalette

- File: `components/v2/search-palette.tsx`. Purpose: ⌘K modal to find and open conversations by title. Parent: Shell (sibling of panels).
- Types / props:
  ```ts
  export interface SearchItem {
    id: string;
    title: string;
    time: string;
  }
  {
    open: boolean;
    onClose: () => void;
    items: SearchItem[];
    /** Called with the chosen id; the palette closes itself afterwards. */
    onPick: (id: string) => void;
  }
  ```
  Home maps sessions → `{ id: s._id, title: s.title || "New conversation", time: convoTime(s.createdAt) }`, `onPick` → `open(id)`.
- State: `q` (query), `index` (highlighted result), ref `input` (focused 10ms after open), `listId` (useId). Reset on each open. Returns null when closed.
- Filtering: case-insensitive substring on title. No recency sort beyond input order, no result limit.
- Structure: `div.scrim` (mousedown closes) > `div.palette[role=dialog aria-modal]` > `div.palette-input` (Icon search 16, `input[role=combobox]` placeholder "Search conversations…", `kbd` "esc") · `div.palette-list[role=listbox]` > `div.menu-item[.is-active][role=option]` (Icon doc 15, `span.grow` title, `span.muted.sm.mono` time) or empty state `div.muted.sm.pad` "No matches for “{q}”".
- Keyboard: Esc, ↑/↓, Enter. Hover sets active; click picks.
- CSS: `.scrim` (fixed, z 50, top padding 14vh, ink 18% tint + blur 2px, `fade`), `.palette` (max 540, radius 16, `--shadow-lg`, `rise`), `.palette-input` (52px), `.palette-list` (max-height 320).

### Icon

- File: `components/v2/icon.tsx`. Purpose: single-path stroked 24×24 SVG icon set from the design spec. Used across v2 components.
- Props:
  ```ts
  {
    name: IconName;
    size?: number;     // default 18
    stroke?: number;   // default 1.75
    className?: string;
  }
  ```
- `IconName` = `"sidebar" | "activity" | "user" | "bot" | "plus" | "search" | "home" | "folder" | "book" | "gear" | "arrowUp" | "paperclip" | "globe" | "at" | "mic" | "check" | "chart" | "table" | "doc" | "sun" | "moon" | "share" | "chevron" | "chevronR" | "chevronL" | "upDown" | "x" | "pulse" | "expand" | "shrink" | "spark" | "stop" | "target" | "plug" | "pause" | "play" | "pencil" | "lock" | "grid" | "logout"`.
- Always `aria-hidden`, `stroke="currentColor"`, round caps/joins. State: none. Note: the dock uses its own inline glyph set (`DOCK_ICONS`), not Icon.

### Sheet

- File: `components/sheet.tsx`. Purpose: right slide-over on native `<dialog>` (browser focus trap, Esc, focus restore). Parent: Shell (two instances).
- Props:
  ```ts
  {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    children: React.ReactNode;
  }
  ```
- State: ref `ref` (dialog; `showModal()`/`close()` synced to `open`), `titleId` (useId).
- Behavior: backdrop click (target is the dialog itself) closes; native close event calls onClose. Children render only while open.
- Structure: `dialog.sheet[aria-labelledby]` > `div.sheet-inner` > `header.sheet-head` (h2 title, optional p description, `button.icon-button` lucide `X` 16, aria "Close {title}") · `div.sheet-body`.
- Instances: "Capabilities, documents & visuals" / "Start from a capability, or work with this conversation’s files." → AssistantTools; "Connected tools" / "MCP servers attached to {agent name | this agent}. Changes apply to new chats." → McpSettings, or `p.muted` "Select an agent to manage its tools." when no agentId.
- CSS: legacy `app/panels.css` `.sheet`, `.sheet[open]`, `.sheet::backdrop`, `.sheet-inner`, `.sheet-head`, `.sheet-body`; `.icon-button` in app/shell.css.

### ProjectSidebar / SessionMenu / useProjects

File: `components/project-sidebar.tsx`. Page.tsx imports only `SessionMenu` and `useProjects`; the `ProjectSidebar` section component is exported but not rendered anywhere in the current app (no `<ProjectSidebar` usage found), so project folders are not visible in the v2 sidebar. Project assignment is reachable only through each row's "⋯" menu. The draft-in-project chip (`.composer-project`, "New chat in {name}" + × button) exists in page.tsx but `draftProjectId` is only set by ProjectSidebar's `onNewChat`, which is not mounted.

Data type:
```ts
// shared/contracts.ts
export interface Project {
  _id: string; // "proj_" + uuid
  /** Creator; set on create. Under chatVisibility "own" a per-user folder. */
  ownerId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
```

#### useProjects (hook)

- Signature: `useProjects(refreshSessions: () => unknown): ProjectsState`. Called in Home with `refreshSessions`.
- Return type:
  ```ts
  export interface ProjectsState {
    projects: Project[];
    expanded: string[];
    byProject: Record<string, PublicSession[]>;
    error: string;
    clearError: () => void;
    // The last background refresh of projects failed; the list may be stale.
    refreshFailed: boolean;
    toggle: (id: string) => void;
    expand: (id: string) => void;
    refreshAll: () => void;
    create: (name: string) => Promise<Project | null>;
    rename: (id: string, name: string) => Promise<boolean>;
    remove: (id: string) => Promise<boolean>;
    assign: (sessionId: string, projectId: string | null) => Promise<PublicSession | null>;
  }
  ```
- State: `projects`, `expanded`, `byProject`, `error`, `refreshFailed`; refs `listToken`, `projectTokens` (latest-wins per project), `expandedRef`, `refreshSessionsRef`.
- Loads projects on mount (sorted by `updatedAt` desc, then name). Every mutation clears error, sets error "The change could not be saved." (or server message) on failure, then refreshes projects, sessions and expanded folders. `assign` to a project expands it.

#### Menu (internal)

- Props: `{ label: string; disabled?: boolean; children: (menu: { close: () => void; focusFirst: () => void }) => ReactNode }`.
- State: `open`, `pos: { top; left } | null`; refs `trigger`, `menu`.
- Trigger: `button.row-action` (lucide MoreHorizontal 14, `aria-haspopup="menu"`, `aria-expanded`). Menu: `div.menu[role=menu]`, `position: fixed`, width 208px, placed 4px under trigger, right-aligned, clamped 8px from viewport edges, flips above if it would overflow bottom.
- Closes on outside pointerdown, any scroll, resize, Esc (refocus trigger), Tab. Arrow/Home/End roving focus over `[role=menuitem]:not(:disabled), input`.

#### MenuItem (internal)

- Props: `{ icon?: ReactNode; children: ReactNode; onSelect: () => void; danger?: boolean }`. Renders `button.menu-item[.danger][role=menuitem][tabIndex=-1]` > icon + `span`.

#### NameInput (internal)

- Props: `{ initial?: string /* default "" */; label: string; onSubmit: (name: string) => Promise<unknown>; onCancel: () => void }`.
- State: `value`, `error`, `saving`; stable `errorId`.
- `div.project-name-input` > `input` (autoFocus, placeholder "Project name", maxLength 120, `aria-invalid`, disabled while saving) + `small[role=alert]` error. Validation via `checkProjectName` ("Enter a project name." / "Use 80 characters or fewer."). Unchanged name cancels. Enter submits, Esc/blur cancels.

#### SessionMenu

- Purpose: per-conversation "⋯" menu for project membership. Parent: Sidebar `renderRowMenu` (inside `span.convo-menu`), also ProjectSidebar rows.
- Props:
  ```ts
  {
    session: PublicSession;
    state: ProjectsState;
    disabled?: boolean;
    onUpdated?: (session: PublicSession) => void;
  }
  ```
  Home passes `state={projects}`, `disabled={busy}`, `onUpdated={updateCurrentProject}` (syncs projectId on the open session).
- Renders `span.row-menu` > Menu labelled "Options for {title}".
- SessionMenuContent state: `view: "root" | "pick" | "new"`.
  - root: optional `div.menu-heading` "In {project}", item "Add to project" / "Move to project" (FolderInput) → pick, item "Remove from project" (FolderMinus) when in a project.
  - pick: "Back" (ChevronLeft), `div.menu-sep`, one item per target project (Folder), "New project…" (FolderPlus) → new. Empty target list shows only Back and New project.
  - new: NameInput "New project name"; creates then assigns; cancel → pick.

#### ProjectSidebar (exported, not mounted)

- Props:
  ```ts
  {
    state: ProjectsState;
    // The Recents list; fresher titles and moves from it win over folder data.
    sessions: PublicSession[];
    currentSessionId?: string;
    busy?: boolean;
    onOpen: (id: string) => void;
    onNewChat: (projectId: string) => void;
    onDeleted?: (projectId: string) => void;
    onSessionUpdated?: (session: PublicSession) => void;
  }
  ```
- State: `creating` (boolean), `renaming` (project id | null).
- Structure: `section.project-section[aria-label=Projects]` > `div.sidebar-label` "Projects" + `button.row-action.visible` (Plus, "New project") · `p.sidebar-error` · `p.sidebar-refresh-error` "Couldn’t refresh · Retry" (`button.inline-retry`) · `ul.project-list` > NameInput when creating, `li.sidebar-empty` "No projects yet.", `li.project-item` > `div.session-row.project-row` (`button.session-link.project-toggle[aria-expanded]` Folder/FolderOpen + bold name; `span.row-menu` with Plus "New chat in {name}" and Menu Rename / Delete (danger, `window.confirm` "Delete project “{name}”? Conversations will stay in Recents.")) or rename NameInput · expanded `ul.project-sessions` ("Loading…", "No conversations yet.", `li.session-row` > `button.session-link[.selected]` + SessionMenu).
- CSS: legacy `app/shell.css` (`.project-*`, `.row-action`, `.menu`, `.menu-item`, `.session-row`, `.session-link`, `.sidebar-*`); v2 `.convo-menu .row-menu` overrides.

### AnimatedLink

- File: `components/animated-link.tsx`. Purpose: button styled as text link, center-growing underline + sliding arrow on hover/focus. Not rendered by the shell; used by `components/suggested-questions.tsx`.
- Props: `ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }`; `type` defaults `"button"`.
- Splits string children so the last word and arrow stay together (`span.animated-link-text` > text + `span.animated-link-tail`). Non-string children: text span + arrow.
- CSS: `app/chat.css` `.animated-link`, `-text`, `-tail`, `-arrow`; states `:not(:disabled):hover`, `:focus-visible`. Attribution comment: Skiper UI Link003.

### Button

- File: `components/ui/button.tsx`. Purpose: CVA class wrapper for legacy buttons. Not used by the v2 shell; used by capabilities.tsx, assistant-tools.tsx, quick-tools.tsx.
- Props: `React.ComponentProps<"button"> & VariantProps<typeof variants>`; `variant?: "default" | "outline" | "ghost" | null` (default `"default"`).
- Classes: base `.button`; default → `.button-primary`, outline → `.button-outline`, ghost → `.button-ghost` (app/shell.css:74–116). Hover states `:hover:not(:disabled)`.

### Select

- File: `components/ui/select.tsx`. Purpose: Radix Select wrapper. No importers found in app/components/lib (currently unused).
- Props:
  ```ts
  {
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
    placeholder: string;
  }
  ```
- Structure: `Root` > `Trigger.select-trigger[aria-label=placeholder]` (Value + lucide ChevronDown 14) · Portal > `Content.select-content` (position "popper") > Viewport > `Item.select-item` (ItemText + ItemIndicator Check 14).
- States (app/shell.css:149–215): `.select-trigger:hover`, `[data-placeholder]`, `[data-state="open"]`; `.select-item[data-highlighted]`, `[data-state="checked"]`. The v2 system instead uses native `.select select` (base.css).

---

### Hooks and libs

#### useTheme / THEME_BOOT_SCRIPT (`lib/use-theme.ts`)

```ts
export type Theme = "" | "light" | "dark";
export function useTheme(): { theme: Theme; isDark: boolean; toggle: () => void };
```
- localStorage key `truex-theme`; `""` follows `prefers-color-scheme`. Module-level store keeps all callers (Topbar via Home, UserMenu) in sync; also re-renders on OS scheme change.
- `toggle` writes the opposite of the resolved theme (first toggle from system becomes explicit). Writes `document.documentElement.dataset.theme` or removes it.
- Server snapshot `"|0"` (light) until hydration.

#### useHotkeys (`lib/use-hotkeys.ts`)

```ts
export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;
export function hotkeyCombo(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">): string; // ("mod+" if meta||ctrl) + key.toLowerCase()
export function useHotkeys(map: HotkeyMap): void;
```
- Single window keydown listener, latest map via ref, `preventDefault` on match, no focus filtering.

#### fitPanel (`lib/fit-panel.ts`)

```ts
export const PANEL_W = { min: 360, max: 560 } as const;
export const CHAT_MIN = { min: 480, max: 640 } as const;
export const SIDEBAR_W = 268;
export const GAP = 10;
export type PanelSize = keyof typeof PANEL_W; // "min" | "max"
export interface Fit {
  /** Session panel width in px (set inline as --pw). */
  width: number;
  /** Whether the sidebar is allowed to be shown alongside the panel. */
  sidebar: boolean;
  /** Whether the session panel floats as a fixed drawer (.is-overlay). */
  overlay: boolean;
}
export function fitPanel(vw: number, want: number, chatMin: number, sidebarOpen: boolean, panelOpen: boolean): Fit;
```
Rules (width = `min(want, vw - 20)`, chat = `vw - 20 - width - 10`):
1. `vw ≤ 720`: sidebar only if panel closed; no overlay.
2. Panel closed or `vw ≤ 900`: sidebar allowed, no overlay.
3. Sidebar not requested, or `chat - 268 - 10 ≥ chatMin`: sidebar allowed; overlay if sidebar closed and `chat < chatMin`.
4. `chat ≥ chatMin`: sidebar hidden, panel docked.
5. Otherwise sidebar hidden, panel overlay.

#### auto-tab (`lib/auto-tab.ts`) and useFollowActivity (`lib/use-follow-activity.ts`)

Drives "Follow activity": the activity panel jumps to the tab for a newly started goal, plan or helper.
```ts
export type FollowTab = "goal" | "plan" | "agents";
export const FOLLOW_BATCH_MS = 300;    // events this close make one switch; most specific wins
export const MANUAL_HOLD_MS = 8000;    // user-picked tab held this long
// STALE_MS = 60_000: older events ignored (replayed history)
// RANK: goal 0 < plan 1 < agents 2
export interface FollowSeen { goal: Goal | null; plan: PlanStep[]; agentIds: string[] }
export interface FollowContext {
  enabled: boolean; vw: number; now: number;
  manualAt: number;      // when the user last picked a tab
  dismissed: boolean;    // user closed the panel during this turn
  panelOpen: boolean;
  inPanel: boolean;      // pointer or focus inside the panel
  fitsOpen: boolean;     // opening leaves an open sidebar in place
}
export function followTab(event, seen, now?): FollowTab | null; // goal.updated (new active goal), plan.updated (new/reworded steps, not while a goal is active), subagent.spawned/subagent.event (new helper id)
export function noteSeen(seen, event): FollowSeen;
export function pickTab(a, b): FollowTab | null;
export function followAction(ctx: FollowContext): "switch" | "open" | null; // null if disabled or within manual hold; "switch" if open and pointer/focus not inside; "open" only if not dismissed, vw > 900 and fitsOpen
export function readFollow(): boolean;  // localStorage "truex-follow-activity" !== "off"
export function writeFollow(on: boolean): void;
```
`useFollowActivity(options: { panelOpen: boolean; vw: number; fitsOpen: boolean; tab: string; showTab: (tab: FollowTab, open: boolean) => void })` returns `{ ...api, enabled, setEnabled, announce }` where Home uses `reset()`, `onEvent(event)`, `manual()`, `dismiss()`, `enabled`, `setEnabled`, and `announce` (screen-reader text "Session activity is showing the {label} tab.", rendered in `p.sr-only[role=status]`).

#### projects (`lib/projects.ts`)

```ts
export const PROJECT_NAME_MAX = 80;
export type ProjectNameCheck = { ok: true; name: string } | { ok: false; error: string };
export function checkProjectName(raw: string): ProjectNameCheck;
export function sortProjects(projects: Project[]): Project[];
export interface SessionProjectActions {
  // "add" when the conversation is in no project, "move" otherwise.
  mode: "add" | "move";
  // Projects the conversation can be put into (never its current one).
  targets: Project[];
  // A conversation in a project can always be taken out, even if that
  // project is not in the loaded list.
  canRemove: boolean;
  current: Project | null;
}
export function sessionProjectActions(session: Pick<PublicSession, "projectId">, projects: Project[]): SessionProjectActions;
export function draftProject(draftProjectId: string | null, projects: Project[]): Project | null;
export function createSessionBody<T>(agentId: string, subAgents: T, projectId?: string | null): { agentId: string; subAgents: T; projectId?: string };
```
API: `listProjects()` GET `/api/projects`; `listProjectSessions(id)` GET `/api/sessions?projectId=`; `createProject(name)` POST `/api/projects`; `renameProject(id, name)` POST `/api/projects/{id}`; `deleteProject(id)` POST `/api/projects/{id}/delete`; `setSessionProject(sessionId, projectId|null)` POST `/api/sessions/{id}/project`.

#### useClock (`components/use-clock.ts`)

`useClock(active: boolean): number` — shared 1-second ticker, runs only while at least one subscriber is active. Not used by shell components; consumers: request-card, agents-panel, helper-chip, helper-group, observability/insights-panel (live elapsed timers).

---

### Data types consumed by the shell

```ts
// shared/contracts.ts
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  sandbox: string;
  handle?: string;
  look: number;
  tint: AgentTint;
  builtin: boolean;
}
export const AGENT_TINTS = ["ice", "mint", "butter", "peach", "lilac"] as const;
export type AgentTint = (typeof AGENT_TINTS)[number];

export type PublicSession = Pick<
  Session,
  | "_id" | "userId" | "agentId" | "title" | "status"
  | "createdAt" | "goal" | "projectId" | "approvalMode"
>;
// Relevant Session fields:
//   _id: string; userId?: string; agentId: string; title?: string;
//   status: "active" | "orphaned" | "dead"; createdAt: string;
//   goal?: SessionGoal; projectId?: string; approvalMode?: ApprovalMode;

export interface SessionGoal {
  objective: string;
  status: GoalStatus;
  updatedAt?: string;
  createdAt?: number | null;
  tokensObserved?: number;
  tokenBudget?: number | null;
  // (further fields in contracts.ts)
}
export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
export interface Goal {
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number | null;
  updatedAt: number | null;
  tokensObserved?: number;
}

export const APPROVAL_MODES = ["ask", "readOnly", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export interface ApprovalModesConfig {
  enabled: boolean;
  defaultMode: ApprovalMode;
  autopilot: boolean;
  nameHeuristic: boolean;
}
```
(`GoalStatus` members before `"paused"` were not fully visible in the excerpt read; `"active"` is used throughout page.tsx.) Other state types (`Entry`, `DomainEvent`, `PendingRequest`, `PlanStep`, `TurnTiming`, `ObservabilityState`, `SubAgentState`, `DelegationPrefs`, `TurnFailure`, `ConversationFile`, `GoalReview`, `TraceSummary`) belong to the chat/activity slices.

---

### Observations for the redesign

- The Sidebar "Agents" link opens the agent popover rather than an agents view; `agentsActive` is never set.
- The Topbar Share button is a no-op placeholder.
- UserMenu gets no name/email/sign-out, so it always shows "Account".
- `ProjectSidebar` and `components/ui/select.tsx` are unused; the tools Sheet (`panel === "tools"`) has no opener in page.tsx.
- The sidebar has no empty state when there are zero conversations.
- Two parallel style systems coexist (legacy `app/*.css` with `.button`, `.icon-button`, `.sheet`, `.menu` vs v2 `styles/v2/*.css` with `.btn-*`, `.icon-btn`), and error pages, Sheet and project menus still use the legacy set.
- Both panels start closed on every load (no persistence).


## 2. Composer & Input

Scope: the message composer frame, the textarea, the slash-command menu, goal mode + budget, the approval-mode picker, notes/notices inside the composer, the running-helpers chip above it, follow-up suggestions, and the conversation-tools form that mirrors several slash commands.

Not present in the composer (verified by reading `app/page.tsx` and `components/v2/composer.tsx`):
- No attachment / file-upload control. Uploads live in the Tools panel (`components/assistant-tools.tsx`, see §2.13).
- No model picker. Model and effort change via `/model`, `/effort` or `QuickTools` (§2.12).
- No agent picker. The agent is chosen in the floating dock popover (`components/v2/floating-dock.tsx`, `agent-menu.tsx`), outside the composer.

Global state shorthand used below: "page" = `Home` in `frontend/app/page.tsx`.

---

### 2.1 Composer wiring (page-level)

File: `frontend/app/page.tsx` (`composerForm`, ~lines 1033-1211).
Purpose: owns the `<form>`, textarea, keyboard handling, slash menu and submit pipeline; `Composer` is presentational.

Render sites:
- Empty state (`empty = !session && !entries.length`): inside `<Hero>` → `.hero-composer` → `composerForm` (Composer gets `hero={true}`).
- Thread state: after `<HelperChip>` at the bottom of the chat column: `{!empty && <HelperChip .../>}{!empty && composerForm}`.

Tree:

```
<form.composer-form onSubmit={preventDefault; submitInput()}>
  <Composer hero goalMode busy canSend onStop stopTitle ... above below budget chips>
    above:  .composer-project (pending project note)  +  <PrivacyNote draft={text}/>
    children: <SmoothTextarea ref={composer} .../>
    below:  #composer-hint (sr-only)  +  #chat-commands.slash-menu  +  .composer-notice  +  #approval-mode-error
    bar:    Goal chip | <BudgetField> (goal mode only) | <ApprovalModePicker> (flag) | grow | Stop | Send
  </Composer>
</form>
```

Page state that drives the composer:

| State | Type | Controls |
|---|---|---|
| `text` | `string` | Textarea value (the draft) |
| `notice` | `string` | `.composer-notice` status line (validation/usage/help text). Cleared on typing |
| `commandOpen` | `boolean` | Slash menu eligibility. Set to `!goalMode && value.startsWith("/")` on change |
| `commandIndex` | `number` | Highlighted slash-menu option |
| `busy` | `boolean` | A send/command request is in flight (or session being created). Disables textarea and Send |
| `running` | `boolean` | A turn is streaming. Passed to Composer as `busy` (shows Stop) |
| `goalMode` | `boolean` | Goal mode of the composer |
| `goalBudget` | `number \| null` | Token budget from BudgetField |
| `goalBudgetValid` | `boolean` | Custom budget text parses |
| `goal` | `Goal \| null` | Current goal; changes stop tooltip and triggers replace-confirm |
| `composerFocused` | `boolean` | Pauses rotating placeholder |
| `draftProjectId` | `string \| null` | Pending project note |
| `approvalModes` | `ApprovalModesConfig` | Feature flag config (default `approvalModesOff`) |
| `draftMode` / `draftModeRef` | `ApprovalMode \| null` | Mode chosen before a session exists; applied in `ensureSession()` |
| `modeError` | `string` | `#approval-mode-error` alert |
| refs `sending`, `suggesting`, `generation`, `commandAttempt` | | Double-submit guards, stale-response guards, idempotent command retry (`clientId`) |

Props passed to `Composer`:

```tsx
hero={empty}
goalMode={goalMode}
onGoalToggle={() => (goalMode ? setGoalMode(false) : startGoal(text))}
onGoalCancel={() => setGoalMode(false)}
busy={running}
canSend={!!text.trim() && !busy && (!!session || !!agentId)}
onStop={stopTurn}
stopTitle={goal?.status === "active"
  ? "Pause the goal and stop the current response"
  : "Stop the current response"}
onFocusChange={setComposerFocused}
```

Textarea props (`SmoothTextarea`):

```tsx
ref={composer}
aria-label={goalMode ? "Goal" : "Message"}
aria-describedby="composer-hint"
aria-controls={commandSuggestions.length ? "chat-commands" : undefined}
aria-haspopup="listbox"
aria-expanded={commandSuggestions.length > 0}
aria-activedescendant={commandSuggestions.length ? `chat-command-${commandIndex}` : undefined}
disabled={busy || (!session && !agentId)}
value={text}
```

Note: `autoGrow` is not passed, so the SmoothTextarea auto-grow is off; height is bounded by CSS (`min-height: 60px` / hero `76px`, `max-height: 240px`).

Placeholder precedence:
1. `goalMode` → `"Describe the outcome you want. The assistant works until it’s done."`
2. `running` → `"Add a thought to steer the current turn…"`
3. `empty` → rotating placeholder (§2.2)
4. otherwise → `PLACEHOLDERS[0]` = `"Ask anything, or type / for commands"`

Screen-reader hint (`#composer-hint`, `.sr-only`): "Type / for commands. Enter to send, Shift + Enter for a new line."

#### Keyboard behavior (textarea `onKeyDown`)

| Key | Condition | Behavior |
|---|---|---|
| any | `e.nativeEvent.isComposing \|\| e.keyCode === 229` | Ignored (IME composition) |
| Escape | always | If goal mode and slash menu not showing → exit goal mode. Always closes slash menu |
| ArrowDown / ArrowUp | slash menu showing, no Shift/Alt/Ctrl/Meta | `preventDefault`, move highlight with wrap-around |
| Tab | slash menu showing, no modifiers | `preventDefault`, complete highlighted command (`"<name> "`) |
| Enter | no Shift | `preventDefault`, `submitInput()` |
| Shift+Enter | | Newline (native) |

Enter with the menu open and a partial name (e.g. `/co`) completes to `/compact ` instead of executing. Enter on an exact name (`/compact`) executes.

`onChange`: `setText(value)`, `setCommandOpen(!goalMode && value.startsWith("/"))`, `setCommandIndex(0)`, clears `notice`.

#### Submit pipeline (`submitInput()`)

Guards (silent no-op): `busy`, `sending.current`, blank text, or no session and no `agentId`.

1. Slash menu has a highlighted option whose name differs from text → complete it, stop.
2. Goal mode with invalid budget → `notice = budgetHelp`, stop.
3. Parse: goal mode → `goalCommand(text, goalBudget)` (method `thread/goal/set`); else `parseChatInput(text)` (§2.8).
4. Goal mode with an existing non-complete goal → `window.confirm("Replace the current goal with this one?")`; cancel stops. When confirmed, `thread/goal/clear` is sent before the new set.
5. `help` with an existing session is sent to the server as method `"help"`.
6. By kind:
   - `message` → `send(text)`: clears draft, appends optimistic user entry (`delivery: "pending"`), creates session if needed, `transport.send(sessionId, value, clientId)`; on success `delivery: "accepted"` (+`turnId`, `steer`), on failure `delivery: "unknown"` + error banner. While `running`, a message is a steer of the current turn.
   - `panel` → clears draft, opens `mcp` / `tools` panel or the agents tab.
   - `invalid` → `notice = message`, draft kept.
   - `help` (no session) → `notice =` "Commands: /goal [objective|show|pause|resume|budget <tokens>|clear], /fork, /compact, /model <identifier>, /effort <level>, /archive, /unarchive, /tools, /mcp. Use // to send a literal command as a question." Draft cleared. (Note: this string omits `/agents`.)
   - `command` while `running` → `notice =` "Wait for the current response to finish or press Stop before running a command. Your draft is saved."
   - `command` with no session → only a `thread/goal/set` with an objective may create the session; otherwise `notice =` "Start a conversation with a message before using this command. Your draft is saved."
   - `command` → optimistic user entry with `command: { method, params, state: "running" }`, `POST /api/sessions/:id/capabilities { method, params, command: { clientId, text } }`. Result replaces the entry. On `succeeded`, draft cleared; goal commands update goal state and `thread/goal/set` exits goal mode and resets budget. On network failure entry becomes `state: "unknown"` with error "Connection interrupted. Refresh the conversation to check the saved result before trying again."

Stop (`stopTurn()`): if goal is active, first `thread/goal/set { status: "paused" }`; then `transport.interrupt(id)`; a 409 (turn already ended) is swallowed.

Other entry points that fill the composer:
- `startGoal(template)`: closes panel, goal mode on, sets text, focuses with caret at end.
- `applyPrompt(prompt)`: from capability/starter prompts; `"/goal"` → `startGoal()`; else sets text, opens slash menu if it starts with `/`, focuses.
- `ChatMessages.onPrompt` / `onCommand`: set text, close menu, focus.
- `askSuggestion(question)`: see §2.10.

---

### 2.2 `Composer` and `useRotatingPlaceholder`

File: `frontend/components/v2/composer.tsx`
Purpose: presentational composer frame (spec Core §2): goal header, slots, action bar with Goal chip, Stop and Send.
Parent: `composerForm` in `app/page.tsx` (hero or thread bottom).

Props:

```ts
{
  children: ReactNode;                 // required, the textarea
  goalMode: boolean;                   // required
  onGoalToggle: () => void;            // required
  onGoalCancel: () => void;            // required
  busy: boolean;                       // required, a turn is running: shows Stop
  canSend: boolean;                    // required, enables Send (and shows it next to Stop while busy)
  onStop: () => void;                  // required
  hero?: boolean;                      // default false: empty-state variant
  budget?: ReactNode;                  // shown after Goal chip only in goal mode
  chips?: ReactNode;                   // extra chips after Goal chip
  above?: ReactNode;                   // notes above the textarea
  below?: ReactNode;                   // between textarea and bar (slash menu, notices)
  stopTitle?: string;                  // Stop button title
  onFocusChange?: (focused: boolean) => void;
}
```

Internal state: `focused: boolean`, tracked with `onFocusCapture`/`onBlurCapture` only when `e.target instanceof HTMLTextAreaElement` (chips/buttons don't count).

Root class: `composer` + `is-hero` (hero) + `goal-mode` (goalMode) + `is-focus` (textarea focused).

Structure / states:
- Goal mode header `.composer-goal-head`: target icon (15), "**New goal** The assistant keeps working until the goal is done, paused or out of budget.", cancel `button.icon-btn.ghost` `aria-label="Cancel goal"` (x icon 14) → `onGoalCancel`.
- `{above}{children}{below}`
- `.composer-bar`:
  - `button.chip.goal-chip` `aria-pressed={goalMode}`, title "Set this message as the conversation goal", target icon 14 + "Goal" → `onGoalToggle`.
  - `{goalMode && budget}` then `{chips}`, `span.grow` spacer.
  - Stop: rendered when `busy`: `button.send.is-stop` `aria-label="Stop"` `title={stopTitle}`, stop icon 12 stroke 3.
  - Send: rendered when `!busy || canSend`: `button[type=submit].send`, `disabled={!canSend}`, `aria-label={goalMode ? "Start goal" : "Send"}`, arrowUp icon 17 stroke 2.25.

Button-state matrix (page `busy` = request in flight, Composer `busy` = page `running`):

| Situation | Stop | Send |
|---|---|---|
| Idle, empty draft | hidden | shown, disabled (opacity .35) |
| Idle, text | hidden | enabled |
| Request in flight (page `busy`) | hidden unless running | disabled; textarea disabled |
| Streaming, empty draft | shown | hidden |
| Streaming, text typed (steer) | shown | shown, enabled |
| No session and no agent | hidden | disabled; textarea disabled |

`useRotatingPlaceholder(active: boolean): string` — cycles `PLACEHOLDERS` every 3200 ms while `active` (page: `empty && !composerFocused && !text && !goalMode`). Index is kept when paused; text swaps with no transition.

```ts
export const PLACEHOLDERS = [
  "Ask anything, or type / for commands",
  "Summarize last week's pipeline changes",
  "Compare Q2 vs Q3 revenue by region",
  "Draft a reply to the customer escalation",
] as const;
export const GOAL_PLACEHOLDER =
  "Describe the outcome you want. The assistant works until it’s done.";
```

(page inlines the goal string rather than importing `GOAL_PLACEHOLDER`.)

CSS (`frontend/styles/v2/chat.css` ~251-300, 412-414; `styles/v2/base.css` `.chip`; `styles/v2/shell.css` `.hero-composer`):
- `.composer`: max-width 740px, surface bg, 1px `--line` border, radius 18px, `--shadow-md`, padding `12px 10px 8px 12px`, transition border/shadow .15s. `:focus-within` intentionally neutralised.
- `.composer.is-focus`: accent 45% border + 4px accent 10% ring. `.goal-mode`: border `--accent-soft-2`; `.goal-mode.is-focus` accent 40%.
- `.composer.is-hero` / `.hero-composer .composer`: no max-width; hero textarea min-height 76px; `.hero-composer` margin-top 28px.
- `.composer textarea`: min-height 60px, max-height 240px, padding `4px 4px 12px`, no border, 15px/1.5, placeholder `--ink-3`, `:disabled` cursor not-allowed.
- `.composer-bar`: flex, gap 2px. `.chip`: 30px pill, `--surface-2`, 13px/500. Goal chip pressed: `--accent-soft` bg, `--accent-fg`.
- `.send`: 34×34, radius 11px, `--accent` bg, `--on-accent`; disabled opacity .35; active scale .94. `.send.is-stop`: `--ink` bg, `--bg` fg.
- `.composer-form`: width 100%, max-width 740px (none in hero).
- Reduced motion: `.send, .composer { transition: none }`.
- Legacy rules also exist in `frontend/app/chat.css` (`.composer`, `.slash-menu`, `.composer-notice`, `.composer-project`).

---

### 2.3 `SmoothTextarea`

File: `frontend/components/smooth-textarea.tsx`
Purpose: native textarea with a spring-animated custom caret (adapted from Skiper 106) and optional auto-grow.
Parent: `composerForm` (as Composer `children`).

Props:

```ts
ComponentProps<"textarea"> & {
  /** Grow with the text up to this many px (spec composer: 240). Off by default. */
  autoGrow?: number;
}
// `ref`, `onFocus`, `onBlur` are intercepted and forwarded.
```

Internals:
- Refs: `input` (textarea), `mirror` (hidden div laid out identically), `last: { x, line, width } | null`.
- Motion values: `x`, `line`, `scroll`, `height`, `opacity`; `y = line - scroll` (scroll applied instantly so caret stays pinned).
- Spring: `{ type: "spring", stiffness: 500, damping: 30, mass: 0.5 }`. `SWEEP_LIMIT = 48` px: on a line change, horizontal moves wider than this snap instead of sweeping.
- Mirrors 27 computed style keys (font, spacing, padding, border) into the mirror.
- Caret hidden when: textarea not focused, disabled, or a range is selected (`selectionStart !== selectionEnd`), or caret is scrolled out of view, or window blur.
- Reduced motion (`useReducedMotion`) or width change → caret jumps (no spring).
- Recomputes on: value/disabled change (microtask), `selectionchange`, font load, textarea scroll, ResizeObserver.
- Auto-grow (only if `autoGrow`): `height = auto` then `min(scrollHeight, autoGrow)` px.

DOM: `div.smooth-field > textarea + div.smooth-mirror[aria-hidden] + motion.div.smooth-caret[aria-hidden]`.
CSS: `.smooth-field`, `.smooth-mirror`, `.smooth-caret` in `frontend/app/chat.css`; `.composer .smooth-field textarea`.

---

### 2.4 Slash-command menu (inline in page)

File: `frontend/app/page.tsx` (Composer `below`); data from `frontend/lib/slash-commands.ts`.
Purpose: autocomplete list for `/` commands.

Visibility: `commandSuggestions = commandOpen ? suggestCommands(text) : []`; rendered only when non-empty. `suggestCommands` matches only while the text is `/^\/[a-z]*$/i` (no args, no second line) and filters by `name.startsWith(text.toLowerCase())`. Never opens in goal mode.

Markup:

```tsx
<div id="chat-commands" className="slash-menu" role="listbox" aria-label="Chat commands">
  <button id={`chat-command-${index}`} type="button" role="option"
    aria-selected={index === commandIndex} className={index === commandIndex ? "selected" : ""}
    onMouseDown={e => e.preventDefault()}   // keeps textarea focus
    onClick={() => selectCommand(command.name)}>
    <strong>{command.name}</strong><span>{command.description}</span>
  </button>
</div>
```

Behavior: arrow keys move (wrap), Tab/Enter complete a partial name (inserts `"<name> "`, closes menu, resets index, refocuses), click completes, Esc closes. Textarea exposes combobox-style ARIA (`aria-activedescendant`).

CSS: `frontend/app/chat.css` `.slash-menu` (absolute, z-index 5, `bottom: calc(100% + 8px)`, max-height 260px, overflow-y auto, padding 4px); v2 overrides `styles/v2/chat.css`: full width, 12px radius, `--shadow-lg`, selected/hover `--surface-3`, name in 12px mono `--accent-fg`, description `--ink-3`.

---

### 2.5 Composer notes and notices

All inside `Composer`, rendered by the page.

| Element | Slot | Role | Shown when | Content |
|---|---|---|---|---|
| `.composer-project` | above | `status` | No session and `draftProject(draftProjectId, projects)` resolves | folder icon, "New chat in **{name}**", dismiss `icon-btn ghost` `aria-label="Don't add to {name}"` → `setDraftProjectId(null)` |
| `PrivacyNote` (§2.6) | above | `status` | Draft scan finds sensitive data | warning note |
| `.composer-notice` | below | `status` | `notice` non-empty | usage/validation/help text (cleared on next keystroke) |
| `#approval-mode-error.composer-notice.approval-mode-error` | below | `alert` | `modeError` non-empty | "Autopilot is not available right now." (HTTP 422) or "Could not change the approval mode. {userMessage}" |

CSS: `styles/v2/chat.css` `.composer .composer-project` (12px, `--ink-3`, accent icon/strong), `.composer-note` / `.composer-note.is-warn` (`--warning-bg`/`--warning-text`, radius 10px, 12.5px). `.composer-notice` in `frontend/app/chat.css`.

---

### 2.6 `PrivacyNote`

File: `frontend/components/observability/privacy-note.tsx`
Purpose: non-blocking heads-up when the draft looks like it contains sensitive data.
Parent: Composer `above`.

Props: `{ draft: string }` (required).
State: `note: string`, `dismissed: string`.
Behavior: 250 ms debounce → `draftNote(scanText(draft, "userMessage"))` (`shared/privacy.ts`, `lib/observability.ts`). Text format: "This looks like {a/an label}[, … and …]. It will be sent to the model." Dismiss hides it until the note text changes; clearing the draft resets both. Never blocks sending.
Markup: `div.composer-note.is-warn[role=status]` > lucide `ShieldAlert` 14 + span + `button.icon-btn.ghost` `aria-label="Dismiss privacy note"`.

---

### 2.7 `BudgetField`

File: `frontend/components/budget-field.tsx`
Purpose: preset or custom token budget for a goal. Shared by the composer (goal mode) and the goal bar.
Parent: Composer `budget` slot (only rendered in goal mode); also `goal-bar`.

Props:

```ts
export type BudgetValue = { tokens: number | null; valid: boolean };
{
  initial: number | null;                 // required
  onChange: (value: BudgetValue) => void; // required
  selectClassName?: string;
  showError?: boolean;                    // default true
  autoFocus?: boolean;                    // default false (select)
}
```

Page usage: `initial={goalBudget}`, `onChange` → `setGoalBudget(tokens)`, `setGoalBudgetValid(valid)`.

State: `choice` (preset value as string, `""` for No budget, or `"custom"`; defaults to `"custom"` if `initial` isn't a preset), `custom` (text), `touched` (set on custom input blur, reset on select change). Reports initial value on mount.

Options (`lib/goal.ts`):

```ts
export const budgetOptions: { label: string; value: number | null }[] = [
  { label: "No budget", value: null },
  { label: "25k tokens", value: 25_000 },
  { label: "100k tokens", value: 100_000 },
  { label: "250k tokens", value: 250_000 },
];
// + <option value="custom">Custom…</option>
```

Validation (`parseTokenBudget`): `/^(\d[\d,_]*)(k?)$/i` after trim; accepts `50000`, `50,000`, `50_000`, `50k`; must be a safe integer, `> 0`, `<= MAX_TOKEN_BUDGET` (10,000,000). Otherwise `null` → invalid. Custom input `maxLength={12}`, `inputMode="numeric"`, placeholder "e.g. 50k", autofocuses when shown.
Error: shown when `showError && touched && invalid`: `span.budget-error[role=alert]` with `budgetHelp` = "Enter a whole number of tokens, like 50000 or 50k (up to 10M)." Input gets `aria-invalid`. On submit with an invalid budget, the page also puts `budgetHelp` in `.composer-notice`.

Markup: `span.budget-field > span.select > (label.sr-only "Budget" + select + Icon upDown 13) + input.input.budget-custom? + span.budget-error?`.
CSS: `styles/v2/chat.css` (`.budget-field` inline-flex wrap gap 6px; custom input 96×30, radius 9px, 13px; error full row 12px `--error-text`); older rules in `frontend/app/shell.css`.

---

### 2.8 Slash commands (`lib/slash-commands.ts`)

`slashCommands: { name: string; description: string }[]` and parser:

```ts
type ParsedInput =
  | { kind: "message"; text: string }
  | { kind: "invalid"; message: string }
  | { kind: "help" }
  | { kind: "panel"; panel: "mcp" | "tools" | "agents" }
  | { kind: "command"; method: string; params: Record<string, unknown>; success: string };
export function suggestCommands(text: string): typeof slashCommands;
export function parseChatInput(text: string): ParsedInput;
```

Parsing rules:
- Trimmed input starting with `//` → message with the first `//` replaced by `/` (escape a literal command).
- `/^\/(\S+)(?:\s+([\s\S]*))?$/`; command name lowercased. Unknown names (e.g. `/usr/bin`) → plain message.
- Commands other than `/goal`, `/model`, `/effort` reject arguments: "`{name}` takes no arguments. Use /help for command syntax, or prefix with // to send it as a question."

| Command | Menu description | Args | Result (method / params / success text) |
|---|---|---|---|
| `/goal` | "Set a goal, or /goal show \| pause \| resume \| budget <tokens> \| clear" | none or `show` | `thread/goal/get`, `""` |
| | | `clear` | `thread/goal/clear`, "Goal cleared." |
| | | `pause` | `thread/goal/set {status:"paused"}`, "Goal paused." |
| | | `resume` | `thread/goal/set {status:"active"}`, "Goal resumed." |
| | | `budget <tokens>` | `thread/goal/set {tokenBudget}`, "Token budget set to N." Invalid → "Usage: /goal budget <tokens>, for example /goal budget 50k" |
| | | any other text | `thread/goal/set {objective}`, "Goal updated." (can create a session) |
| `/fork` | "Create a new conversation branch" | none | `thread/fork`, "Created a conversation branch." |
| `/compact` | "Summarize this conversation context" | none | `thread/compact/start`, "Context compaction requested." |
| `/model` | "Change model: /model <model name>" | one token, required | `thread/settings/update {model}`, "Model changed to X." Missing/whitespace → "Usage: /model <model identifier>" |
| `/effort` | "Change reasoning: /effort <level>" | `none\|minimal\|low\|medium\|high\|xhigh\|ultra` | `thread/settings/update {effort}`, "Reasoning effort changed to X." Else "Usage: /effort <none\|minimal\|low\|medium\|high\|xhigh\|ultra>" |
| `/archive` | "Archive this conversation" | none | `thread/archive`, "Conversation archived." |
| `/unarchive` | "Restore this conversation" | none | `thread/unarchive`, "Conversation restored." |
| `/tools` | "Capabilities, documents & visuals" | none | panel `tools` |
| `/mcp` | "Manage connected tools (MCP)" | none | panel `mcp` |
| `/agents` | "Show helper agents in this conversation" | none | panel `agents` (opens agents tab) |
| `/help` | "Show available chat commands" | none | `help` (server `"help"` method when a session exists, else local notice) |

Commands run as a user message entry with an inline command result card (`components/command-result.tsx`, outside this slice). All commands (not panels/help) are blocked while a turn is running.

---

### 2.9 `ApprovalModePicker` + `lib/approval-mode.ts`

File: `frontend/components/approval-mode-picker.tsx`
Purpose: alpha per-chat control for which questions/tool approvals are auto-answered. Native `<select>` for keyboard and mobile pickers.
Parent: Composer `chips` slot, only when `modePicker(...)` returns non-null.

Props:

```ts
{
  picker: ModePicker;                        // required
  onChange: (mode: ApprovalMode) => void;    // required
  disabled?: boolean;                        // default false (page never passes it)
  errorId?: string;                          // page: "approval-mode-error" when modeError set
}
```

Types:

```ts
// shared/contracts.ts
export const APPROVAL_MODES = ["ask", "readOnly", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export interface ApprovalModesConfig {   // GET /api/features → approvalModes
  enabled: boolean;
  defaultMode: ApprovalMode;
  autopilot: boolean;
  nameHeuristic: boolean;
}
// lib/approval-mode.ts
export interface ModeOption { value: ApprovalMode; label: string; description: string; }
export interface ModePicker { options: ModeOption[]; selected: ApprovalMode; }
export const approvalModesOff: ApprovalModesConfig =
  { enabled: false, defaultMode: "ask", autopilot: false, nameHeuristic: false };
```

Modes:

| id | Label | Description | Gating |
|---|---|---|---|
| `ask` | Ask me every time | Every question and tool use waits for your answer. | `enabled` |
| `readOnly` | Auto-allow read-only tools | Tools that only read data run without asking. | `enabled` |
| `auto` | Autopilot | Runs tools and picks recommended answers; plans and secrets still ask. | `enabled && autopilot` |

Contract note: plan approval and secret questions always ask, in every mode.

Selection logic (`modePicker(config, session, draft)`): returns `null` if `!config.enabled`. Wanted = `session.approvalMode` ?? (no session ? `draft` : null) ?? `config.defaultMode`; falls back to `defaultMode` then `"ask"` if not in options.
Loading: `loadApprovalModes()` — any failure or bad shape → `approvalModesOff` (feature hidden), logs a warning.
Changing: `changeApprovalMode` in page is optimistic. No session → stored as draft and applied after `ensureSession()` before the first message. With a session → `POST /api/sessions/:id/approval-mode { mode }`; rollback on failure with `modeError`.

Markup: `span.approval-mode > label.visually-hidden "Approval mode (alpha)" + span.select > (select.approval-mode-select[title=description, aria-describedby=help (+errorId)] + Icon upDown 13) + span.approval-mode-tag[aria-hidden] "Alpha" + span.visually-hidden#help (description)`. Each `<option>` has `title={description}`.

CSS (`styles/v2/chat.css`): `.approval-mode` inline-flex gap 4px, shrinkable; select max-width 190px (128px at `max-width: 640px`), ellipsis; `.approval-mode-tag` pill `--accent-soft`/`--accent-fg`, 10.5px mono uppercase.

The same module exports audit-record label helpers (`decisionLabel`, `autoModeLabel`, `recordSummary`, `autoAnswerNote`) used by `approval-record.tsx` in the transcript, not the composer.

---

### 2.10 `SuggestedQuestions` + `lib/suggestions.ts`

File: `frontend/components/suggested-questions.tsx`
Purpose: follow-up questions under the latest answer; clicking sends one.
Parent: `components/chat-messages.tsx` (end of an assistant turn), fed `onSuggest={askSuggestion}` from page; enabled only when `!busy && !goalMode && !failure && !pending.length` (`suggestionsEnabled`).

Props:

```ts
{ questions: string[]; onSelect: (question: string) => void; disabled?: boolean; }
```

Markup: `nav.suggested-questions[aria-label="Suggested follow-ups"] > ul > li > AnimatedLink.suggested-question[aria-label="Ask: {q}"]`.

Parsing (`splitSuggestions(text, streaming)` → `{ body: string; suggestions: string[] }`):
- Model appends a block: `[truex-suggestions]` / list lines (`-`, `*`, `•`, `1.`, `1)`) / `[/truex-suggestions]`. Markers ignored inside code fences.
- Max 3 suggestions, each ≤ 160 chars, surrounding quotes/backticks/`*`/`_` stripped, whitespace collapsed, case-insensitive dedupe.
- While streaming, suggestions are `[]` and a partially arrived marker line is hidden; an unclosed block is hidden.

Send behavior (`askSuggestion`): ignored if already suggesting/sending/busy/running. Closes menu, clears notice, puts the question in the composer, focuses, then after 350 ms sends it; restores the previous unsent draft afterwards.

CSS (`styles/v2/chat.css`): `.suggested-questions` margin-top 12px; column list gap 4px; `.suggested-question.animated-link` `--accent-fg`, 13px/500.

---

### 2.11 `HelperChip`

File: `frontend/components/helper-chip.tsx`
Purpose: pill pinned just above the composer while helper agents run, so count and elapsed time stay visible.
Parent: page, `{!empty && <HelperChip state={subAgents} onView={viewHelpers} />}` directly before `composerForm`.

Props: `{ state: SubAgentState; onView: () => void }` (both required).

```ts
// lib/subagents.ts
export interface SubAgentState {
  agents: SubAgent[];
  previews: Record<string, string>;
  skewMs?: number;   // server clock minus browser clock
}
// shared/contracts.ts
export interface SubAgent {
  threadId: string; path: string | null; nickname: string | null; role: string | null;
  depth: number; status: SubAgentStatus; task?: string; lastMessage?: string;
  startedAt: string; endedAt?: string;
}
// statuses: pendingInit | running | interrupted | completed | errored | shutdown | notFound
// isRunning = status === "running" || status === "pendingInit"
```

States: renders `null` when no running helpers. Otherwise `div.helper-chip.status-pill`: `.pulse` dot, "{n} helper(s) running · {LiveDuration}" (aria-hidden), a `visually-hidden aria-live="polite"` count (timer ticks are not announced), `button.link.helper-chip-view` "View" → `onView`. Clock ticks via `useClock(running.length > 0)`.

`viewHelpers` (page): scrolls to the last `.helper-group` element and focuses it, else opens the agents panel. Finding: `HelperGroup` renders `section.hcard`, not `.helper-group`, so this selector currently never matches and "View" always opens the agents panel.

CSS: `styles/v2/base.css` `.status-pill` (30px pill, surface, `--shadow-sm`); `styles/v2/chat.css` `.helper-chip.status-pill` (centered, tabular nums), `.helper-chip-view`.

---

### 2.12 `HelperGroup` / `HelperRow`

File: `frontend/components/helper-group.tsx`
Purpose: inline card listing the helper agents one turn started, with expandable output and Stop. (Transcript content, but tied to HelperChip.)
Parent: `components/chat-messages.tsx` for entries of kind `"agents"`.

Props:

```ts
HelperGroup: { id: string; threadIds: string[]; state: SubAgentState; sessionId?: string;
               onOpenAgent?: (threadId: string) => void; }
HelperRow (internal): { agent: SubAgent; tone: number /* i % 3 */; name: string; preview: string;
               elapsed: number; sessionId?: string; onOpenAgent?: (threadId: string) => void; }
```

HelperGroup: returns `null` if no matching agents. `section.hcard#helpers-{id}[tabIndex=-1][aria-label="Helper agents"]`; header summary "N helper(s) · X running · Y done" + group `LiveDuration`; polite live region with the summary.
HelperRow state: `open`, `stopping`, `error`.
- Row button `.hcard-row.tone-{0..2}` `aria-expanded`, avatar initial, name + task title (`taskTitle`, 48-char limit), status chip (`.ag-chip.is-running` with spinner, or `is-done` completed / `is-warn` errored|notFound / `is-stopped` others), elapsed, "Open"/"Hide" + chevron.
- Detail `.hcard-detail`: markdown output tail (`previewTail`, 240 chars / 4 lines; running uses live preview, else `lastMessage`), suggestions stripped; empty: "No output yet." / "No output was shared."; full task text; error `role=alert`; actions "Open transcript" (`btn-soft`) and, while running, "Stop"/"Stopping…" (`btn-ghost danger`, `aria-label="Stop {name}"`) → `interruptAgent(sessionId, threadId)`.

Status labels: Starting, Running, Stopped, Finished, Failed, Closed, Unavailable.
CSS: `styles/v2/chat.css` `.hcard*` (~73-110), `.ag-chip*` in `base.css`; at `max-width: 700px` the row status chip is hidden.

---

### 2.13 `QuickTools` (conversation tools form)

File: `frontend/components/quick-tools.tsx`
Purpose: button/form equivalents of `/fork`, `/compact`, `/model` + `/effort`, `/archive`. The only model/effort picker UI.
Parents: `components/assistant-tools.tsx` (Tools panel, `key={sessionId}`, `disabled={running}`, `refreshKey`) and `components/capabilities.tsx`.

Props:

```ts
{ sessionId: string; onFork: (id: string) => void; disabled?: boolean /* default false */;
  refreshKey?: number /* accepted but unused */ }
```

State: `model` (""), `effort` ("medium"), `result` (""), `busy` (false).
Actions → `POST /api/sessions/:id/capabilities { method, params }`: "Fork conversation" (`thread/fork`; if response has `session`, calls `onFork(session._id)`), "Compact context" (`thread/compact/start`), details "Model settings": Model text input (placeholder "Model identifier (optional)", no validation) + Reasoning effort select (`none|minimal|low|medium|high|xhigh|ultra`) + "Apply settings" (`thread/settings/update { model?, effort }`), details "Conversation lifecycle": "Archive conversation" (`thread/archive`).
States: `fieldset.quick-tools[disabled=busy]`; buttons disabled on `busy || disabled`; result `p[role=status]` "Done." or the error message.
CSS: `frontend/app/panels.css` `.quick-tools*`. Uses `components/ui/button` (`variant="outline"`).

Related (not in the composer): document upload lives in `assistant-tools.tsx` as `label.document-upload > input[type=file]` (`accept=uploadAccept` = `.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.abap,.cds,.json,.xml,.yaml,.sql,.js,.ts`, copy says 1 MB per file), disabled while uploading or running and before a session exists.

---

### 2.14 `lib/request-input.ts` (request-card answer helpers)

Purpose: pure helpers for answering agent questions and tool approvals (`components/request-card.tsx`, which renders in the transcript/near the composer; the card itself is outside this slice). No component here.

```ts
export interface InputOption { label: string; description?: string; }
export interface InputQuestion {
  id: string; kind?: "toolApproval"; header?: string; question: string; action?: string;
  isOther?: boolean; isSecret?: boolean; options?: InputOption[] | null;
}
```

Rules:
- Tool-approval display labels (submitted value stays the original): Allow → "Allow once"; "Allow for this session" → "Allow for this chat"; "Allow and don't ask me again" → "Always allow"; Cancel → "Don't allow" (`isDecline`).
- `answersOnClick`: a single question with options submits on click; otherwise answers are reviewed and submitted together.
- `needsText`: free-text field when no options, or user chose "other" and `isOther === true`.
- `missingAnswers` / `complete`: every answer must be non-blank after trim.
- `afterPick(questions, step, answers)`: `"next"` until last question, then `"send"` if complete else `"wait"` (one question at a time).
- `answerPayload`: `{ answers: { [id]: { answers: [trimmed] } } }`.
- `msLeft(expiresAt, now)`: ms until expiry, floor 0.
- `answerErrorMessage`: 409 "This was already answered."; 404/410 "This request is no longer available."; else "Your answer could not be sent. Please try again."

---

### 2.15 Limits and validation summary

| Item | Rule | Source |
|---|---|---|
| Message length | No max length on the textarea; only non-blank (`text.trim()`) | page |
| Textarea height | 60px min (76px hero), 240px max via CSS; auto-grow prop unused | `styles/v2/chat.css` |
| Token budget | `/^(\d[\d,_]*)(k?)$/i`, integer 1…10,000,000; custom input maxLength 12 | `lib/goal.ts`, `budget-field.tsx` |
| `/model` | exactly one whitespace-free token | `slash-commands.ts` |
| `/effort` | none, minimal, low, medium, high, xhigh, ultra | `slash-commands.ts` |
| Suggestions | max 3, ≤160 chars each | `lib/suggestions.ts` |
| Suggestion send delay | 350 ms | page |
| Placeholder rotation | 3200 ms | `composer.tsx` |
| Privacy scan debounce | 250 ms | `privacy-note.tsx` |
| Helper task title | 48 chars; preview tail 240 chars / 4 lines | `lib/subagents.ts` |
| Upload (Tools panel) | listed extensions, 1 MB/file (copy) | `lib/document-kind.ts`, `assistant-tools.tsx` |

### 2.16 Findings worth knowing for the redesign

- Composer's `busy` prop is the page's `running`; the page's own `busy` disables the textarea. Steering a running turn is supported (Send appears next to Stop once text is typed).
- `viewHelpers` targets `.helper-group`, but `HelperGroup` renders `.hcard`, so HelperChip "View" always falls back to the agents panel.
- The local `/help` notice text omits `/agents`.
- `QuickTools.refreshKey` is accepted but unused; `SmoothTextarea.autoGrow` and `GOAL_PLACEHOLDER` exist but aren't used by the page.
- No attachment, model or agent picker inside the composer today; any redesign adding them is net-new.


## 3. Message Stream & Items

Scope: everything that renders inside the conversation scroller (`app/page.tsx`, `.scroll > .thread`) plus the item-level components reused in the Session activity panel and Assistant tools panel.

Render tree (as mounted by `app/page.tsx` ~L1260–1325):

```
div.scroll [role=log aria-label="Conversation" aria-live=off]   ← follow-scroll owner
├─ <Hero>  (only when conversation is empty; holds the composer)
└─ div.thread
   ├─ <ChatMessages entries … />
   │   ├─ article.msg.user            (per user message)
   │   │   └─ <CommandResult/>        (if the message was a slash command)
   │   ├─ article.msg.agent           (per assistant response group)
   │   │   ├─ <ThinkingBlock/>
   │   │   ├─ "Working" steps row
   │   │   ├─ <ApprovalRecordView/>   (entry kind "approval")
   │   │   ├─ <HelperGroup/>          (entry kind "agents")          [outside slice]
   │   │   ├─ div.answer.markdown     (entry kind "message")
   │   │   │   ├─ <Markdown remarkGfm/>
   │   │   │   ├─ <Visualization/>    (inline [truex-visualization:ID] refs)
   │   │   │   └─ span.caret          (streaming)
   │   │   ├─ <TurnReceipt/> | <LiveUsage/>                          [outside slice]
   │   │   └─ <SuggestedQuestions/>                                  [outside slice]
   │   └─ div.msg.agent placeholder   (running, no response group yet)
   └─ <RequestCard/> × pending requests  (after the stream, not interleaved)
       ├─ <PlanApprovalCard/>  → <PlanSteps/>
       └─ <QuestionCard/>
       └─ <ErrorRef/>
div.bottom
   └─ div.error-banner → <ErrorRef/>   (page-level error)
```

Style files: `styles/v2/chat.css` (primary, v2 design), `app/chat.css`, `app/panels.css` (legacy/overrides), `styles/v2/session.css` (plan list, session panel), `app/shell.css` (error-ref), `styles/v2/tokens.css` (tokens).

---

### 3.0 Data model

#### 3.0.1 Persisted message — `shared/contracts.ts`

```ts
export interface Message {
  command?: CommandRecord;
  _id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  turnId?: string;
  itemId?: string;
  clientId?: string;
  delivery?: "pending" | "accepted" | "failed" | "unknown";
  steer?: boolean;
  order?: number;
  messageIndex?: number;
  runtimeItemId?: string;
}

export interface CommandRecord {
  method: string;
  params: Record<string, unknown>;
  state: "running" | "succeeded" | "failed" | "unknown";
  afterMessageId?: string;
  result?: {
    help?: string;
    goal?: Goal | null;
    sessionId?: string;
  };
  error?: string;
}
```

#### 3.0.2 Display entry union — `lib/chat.ts`

```ts
export type Entry =
  | {
      kind: "message";
      command?: Message["command"];
      id: string;
      role: string;
      text: string;
      turnId?: string;
      itemId?: string;
      aliases?: string[];
      messageIndex?: number;
      final?: boolean;
      done?: boolean;
      delivery?: string;
      steer?: boolean;
    }
  | {
      kind: "thinking";
      id: string;
      turnId?: string;
      itemId?: string;
      text: string;
      summary?: string;
      raw?: string;
      done?: boolean;
    }
  | { kind: "item"; id: string; turnId?: string; item: any }
  // The helper agents a turn started, shown as one live block.
  | { kind: "agents"; id: string; turnId?: string; threadIds: string[] }
  | { kind: "approval"; id: string; turnId?: string; record: ApprovalRecord };
```

Entry id conventions: user message `clientId || itemId || _id`; assistant `answer:{turnId}:{itemId|messageIndex|listLength}`; thinking `thinking:{turnId}:{itemId|"default"}`; runtime item `item:{turnId}:{item.id}`; helpers `agents:{turnId|"none"}`; approval `approval:{requestId}`.

Message flags:
- `final` — text is complete (from history or `message.final`). Non-final = streaming.
- `done` — turn completed (`turn.completed`) even if no final message arrived.
- `delivery` (user only) — `"pending"` shows "Sending…", anything other than `"accepted"` shows "Delivery unconfirmed".
- `steer` (user only) — sent while a turn was running; shows "Follow-up".
- `command` (user only) — slash command; renders a `CommandResult` card.

#### 3.0.3 Approval audit record — `shared/contracts.ts`

```ts
export interface ApprovalRecord {
  requestId: string;
  at?: string;
  turnId?: string;
  // "auto": nobody answered in time, so the recommended option was used,
  // or (with autoMode) the chat's approval mode answered it.
  outcome: "answered" | "auto" | "expired" | "interrupted";
  autoMode?: "readOnly" | "auto" | "grant";
  items: (
    | {
        kind: "toolApproval";
        action?: string;
        decision:
          | "allowedOnce"
          | "allowedSession"
          | "allowedChat"
          | "allowedAlways"
          | "declined"
          | "expired"
          | "interrupted";
      }
    | {
        kind: "question";
        question: string;
        answer?: string;
        note?: string;
        secret?: true;
      }
  )[];
}
```
`lib/approval-mode.ts` aliases: `ModeRecord = ApprovalRecord`, `RecordItem = ApprovalRecord["items"][number]`, `ToolDecision`, `AutoMode = NonNullable<ApprovalRecord["autoMode"]>`, `Tone = "allowed" | "declined" | "muted"`.

#### 3.0.4 Pending request (live approval/question) — `shared/contracts.ts`, `lib/request-input.ts`

```ts
export interface PendingRequest {
  requestId: string;
  method: string;               // only "item/tool/requestUserInput" is rendered
  detail: Record<string, unknown>; // detail.questions: InputQuestion[]
  expiresAt: string;
  responseSchema: string | null;
}

export interface InputOption {
  label: string;
  description?: string;
}
export interface InputQuestion {
  id: string;
  kind?: "toolApproval";
  header?: string;
  question: string;
  action?: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: InputOption[] | null;
}
```
Answer payload (emitted via `onAnswer`):
```ts
{ answers: { [questionId]: { answers: [string] } } }
// plan approval: { answers: { plan_approval: { answers: ["Approve"] | ["Revise", "user_note: <feedback>"] } } }
```

#### 3.0.5 Plan — `lib/plan.ts`

```ts
export type PlanStatus = "pending" | "inProgress" | "completed";
export interface PlanStep {
  step: string;
  status: string; // normalized by stepStatus(): "inProgress" | "in_progress" → inProgress, "completed", else pending
}
export const PLAN_APPROVAL_ID = "plan_approval";
export const APPROVE = "Approve";
export const REVISE = "Revise";
export const statusText: Record<PlanStatus, string> = {
  pending: "Pending", inProgress: "In progress", completed: "Completed",
};
```
`planProgress(plan)` → `{ done, total, current, label }`; `current` = first `inProgress` index, else (between steps, `0 < done < total`) first `pending` index, else -1; `label` = `"{done} of {total} done"`. Plan is replaced only by `plan.updated` / `snapshot` events (`applyPlanEvent`).

#### 3.0.6 Visualization — `shared/visualizations.ts`

```ts
export interface Visualization {
  id: string;           // UUID v4-ish, /^[a-f0-9]{8}-…-[a-f0-9]{12}$/
  title: string;
  description: string;
  html: string;         // self-contained fragment authored by the model
  mode: "inline" | "wide";
}
export interface VisualizationState {
  modelContent: unknown;
  privateContent: unknown;
}
```
`lib/visualization.ts`:
```ts
export type VisualPart =
  { type: "markdown"; text: string } | { type: "visualization"; id: string };
```

#### 3.0.7 Documents — `shared/assistant-capabilities.ts`, `lib/document-kind.ts`

```ts
export interface ConversationFile {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  mediaType: string;
  sourceId?: string;          // set on revised versions
  kind?: "visualization";
  title?: string;
  description?: string;
  mode?: "inline" | "wide";
}
export type DocumentKind = "code" | "text" | "sheet" | "slides" | "document";
```

#### 3.0.8 Errors — `lib/api.ts`, `shared/errors.ts`, `lib/goal-errors.ts`

```ts
export interface ErrorRef {
  code?: string;
  requestId?: string;
  // Stream errors have no request; the turn id matches agent-core's logs.
  turnId?: string;
}
export type ErrorReason =
  | "rateLimited" | "quota" | "credentials" | "providerDown" | "contextWindow" | "other";
export interface TurnFailure {
  reason: ErrorReason;
  message: string;
  httpStatus?: number;
}
```

---

### 3.1 Raw data → display entries (`lib/chat.ts`)

All functions are pure reducers over `Entry[]`.

`historyEntries(messages: Message[]): Entry[]` — builds entries from persisted history. Assistant messages go through `upsertMessage` with `final: true`, `itemId: runtimeItemId || itemId`, aliases `[itemId, runtimeItemId]`. User messages become `kind:"message"` entries with `final: true`, deduped by id.

`upsertMessage(list, value)` — identity-merging for assistant text. Candidates = assistant messages in the same `turnId`. Match order:
1. `itemId` or any alias matches an entry's `itemId`/`aliases`.
2. Same `messageIndex`.
3. Legacy fallback: one side missing identity, text equal, incoming is final.
4. If incoming is final or has no itemId and exactly one non-final (streaming) candidate is open, adopt it.

Rules: a delta arriving after the entry is `final` is ignored (replay protection). `append: true` concatenates deltas. Aliases are unioned. Never compares text across turns.

`mergeHistoryEntries(messages, live)` — merges a history fetch with events that arrived while it was in flight: approvals via `addApprovals`; assistant messages re-applied as a snapshot; for existing ids a live command state of `succeeded|failed` replaces a saved `running|unknown`; thinking entries are inserted before their turn's first assistant message; everything else appended.

`addApprovals(list, records)` — each record becomes `approval:{requestId}`; replaced in place if present, otherwise inserted right after the last entry of the same `turnId` (or at the end).

`addHelpers(list, turnId, threadIds)` — each helper thread id appears in exactly one `agents` block (the turn that first reported it). New ids append to `agents:{turnId}` or create that block at the end.

`applyChatEvent(list, event: DomainEvent)` — event handling:

| Event `type` | Effect |
|---|---|
| `approval.resolved` | `addApprovals` with `data.audit` |
| `subagent.spawned` / `subagent.status` / `subagent.completed` | `addHelpers(turnId, [data.agent.threadId])` |
| `snapshot` | helpers from `data.subAgents` (placed with `data.state.turnId` or latest turn); `data.thinking[]` upserted as thinking entries before the turn's answer; `data.messages[]` upserted (`final: m.final !== false`); if `data.state.kind === "idle"` all thinking → `done` |
| `message.delta` | `upsertMessage` with `append`, `final:false`, text = `data.delta` |
| `message.final` | `upsertMessage` with `final:true`, text = `data.text` |
| `turn.completed` | thinking and assistant messages of that turn → `done: true` |
| `reasoning.delta`, `item.started`/`item.completed` with `item.type === "reasoning"` | thinking upsert. Two channels kept separate: summary (default) and raw (`data.method === "item/reasoning/textDelta"`). `text = raw \|\| summary`. On item events, summary = `item.summary.join("\n")`. `done` on `item.completed`. Deltas after done ignored. New thinking inserted before the turn's first non-thinking, non-user entry. |
| `item.started`/`item.completed` other types (not `agentMessage`/`userMessage`) | `kind:"item"` entry `item:{turnId}:{id}` upserted/appended |

`visibleEntries(entries)` — hides a "shadow" streaming assistant message when a final message in the same turn starts with the same text (some providers replay). Two completed messages stay distinct even if identical.

Grouping in `ChatMessages` (render-time):
- Filters `visibleEntries(entries)` and drops all `kind:"item"` entries (runtime tool items are not rendered in the chat stream; see 3.6).
- Each user message starts its own group `{ id, user, entries: [] }`.
- Every other entry joins the previous non-user group if it has the same `turnId`, else starts a new response group `{ id, turnId, entries }`.
- Inside a response group, `thinking` entries are merged into one `ThinkingBlock` (texts joined with `\n\n`); remaining entries (`message`, `approval`, `agents`) render in order.
- A turn's usage receipt goes under its last response group only; the goal-timeline anchor id `turn-{turnId}` goes on its first response group.

Text post-processing per assistant message (in order):
1. `splitSuggestions(text, streaming)` → body with the trailing `[truex-suggestions] … [/truex-suggestions]` block removed (max 3 items, ≤160 chars; fence-aware).
2. `splitVisualizations(body, streaming)` → `VisualPart[]`. A line matching `^ {0,3}\[truex-visualization:<uuid>\]\s*$` outside code fences (``` or ~~~, length-aware) becomes a visualization part. While streaming, a partial trailing `[truex-visualization:…` line is withheld to avoid flicker.
3. Markdown parts render via `react-markdown` + `remark-gfm`.

---

### 3.2 ChatMessages

- File: `frontend/components/chat-messages.tsx`
- Parent: `app/page.tsx` inside `div.scroll > div.thread`
- Purpose: renders the whole conversation stream as user bubbles and grouped agent responses.

Props:
```ts
{
  entries: Entry[];
  agentName: string;
  /** Agent colour for the avatar; defaults to --accent-soft-2. */
  agentHue?: string;
  running: boolean;
  onCommand?: (text: string) => void;
  onOpen?: (id: string) => void;
  onRefresh?: () => void;
  sessionId?: string;
  onPrompt?: (text: string) => void;
  goal?: Goal | null;
  goalReview?: GoalReview | null;
  subAgents?: SubAgentState;           // default emptySubAgents
  onOpenAgent?: (threadId: string) => void;
  onSuggest?: (question: string) => void;
  suggestionsEnabled?: boolean;        // default true
  traces?: TurnTrace[];                // default []
  liveUsage?: Record<string, TurnUsage>; // default {}
}
```
Page wiring: `onPrompt`/`onCommand` put text into the composer and focus it (they do not send); `onOpen(id)` opens a session (branch); `onRefresh` reloads the current session; `onSuggest` = `askSuggestion` (sends); `suggestionsEnabled = !busy && !goalMode && !failure && !pending.length`.

Markup:
- Root `div.chat-messages`.
- User: `article.msg.user#request-{id}[aria-label="Your message"] > div.bubble-wrap > [span.goal-tag] + div.bubble + [span.msg-note.muted.sm]`. `goal-tag` shows `commandLabel(method)` with a `target` icon when method starts with `thread/goal/`. Bubble text is plain text (no markdown).
- Agent: `article.msg.agent[aria-label="{agentName} response"][id=turn-{turnId}][tabIndex=-1 when anchored]` → `span.agent-avatar` (inline `background: agentHue || var(--accent-soft-2)`, `spark` icon 13px) + `div.grow` → `div.msg-meta > span.strong{agentName} [+ span.muted.sm "thinking…"]`, then items.
- Answer: `div.answer.markdown` containing markdown/visual parts and `span.caret` while streaming.
- Working indicator: `ul.steps[role=status] > li > span.spinner + "Working"`.

Visual states:
| State | Condition | Output |
|---|---|---|
| Empty conversation | handled by page (`empty`) | `<Hero>` with composer, not ChatMessages |
| Waiting for first output | `running` and last group is a user message (or none) | placeholder `div.msg.agent` with "thinking…" meta + Working row |
| Thinking streaming | active group, no answer text, some thinking not done | "thinking…" meta + ThinkingBlock with spinner |
| Working (no thinking) | active, no answer text, all thinking done | "thinking…" meta + Working row |
| Answer streaming | active, message `!final && !done` | markdown + blinking `span.caret` |
| Answer complete | `final` or `done` | markdown only; suggestions may appear |
| User message pending | `delivery === "pending"` | note "Sending…" |
| User message unconfirmed | `delivery` ∉ {accepted, pending} | note "Delivery unconfirmed" |
| Follow-up (steer) | `steer` | note "Follow-up" (joined with " · ") |
| Visualization w/o session | `sessionId` missing | `<p>Open this conversation to view the visualization.</p>` |
| Receipt | turn has a trace and is not active | `<TurnReceipt trace sessionId>` |
| Live usage | active and `liveUsage[turnId]` | `<LiveUsage usage>` |
| Suggested questions | `onSuggest && suggestionsEnabled && !running && last group && last answer final` | `<SuggestedQuestions questions onSelect>` |

"Active" = `running && index === groups.length - 1`. "Answering" = any content message has non-empty text.

Markdown / code: `react-markdown` with GFM (tables, task lists, strikethrough, autolinks). No syntax highlighting and no copy button on code blocks; there is no message-level copy/retry/edit action in the stream. Code fences are respected when parsing visualization and suggestion markers.

---

### 3.3 ThinkingBlock

- File: `frontend/components/thinking-block.tsx`
- Parent: ChatMessages (agent group)
- Purpose: reasoning shown as one collapsible row of the `.steps` list.

Props:
```ts
{ text: string; streaming?: boolean }
```
Markup: `ul.steps.thinking[data-open] > li[.is-done] > button.step-toggle[aria-expanded][aria-controls]` containing either `span.spinner` (streaming) or `span.step-mark` with a check icon, `span.grow "Thinking"`, word count `span.mono.sm.muted "{n} word(s)"` (only when not streaming), and `chevronR` icon `.step-caret`. Body: `li.thinking-body#{useId}[hidden=!open]` showing text or "Thinking…".

States: returns `null` when text is empty and not streaming; streaming (spinner, no count); done (`li.is-done`, check, count); collapsed (default) / expanded (local `open` state toggled by click). Plain text body, no markdown.

---

### 3.4 CommandResult (+ `commandLabel`)

- File: `frontend/components/command-result.tsx`
- Parent: ChatMessages, directly after a user message with `command`.
- Purpose: result card for slash commands (goal, fork, compact, settings, archive, help).

```ts
export function commandLabel(method: string): string
// "help" → "Chat commands"; "thread/goal/*" → "Goal";
// "thread/fork" → "Conversation branch"; "thread/compact/start" → "Context";
// "thread/settings/update" → "Settings"; "thread/archive" → "Archive";
// "thread/unarchive" → "Restore"; else "Command"

props: {
  command: CommandRecord;
  currentGoal?: Goal | null;
  goalReview?: GoalReview | null;
  onCommand?: (text: string) => void;
  onOpen?: (id: string) => void;
  onRefresh?: () => void;
}
```
Markup: `section.command-result.command-{state}[aria-label="{label} result"] > header > span.eyebrow + span.ag-chip[role=status]`, then `p` summary, `p[role=alert]` error, `dl` details, `div.command-actions` of `button.btn-soft`.

State chip:
| `state` | Text | Chip class |
|---|---|---|
| running | Awaiting confirmation (+ spinner) | `is-running` |
| succeeded | Confirmed | `is-done` |
| failed | Failed | `is-warn` |
| unknown | Unconfirmed | `is-stopped` |

Succeeded summaries: help text; "Goal cleared."; goal objective or "No goal is set."; "Your new conversation branch is ready."; "Context compaction requested. Completion will appear in the conversation activity."; "Conversation archived."; "Conversation restored."; else "Conversation settings updated." Running adds "Waiting for the command result."

Details `dl`: for goals — Status (live via `goalStateLabel` if this card is the current goal per `sameGoal`, else "Status at this update" from `goalStatus[status].label`), Time spent, Tokens used, Token budget. For settings — Model, Reasoning effort.

Actions: live goal → "Check goal status" (`onCommand("/goal show")`), "Clear goal…" (`onCommand("/goal clear")`); `result.sessionId` → "Open conversation branch" (`onOpen`); running/unknown → "Check saved result" (`onRefresh`).

---

### 3.5 ApprovalRecordView

- File: `frontend/components/approval-record.tsx`
- Parent: ChatMessages (entry kind `approval`)
- Purpose: read-only audit line of a resolved request, kept after the RequestCard disappears.

```ts
props: { record: ApprovalRecord | ModeRecord }
```
Markup: `div.approval-record[role=group aria-label="Your decision"]` → rows `div.approval-record-row > span.approval-record-dot.approval-record-{tone} + span.approval-record-body`; footer `time.approval-record-time[dateTime]` "{summary} at {h:mm}".

Tool approval row: title `span.approval-record-title` = `action || "Connected business service"`; badge `span.approval-record-badge.approval-record-{tone}` from `decisionLabel`:

| decision | text | tone |
|---|---|---|
| allowedOnce | Allowed once | allowed |
| allowedSession / allowedChat | Allowed for this chat | allowed |
| allowedAlways | Always allowed | allowed |
| declined | Not allowed | declined |
| expired | No answer — timed out | muted |
| interrupted | No answer — stopped | muted |

If `outcome === "auto"` and `autoMode` set, non-declined badges become (tone allowed): readOnly "Auto-allowed (read-only)", auto "Auto-accepted (Autopilot)", grant "Allowed for this chat".

Question row: dot always `approval-record-muted`; `span.approval-record-question` + `span.approval-record-answer`. Answer = "Answer hidden" if `secret`; answer text (with " (chosen by Autopilot)" or " (chosen automatically, no reply in time)" when `outcome === "auto"`); "" if answered with no text; else "No answer".

Footer summary (`recordSummary`): answered → "You answered"; auto → auto-mode label or "Recommended option chosen"; else "Closed". Footer omitted if `at` is missing/invalid.

---

### 3.6 RuntimeItem

- File: `frontend/components/runtime-item.tsx`
- Parent: none currently. `ChatMessages` filters out `kind:"item"` entries and no other file imports `RuntimeItem`. It is dead UI today but documents the tool-call shapes the stream carries.
- Purpose: collapsible view of a Codex runtime item (command, file change, MCP tool call).

```ts
props: { item: any }
// fields read:
//  item.type: "commandExecution" | "fileChange" | "mcpToolCall" | other
//             ("agentMessage" | "userMessage" | "reasoning" → returns null)
//  item.status?: string
//  commandExecution: item.command: string, item.aggregatedOutput?: string, item.exitCode?: number | null
//  fileChange: item.changes?: { path: string; diff?: string; kind: unknown }[]
//  mcpToolCall: item.server: string, item.tool: string
```
Markup: native `details.runtime-item.runtime-{type} > summary > [lucide icon 14] + b{label} + span{status}`. Icons: Terminal (command), FileDiff (file change), Wrench (other). Labels: "Command", "File changes", "{server} · {tool}", or raw type. Bodies: command → `code` + `pre` output ("Waiting for output…") + `small "Exit code N"`; file change → `section > b{path} + pre{diff | JSON(kind)}` per change; other → `pre` pretty JSON. Collapsed by default (native details).

---

### 3.7 RequestCard (PlanApprovalCard, QuestionCard)

- File: `frontend/components/request-card.tsx`
- Parent: `app/page.tsx`, one per `pending` request, rendered after `<ChatMessages>` in `.thread`.
- Purpose: live, answerable approval/question prompts with an expiry countdown.

```ts
export function RequestCard(props: {
  request: PendingRequest;
  onAnswer: (value: unknown) => Promise<void>; // page: transport.answer(sessionId, requestId, value)
  plan?: PlanStep[];                            // default []
})
```
Routing: `method === "item/tool/requestUserInput"` with exactly one question whose id is `plan_approval` → `PlanApprovalCard`; otherwise `QuestionCard` (which returns `null` for any other method).

Shared internals: `useExpiry(expiresAt)` ticks on the shared 1s clock (`useClock`) → `{ expired, remaining }`. `ExpiryTimer` → `span.request-card-timer "Expires in <LiveDuration trend=-1>"`, hidden once expired. Send errors use `answerErrorMessage`: 409 "This was already answered."; 404/410 "This request is no longer available."; else "Your answer could not be sent. Please try again." Errors render `p.request-error[role=alert]` + `<ErrorRef>`.

#### PlanApprovalCard
Props: `{ request: PendingRequest; question: InputQuestion; plan: PlanStep[]; onAnswer }`.
Markup: `form.request-card.plan-approval[aria-busy][aria-labelledby]` → `header.request-card-head` (`span.request-card-icon` check icon, `h3 "{header||"Plan"} ready for review"`, timer), `p.plan-approval-question`, `<PlanSteps>` or `p.muted "The drafted steps are in the message above."`, `fieldset.request-question[disabled=locked]` with `div.request-approval-actions.plan-approval-actions`.

States/interactions:
- Default: `button.btn-solid[type=submit] "Approve plan"` + `button.btn-soft "Revise"`.
- Revising: `label.plan-feedback-label "What should change?"` + `textarea.request-text.plan-feedback` (3 rows, autofocus, placeholder "For example: split step 2, skip the report"); ⌘/Ctrl+Enter sends Revise, Escape cancels; buttons "Send feedback" (disabled until non-blank) and `btn-ghost "Cancel"`.
- Sending: clicked button label becomes "Sending…", fieldset disabled, `aria-busy`.
- Expired: controls locked, `p.request-expired[role=status] "No reply in time. Continuing with the recommended option."`.
- Error: alert + ErrorRef.
Emits `onAnswer(planApprovalPayload("Approve" | "Revise", feedback))`.

#### QuestionCard
Props: `{ request: PendingRequest; onAnswer }`.
Local state: `answers: Record<string,string>`, `other: Record<string,boolean>`, `sending: string|null`, `missing: string[]`, `step: number`. Multi-question requests are one question at a time; focus moves to the new fieldset on step change.

Markup: `form.request-card[.request-card-approval]` → `header.request-card-head` (`span.request-card-icon` shield SVG for approvals / question-circle SVG otherwise; `h3` title; `span.request-step "{n} of {total}"` when >1; timer) → `fieldset.request-question[tabIndex=-1][aria-invalid]` with `legend` (`span.request-question-header` when multi) → body → `div.request-submit`.

Title: "Permission needed" (any `toolApproval` question) / the sole question's `header` / "Your input is needed".

Question variants:
- Tool approval (`kind:"toolApproval"`): `p.request-action > span.request-action-label "Action" + action`; options as `div.request-approval-actions` buttons — first `btn-solid`, `Cancel` → `btn-ghost`, others `btn-soft`; `title=description`. Display labels: Allow → "Allow once", "Allow for this session" → "Allow for this chat", "Allow and don't ask me again" → "Always allow", Cancel → "Don't allow" (submitted value stays the original label).
- Multiple choice: `div.request-options[role=group]` of `button.request-option[aria-pressed]` with `span.request-option-label` + `span.request-option-description`; `isOther` adds `button.request-option.request-option-other` "Something else…" / "Type your own answer".
- Free text (no options, or "Something else" picked): `input.request-text` (`type=password` only when `isSecret === true`; placeholder "Enter a value" / "Type your answer").

Flow: single question with options answers on click (`answersOnClick`). Otherwise picking advances to next; on the last question it sends if all answered, else jumps to the first unanswered with `p.request-error[role=alert]` "Question X of N needs an answer before you can send." / "This question needs an answer before you can send.". Footer `div.request-submit`: `btn-ghost "Back"` (step > 0) and `btn-solid` "Next" / "Send answer" / "Sending…" (shown for typed answers or after stepping back).

Expired: controls locked; message "This question has expired. Send a message to continue." for approvals or secret questions (they are declined), else "No reply in time. Continuing with the recommended option.". Footer hidden.

After resolution the card disappears (request leaves `pending`) and an `approval.resolved` event inserts an `ApprovalRecordView` into the stream.

---

### 3.8 PlanSteps / StepMark

- File: `frontend/components/plan-steps.tsx`
- Parents: `PlanApprovalCard` (request-card.tsx), `PlanPanel` (session-activity.tsx); `StepMark` is also exported for goal checkpoints.

```ts
export function StepMark(props: { state: "done" | "current" | "pending" })
export function PlanSteps(props: { plan: PlanStep[] })
```
StepMark: `span.step-mark[.is-done]` → check icon (done) / `span.spinner` (current) / `span.cp-dot` (pending).
PlanSteps: `ol.pl-list > li.pl-item[.is-done][.is-current][aria-current=step]` → StepMark + `div.pl-label{step}` + `div.pl-status`. Status labels: completed "Done", current "In progress", pending "Pending". Status is conveyed by mark + text, never colour alone. Read-only.

---

### 3.9 Visualization

- File: `frontend/components/visualization.tsx`; helpers `frontend/lib/visualization.ts`
- Parents: ChatMessages (inline visual refs), AssistantTools (saved visuals list)
- Purpose: sandboxed, interactive, model-authored HTML widget.

```ts
props: { sessionId: string; id: string; onPrompt?: (text: string) => void }
```
Loads `GET /api/sessions/{sessionId}/visualizations/{id}` → `Visualization`. Restores saved widget state from `localStorage["truex-visualization:{sessionId}:{id}"]` (validated: only `modelContent`/`privateContent` keys, ≤16 KiB).

Rendering: `visualizationDocument()` wraps `visual.html` in a full document with a strict CSP (no network, no frames, inline scripts/styles only, `img-src data:`), theme tokens via `light-dark()` (`--background`, `--foreground`, `--muted-foreground`, `--border`, `--primary`, `--destructive`, `--viz-series-1..6`, etc.), utility classes (`.btn`, `.btn-primary`, `.form-control`, `.form-select`, `.form-range`, `.viz-row`, `.viz-controls`, `.viz-grid`, `.text-small`, `.text-muted`, `.tabular-nums`, `.sr-only`), reduced-motion override, and a `window.openai` bridge (`widgetState`, `setWidgetState`, `sendFollowUpMessage`). Shown in `iframe[sandbox="allow-scripts"][referrerPolicy=no-referrer]` with all device permissions denied.

Chart types: there is no fixed chart schema or library. The model writes native SVG/canvas/HTML (no CDN, no preloaded libraries); `mode` is only `"inline" | "wide"` (`figure.visualization-inline` / `figure.visualization-wide`).

postMessage protocol (from iframe, `channel: "truex-visualization"`, origin `"null"`):
| type | effect |
|---|---|
| ready | clears 12s timeout, `loaded = true` |
| error | runtime error notice |
| resize `{height}` | iframe height = clamp(height+4, 160, 900); default 360 |
| state `{state}` | saved to ref + localStorage |
| followup `{prompt, title}` | shows follow-up proposal (prompt ≤2000 chars, title ≤250) |

Markup: `figure.visualization.visualization-{mode} > figcaption > strong{title} + p{description}` then controls, status, iframe, follow-up. Expanded view moves them into `dialog.visualization-dialog` (modal via `showModal`, with `h2` title; Escape/close collapses).

Controls `div.visualization-controls` (`btn-soft`): "Expand" / "Close expanded view", "Reload visual" (rebuilds srcdoc), "Download HTML" (`truex-visualization.html` via `visualizationExport`, standalone wrapper), "Ask about this visual" (only with `onPrompt`; puts "Explain the current view and selected values." + visual title/ID + selected values into the composer).

Follow-up: `div.visualization-question > strong{title} + p{prompt}` + `btn-solid "Add to my message"` (disabled without onPrompt) + `btn-soft "Dismiss"`.

States: loading "Loading visual…" (`p[role=status]`); fetch error `div.visualization-error[role=alert] "This visual could not be loaded. {error}"`; preparing "Preparing visual…"; runtime error / 12s timeout "The visual may not have rendered correctly. Try reloading or ask Truex to revise it."; loaded; expanded/collapsed.

---

### 3.10 AssistantTools (documents & saved visuals)

- File: `frontend/components/assistant-tools.tsx`
- Parent: `app/page.tsx` (~L1556, side panel)
- Purpose: capability shortcuts, conversation document upload/list, saved visualizations, quick tools.

```ts
props: {
  sessionId?: string;
  refreshKey: number;
  running: boolean;
  onPrompt: (text: string) => void;
  onFork: (id: string) => void;
}
```
Data: `GET /api/sessions/{id}/documents` → `{ files: ConversationFile[]; available: boolean; visualizationAvailable: boolean }`. Refetch on `sessionId`/`refreshKey`.

Sections (`div.assistant-tools > div.assistant-tools-body`):
- Capabilities: `div.capability-grid` buttons from `assistantCapabilities` (`strong` name + `span` description) → `onPrompt(capability.prompt)`.
- Documents `section.conversation-documents`: no session → "Send your first message to start a conversation, then upload documents here."; not available → "Start a new conversation to enable document tools."; else `label.document-upload` with hidden file input (accept `uploadAccept`, disabled while busy/running; label "Uploading…" while busy), help text "PDF, Word, Excel, PowerPoint, text, or code · 1 MB per file. …", "Refresh documents" (outline Button). Upload: >1 MB rejected "Choose a document of up to 1 MB."; base64 POST; then `onPrompt('Read the uploaded document "{name}" and summarize its key points.')`.
- Document rows `div.document-row`: `DocumentIcon` + `strong{name}` + `small "{kind label} · {KB} KB[ · Revised version]"` + "Discuss" button (`onPrompt('Read the document "{name}" (file ID {id}) and help me with: ')`) + download link `GET {base}/api/sessions/{id}/documents/{fileId}`.
- Visualize `section.conversation-visualizations`: availability note, hint text, rows of visualization files with "Open visual"/"Hide visual" toggling an inline `<Visualization>`.
- `<QuickTools>` (outside slice) when a session exists.
- Error `p.error-banner[role=alert]`.

---

### 3.11 DocumentIcon & document kinds

- Files: `frontend/components/document-icon.tsx`, `frontend/lib/document-kind.ts`
- Parent: AssistantTools rows.

```ts
export function DocumentIcon(props: { name: string; size: number }) // decorative
export function documentKind(name: string): { kind: DocumentKind; label: string }
export const uploadAccept =
  ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.abap,.cds,.json,.xml,.yaml,.sql,.js,.ts";
```
Icon map (v2 icons): sheet → `table`, slides → `chart`, code/text/document → `doc`.

| Extension | Kind | Label |
|---|---|---|
| pdf | document | PDF |
| docx | document | Word |
| xlsx | sheet | Excel |
| pptx | slides | PowerPoint |
| csv / tsv | sheet | CSV / TSV |
| txt / md | text | Text / Markdown |
| abap, cds, js, ts, json, xml, yaml/yml, sql, html, properties, java, py, sh | code | ABAP, CDS, JavaScript, TypeScript, JSON, XML, YAML, SQL, HTML, Properties, Java, Python, Shell |
| other | document | uppercased extension, or "File" |

Note: `uploadAccept` is narrower than the recognized list (no html/java/py/sh/yml/properties uploads).

---

### 3.12 ErrorRef

- File: `frontend/components/error-ref.tsx`
- Parents: RequestCard (both cards), `app/page.tsx` bottom `div.error-banner`.
- Purpose: muted support reference with copy.

```ts
props: { value: ErrorRef | null | undefined }
```
Renders nothing if no `code`, `requestId` or `turnId`. Text = `[code, requestId ?? turnId].join(" · ")`. Markup: `span.error-ref > span.error-ref-text.mono "Ref: {text}" + button.link.error-ref-copy + span.sr-only[role=status]`. Copy states (reset after 2s): "Copy" → "Copied" (SR: "Reference copied") or "Select to copy" if clipboard blocked.

Page error banner: `div.error-banner[role=alert] > span.error-banner-body{error + ErrorRef} + button[aria-label="Dismiss error"] "×"`.

---

### 3.13 Turn error presentation (`lib/goal-errors.ts`)

Used by SessionActivity (`failedLabel`), GoalBar and GoalReason (outside slice).

| ErrorReason | label | hint | action |
|---|---|---|---|
| rateLimited | Rate limited | The model provider is limiting requests right now. Wait a moment, then resume. | resume |
| quota | Out of credits | The model provider account has no usage or credits left. | — |
| credentials | Access denied | The model provider rejected the configured credentials. | — |
| providerDown | Provider unavailable | The model provider is unavailable or the connection dropped. Resume to try again. | resume |
| contextWindow | Conversation too long | …Compacting summarizes earlier turns so the work can continue. | compact |
| other | Stopped by an error | "" | resume |

`providerTip(provider, reason)` adds provider-specific guidance for `quota`/`credentials` (OpenRouter, Bedrock/AWS, OpenAI, Anthropic, Gemini/Google/Vertex, fallback "Ask your administrator…"). `turnFailure(error)` normalizes `{reason, message, httpStatus}` (unknown reason → `other`). `goalFailure(status, failure)` only returns a failure while goal status is `blocked` or `usageLimited`. Failed turns are not rendered as a distinct chat item; they surface in the page error banner, goal bar, and the activity timeline.

---

### 3.14 LiveDuration

- File: `frontend/components/live-duration.tsx`
- Parents: RequestCard `ExpiryTimer` (countdown), other goal/agent components.

```ts
props: { ms: number; className?: string; trend?: 1 | -1 } // 1 elapsed, -1 countdown
```
`time.live-duration[dateTime="PT{h}H{m}M{s}S"]` with `span.visually-hidden` plain text (`formatDuration`) and aria-hidden `span.live-duration-digits` of `@number-flow/react` rolling digits (`m:ss` or `h:mm:ss`, tens digit capped at 5). Attribution to Skiper UI required (comment in file).

---

### 3.15 SessionActivity

- File: `frontend/components/session-activity.tsx`
- Parent: `app/page.tsx` (~L1479) inside `.panel.activity`
- Purpose: side panel with tabs Activity, Agents, Goal, Plan, Insights.

```ts
export const SESSION_TABS = ["activity","agents","goal","plan","insights"] as const;
export type SessionTab = (typeof SESSION_TABS)[number];

props: {
  events: DomainEvent[];
  plan: PlanStep[];
  awaitingApproval?: boolean;
  timings: TurnTiming[];
  traces?: TurnTrace[];
  traceSummary?: TraceSummary | null;
  rateLimits?: RateLimitView | null;
  liveUsage?: TurnUsage | null;
  sessionId?: string;
  goal: Goal | null;
  goalReview: GoalReview | null;
  tab?: SessionTab | string;
  onTab?: (tab: SessionTab) => void;
  subAgents?: SubAgentState;
  delegation?: DelegationPrefs;
  onDelegation?: (prefs: DelegationPrefs) => void;
  agentName?: string;
  open?: boolean;            // false → header buttons/tabs leave tab order
  wide?: boolean;
  onToggleWide?: () => void;
  onClose?: () => void;
  onDetailChange?: (open: boolean) => void;
  follow?: boolean;
  onFollow?: (on: boolean) => void;
}
```
Header `div.p-head`: pulse icon, `h2.p-title "Session activity"`, `button.icon-btn.ghost.p-follow[aria-pressed]` (Follow activity, spark icon), `button.p-size` expand/shrink, close `x`.
Tabs `div.tabs[role=tablist]` with `button.tab[.is-active][role=tab]`; arrow keys / Home / End navigate. Badges: Agents `span.tab-count[.is-live]` (running count or total), Goal `span.tab-dot` when goal active, Plan `span.tab-count "{done}/{total}"`. Panel `div.activity-body#session-tabpanel[role=tabpanel]`; non-activity tabs remount on switch.

ActivityTab: running = last `turn.started` after last `turn.completed`.
- `div.live-head`: `span.pulse[.idle]`, `span.live-title[role=status]` "Working"/"Idle", `span.live-meta` ("Goal in progress" / agent name / "Waiting for a request").
- Running `div.live-card > div.live-row`: `span.tile` icon (target/doc), current plan step or latest `activity.updated` label or "Working on your request"; sub-line "Waiting for your approval" / "Step X of N · label" / "Started {time}"; `span.live-pct` + `div.bar[role=progressbar]` when a plan exists.
- Idle with a last run: "Last run: {label}", "Completed in {duration}" or "Finished {time}", " · X of N steps", 100% bar.
- `div.section-head > span.eyebrow "Recent"` + `button.link` "View all"/"Show less" when >8 rows.
- `ol.timeline > li.tl-row`: `span.tl-dot[.is-bad]` icon, `span.tl-title`, `span.tl-meta` (duration or "Helper agent"), `time.tl-time` ("4:53 PM" / "Yesterday" / "Sep 3"). Empty: `p.tl-empty "Business activity will appear here."`.
- Event labels: turn.completed → "Request finished" / "Request stopped" / "Request failed[: {label}. {hint}]"; error → "Retrying…" or failure label; subagent.spawned "Started a helper", completed "Helper finished", status "Helper status changed"; else `data.label` or "Activity". Icons: check/stop/x, pulse (retry), bot (helpers), and label keyword matches → chart, globe, table, doc, plug, default pulse.

PlanPanel: empty `div.empty-tab` ("No plan yet" / "When the assistant breaks a request into steps, they appear here."); else `section.pl > div.pl-head` (`h3 "Plan"`, live region with `span.ag-chip.is-warn "Awaiting approval"` or progress label), progress bar, `<PlanSteps>`.

Agents tab: `<AgentsPanel>` + `fieldset.delegation` (radio "Only when I ask" / "Whenever it helps", select "Max helpers at once" 1–5), hidden while a helper detail view is open. Goal tab: `<GoalTimeline>`. Insights tab: `<InsightsPanel>` (outside slice).

---

### 3.16 useFollowActivity (follow behaviour)

- File: `frontend/lib/use-follow-activity.ts` (logic in `lib/auto-tab.ts`)
- Consumer: `app/page.tsx` (~L170), feeding SessionActivity `follow`/`onFollow`.

```ts
export function useFollowActivity(options: {
  panelOpen: boolean;
  vw: number;
  fitsOpen: boolean;     // opening the panel would leave an open sidebar in place
  tab: string;
  showTab: (tab: FollowTab, open: boolean) => void;
}): {
  onEvent(event: DomainEvent): void;
  reset(): void;          // new conversation
  manual(): void;         // user picked a tab
  dismiss(): void;        // user closed panel; stays closed until next turn.started
  enabled: boolean;
  setEnabled(next: boolean): void; // persisted via writeFollow
  announce: string;       // "Session activity is showing the {Goal|Plan|Agents} tab."
}
export type FollowTab = "goal" | "plan" | "agents";
```
Events that start a goal, plan, or helper request a tab; requests within `FOLLOW_BATCH_MS = 300` ms coalesce (rank goal < plan < agents, most specific wins). A manual tab pick holds for `MANUAL_HOLD_MS = 8000` ms. No switch while the pointer is over or focus is inside `.panel.activity`. `followAction` returns `"switch"`, `"open"` or `null`.

Chat follow-scroll (separate, in `app/page.tsx`): the `.scroll` container tracks `following = scrollHeight - scrollTop - clientHeight < 80` on scroll; when `entries` or `pending` change and following is true it jumps to the bottom (`behavior: "instant"`). Scrolling up more than 80px stops auto-follow; returning near the bottom resumes it. There is no "jump to latest" button.

---

### 3.17 Components referenced but outside this slice

`HelperGroup` (helper agent block, props `{ id, threadIds, state: SubAgentState, sessionId?, onOpenAgent? }`), `SuggestedQuestions` (`{ questions: string[]; onSelect }`), `TurnReceipt` (`{ trace: TurnTrace; sessionId? }`), `LiveUsage` (`{ usage: TurnUsage }`), `QuickTools`, `GoalTimeline`, `AgentsPanel`, `InsightsPanel`, `GoalBar`, `GoalReason`, `Hero`, v2 `Icon`.

### 3.18 Gaps a redesign should know about

- No copy, retry, edit, or regenerate actions on messages.
- No syntax highlighting or copy button for code blocks.
- Runtime tool items (commands, file changes, MCP calls) are tracked as entries but never shown in the chat; `RuntimeItem` is unused.
- Pending request cards always render below the whole stream, not inline with their turn.
- Failed turns have no inline chat item; failure shows in the bottom error banner and activity timeline.
- User bubbles are plain text (no markdown).


## 4. Goals

One goal per conversation. The assistant (Codex runtime) works toward it across turns until it is done, paused, stopped by an error, or out of token budget. The assistant marks it `complete`; the user then accepts the result or reopens it with feedback. Intent and status: `docs/GOAL_FEATURE_STATUS.md` (updated 2026-09-28; browser click-through of the newer goal controls is listed as not yet done).

Surfaces:

| Surface | Component | Where it mounts |
|---|---|---|
| Composer goal mode (drafting) | `Composer` (`goalMode` props) + `BudgetField` | `frontend/app/page.tsx` composer form |
| Pinned goal bar | `GoalBar` | `page.tsx`, `.bottom` dock, above the composer, only when `session && goal` |
| Stop reason | `GoalReason` | inside `GoalBar` |
| Completion card | `GoalCompletion` | inside `GoalBar` review panel |
| Goal tab | `GoalTimeline` | `components/session-activity.tsx`, when `panel === "goal"` |
| Chat command cards | `goal-tag` in `chat-messages.tsx`, `CommandResult` in `command-result.tsx` | chat transcript |

---

### 4.0 Data model

All from `shared/contracts.ts` unless noted.

```ts
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

// Public projection of the runtime goal. Timestamps are runtime epoch values.
export interface Goal {
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number | null;   // identifies the goal (objective edits keep it)
  updatedAt: number | null;
  // Tokens Truex counted for this goal. The runtime's tokensUsed misses usage
  // reported after a goal completes, so the UI shows the larger of the two.
  tokensObserved?: number;
}

// Summary kept on the session for the conversation list.
export interface SessionGoal {
  objective: string;
  status: GoalStatus;
  updatedAt?: string;
  createdAt?: number | null;
  tokensObserved?: number;
  tokenBudget?: number | null;
  goalUpdatedAt?: number | null;   // Codex's updatedAt (epoch seconds)
  goalEventAt?: string;            // agent-core event time
}

// One change in the conversation's goal, for the goal timeline.
export interface GoalHistoryEntry {
  at: string;
  kind: "set" | "objective" | "budget" | "status" | "accepted" | "reopened" | "cleared";
  objective: string;
  status?: GoalStatus;
  tokens?: number;
  tokenBudget?: number | null;
  feedback?: string;
  turnId?: string;      // turn that made the change, when known
  tokensUsed?: number;  // Codex's own token count at that moment
}

// The agent marks a goal complete; the user confirms or reopens it.
export interface GoalReview {
  objective: string;
  goalCreatedAt: number | null;
  decision: "accepted" | "reopened";
  feedback?: string;
  at: string;
}

// Session fields (Session interface)
goal?: SessionGoal;
goalReview?: GoalReview;
goalCleared?: { createdAt: number | null; eventAt?: string }; // blocks replayed older updates
goalHistory?: GoalHistoryEntry[];   // server keeps last 60 (GOAL_HISTORY_LIMIT)

// Command records carry the goal result
export interface CommandRecord {
  method: string;
  params: Record<string, unknown>;
  state: "running" | "succeeded" | "failed" | "unknown";
  afterMessageId?: string;
  result?: { help?: string; goal?: Goal | null; sessionId?: string };
  error?: string;
}
// Live events: "goal.updated" (payload { goal }) and "goal.cleared".
```

#### Status display table (`frontend/lib/goal.ts` `goalStatus`)

```ts
Record<GoalStatus, { label: string; hint: string; tone: "good" | "neutral" | "warn" }>
```

| Status | Label | Tone | Hint |
|---|---|---|---|
| `active` | In progress | good | The assistant is working toward this goal. |
| `paused` | Paused | neutral | Resume the goal when you want the assistant to continue. |
| `blocked` | Needs input | warn | The assistant stopped. It needs your input or hit an error; check the latest reply, then resume the goal. |
| `usageLimited` | Usage limit reached | warn | Work stopped because model usage ran out. Resume once usage is available again. |
| `budgetLimited` | Budget reached | warn | The token budget is used up. Extend it to let the assistant keep going. |
| `complete` | Complete | good | The assistant marked this goal complete. |

Derived user-facing states (`goalStateLabel`):
- "Accepted": `goalAccepted()` = status `complete` AND `review.decision === "accepted"` AND review objective and `goalCreatedAt` match the current goal.
- "Ready for review": `awaitingReview()` = status `complete` and not accepted.
- Otherwise the label from the table.

#### Budget rules (`lib/goal.ts`)

- `MAX_TOKEN_BUDGET = 10_000_000`
- `parseTokenBudget(text)`: accepts `50000`, `50,000`, `50_000`, `50k`; positive safe integer up to 10M, else `null`.
- `budgetHelp = "Enter a whole number of tokens, like 50000 or 50k (up to 10M)."`
- `budgetOptions`: No budget (`null`), 25k tokens, 100k tokens, 250k tokens, plus "Custom…" in `BudgetField`.
- `budgetExtensions = [25_000, 50_000]`
- `extendedBudget(goal, extra) = min(10M, max(tokenBudget ?? 0, tokensUsed) + extra)`
- Budget bar uses Codex `tokensUsed / tokenBudget` (Codex enforces with its own, lower count). Total shown elsewhere is `goalTokens(goal) = max(tokensUsed, tokensObserved ?? 0)`.
- `formatTokens`: `<1000` raw, else `12.3k` / `250k`. `formatDuration`: `45s`, `3m 12s`, `1h 5m`.

#### Error reasons (`frontend/lib/goal-errors.ts`, `shared/errors.ts`)

```ts
export type ErrorReason =
  | "rateLimited" | "quota" | "credentials" | "providerDown" | "contextWindow" | "other";

export interface TurnFailure {
  reason: ErrorReason;
  message: string;      // safe message, never provider diagnostics
  httpStatus?: number;
}
```

| Reason | Label | Hint | Action | Signals (status doc) |
|---|---|---|---|---|
| `rateLimited` | Rate limited | The model provider is limiting requests right now. Wait a moment, then resume. | resume | 429 |
| `quota` | Out of credits | The model provider account has no usage or credits left. | none (provider tip) | `usageLimitExceeded`, 402 |
| `credentials` | Access denied | The model provider rejected the configured credentials. | none (provider tip) | `unauthorized`, 401, 403 |
| `providerDown` | Provider unavailable | The model provider is unavailable or the connection dropped. Resume to try again. | resume | 5xx, overloaded, connection failures |
| `contextWindow` | Conversation too long | The conversation no longer fits the model's context window. Compacting summarizes earlier turns so the work can continue. | compact | `contextWindowExceeded` |
| `other` | Stopped by an error | (shows `failure.message` instead) | resume | anything else |

Provider tips (`providerTip`, only for `quota` / `credentials`, matched on the agent's provider name):

| Match | quota | credentials |
|---|---|---|
| `/openrouter/i` | Check credits on OpenRouter. Free models have low daily request limits. | Check the OpenRouter API key in the model profile. |
| `/bedrock\|amazon\|aws/i` | Check the Bedrock service quotas for this model in the AWS console. | Check the IAM permissions and model access for this Bedrock model. |
| `/openai/i` | Check usage and billing in the OpenAI platform dashboard. | Check the OpenAI API key and its project access. |
| `/anthropic\|claude/i` | Check usage and billing in the Anthropic Console. | Check the Anthropic API key in the model profile. |
| `/gemini\|google\|vertex/i` | Check quotas in Google AI Studio or the Google Cloud console. | Check the Google API key and its access to this model. |
| fallback | Ask your administrator to check the provider account's usage and billing. | Ask your administrator to check the API key and model permissions in the model profile. |

`goalFailure(status, failure)` returns the failure only when status is `blocked` or `usageLimited`. `turnFailure(error)` normalizes a `turn.completed` / `error` event error, defaulting unknown reasons to `other`.

#### Server error codes (platform)

- `POST /goal/review` 400 `INVALID_REVIEW`: "Choose accepted or reopened" / "Feedback is too long" (>4000 chars).
- 409 `GOAL_NOT_COMPLETE`: "Only a goal the assistant has completed can be reviewed".
- The goal bar shows any thrown message verbatim in `.goal-error`.

#### Client-side messages

- "Describe the goal before saving." (empty objective edit)
- `budgetHelp` (invalid budget in bar or composer)
- "Usage: /goal budget <tokens>, for example /goal budget 50k"
- Command success toasts: "Goal set.", "Goal updated.", "Goal paused.", "Goal resumed.", "Goal cleared.", "Token budget set to N."
- Confirms: "Replace the current goal with this one?", "Clear this goal? Its progress will no longer be tracked.", "Mark this goal complete? The assistant stops working on it and the result is accepted."

#### API calls

| Call | Body | Used by |
|---|---|---|
| `POST /api/sessions/:id/capabilities` | `{ method: "thread/goal/set", params: { objective?, status?: "active"\|"paused"\|"complete", tokenBudget?: number\|null } }` returns `{ goal }` | bar, composer, stop button, slash commands |
| same | `{ method: "thread/goal/clear", params: {} }` | bar clear, composer replace, `/goal clear` |
| same | `{ method: "thread/goal/get", params: {} }` | `/goal`, `/goal show` |
| same | `{ method: "thread/compact/start", params: {} }` | bar "Compact conversation" |
| `POST /api/sessions/:id/goal/review` | `{ decision: "accepted"\|"reopened", feedback? }` returns `{ goal, review }`; reopened also sets status `active` server-side | bar review |
| `GET /api/sessions/:id/goal/history` | returns `{ entries: GoalHistoryEntry[] }` | timeline |

Slash command grammar (`lib/slash-commands.ts`): `/goal` or `/goal show` → get; `/goal clear`; `/goal pause`; `/goal resume`; `/goal budget <tokens>`; `/goal <anything else>` → set objective.

---

### 4.1 State diagram

"Awaiting review" and "Accepted" are UI states layered on `complete` by `GoalReview`.

```
none            -- composer goal mode submit / "/goal <text>" (thread/goal/set) --> active
active          -- Pause (bar icon, "Pause after this turn", /goal pause)      --> paused
active          -- Stop button in composer (pauses, then interrupts turn)     --> paused
paused          -- Resume (bar icon, /goal resume) / "Keep going" while running --> active
active          -- runtime: needs input or error                              --> blocked
active          -- runtime: model usage ran out                               --> usageLimited
active          -- runtime: tokensUsed reaches tokenBudget                    --> budgetLimited
active          -- runtime: assistant marks done                              --> complete (Ready for review)
blocked         -- Resume goal                                                --> active
blocked         -- Provide input (focus composer, user replies)               --> blocked (until resumed)
usageLimited    -- Resume goal                                                --> active
budgetLimited   -- Extend by 25k / 50k (budget + status active)               --> active
budgetLimited   -- Set budget via menu (budget only, status unchanged)         --> budgetLimited
any non-complete -- Mark complete (set complete, then review accepted)         --> complete (Accepted)
any non-complete -- Edit objective / Set budget                               --> same status
complete(review) -- Accept result                                             --> complete (Accepted)
complete(review) -- Not yet -> Reopen goal [feedback]                          --> active (+ prompt prefilled in composer)
complete(Accepted) -- Start a follow-up goal                                  --> composer goal mode (drafting)
any             -- Clear goal (confirm) / "/goal clear" / goal.cleared event   --> none
any             -- composer goal-mode submit while goal exists (confirm unless complete) --> clear, then set --> active
blocked|usageLimited + contextWindow failure -- Compact conversation           --> same status (resume afterwards)
```

Any `goal.updated` event with a non-`complete` status drops the stored review (`page.tsx`), so a reopened or re-activated goal is no longer "Accepted".

---

### 4.2 Page wiring (`frontend/app/page.tsx`)

State:

```ts
[goal, setGoal] = useState<Goal | null>(null)
[goalReview, setGoalReview] = useState<GoalReview | null>(null)
[documents, setDocuments] = useState<ConversationFile[]>([])
[failure, setFailure] = useState<TurnFailure | null>(null)  // why the last turn failed
[goalMode, setGoalMode] = useState(false)                    // composer drafting a goal
[goalBudget, setGoalBudget] = useState<number | null>(null)  // composer budget
[goalBudgetValid, setGoalBudgetValid] = useState(true)
```

- On session open: `goal = data.snapshot?.goal`, `goalReview = data.goalReview`.
- Live events: `goal.updated` sets goal and mirrors it into the sidebar list (`syncSessionGoal`), clearing review unless complete; `goal.cleared` clears both.
- Documents are loaded when `awaitingReview(goal, goalReview)` so the completion card can list them.
- Submit in goal mode: blocks with `budgetHelp` if the budget is invalid; builds `goalCommand(text, goalBudget)`; if a goal exists, confirms replace (skipped when complete) and calls `thread/goal/clear` first. A goal can open a new conversation (objective becomes the title). On success, exits goal mode and resets the budget.
- `startGoal(template)`: closes panels, enters goal mode, fills and focuses the composer. `/goal` typed alone in a starter prompt also calls it.
- Stop button: if goal is `active`, sets `status: "paused"` before interrupting the turn. Tooltip "Pause the goal and stop the current response".
- Status line text shows "working on goal" when running with an active goal.
- Suggestions are hidden while `goalMode` is on.
- `<GoalBar key={session._id} ...>` with `onReopen` → `applyPrompt("The goal isn’t complete yet: {feedback}")` or "The goal isn’t complete yet. Please keep working on it."; `onProvideInput` → close panel, focus composer; `onFollowUp` → `startGoal()`; `documentHref` → `${base}/api/sessions/:id/documents/:docId`; `provider` from the session's agent.

---

### 4.3 Composer goal mode (drafting)

File: `frontend/components/v2/composer.tsx` (goal-related props only; full composer is another slice). Parent: `page.tsx`.

```ts
goalMode: boolean;
onGoalToggle: () => void;   // page: goalMode ? setGoalMode(false) : startGoal(text)
onGoalCancel: () => void;   // page: setGoalMode(false)
budget?: React.ReactNode;   // <BudgetField>, shown after the Goal chip in goal mode
```

Visual states:
- Off: `.chip.goal-chip` with target icon and "Goal", `aria-pressed=false`, title "Set this message as the conversation goal".
- On: root gets `.goal-mode`; header `.composer-goal-head` with target icon, "New goal" (strong) + "The assistant keeps working until the goal is done, paused or out of budget.", and an `x` cancel button (`aria-label="Cancel goal"`). Budget select appears in the bar. Textarea `aria-label="Goal"`, placeholder "Describe the outcome you want. The assistant works until it’s done." (`GOAL_PLACEHOLDER`). Send button `aria-label="Start goal"`. Slash-command popup is suppressed. Escape exits goal mode.

CSS: `.composer.goal-mode` (`app/chat.css`), `.composer-goal-head` and children (`styles/v2/chat.css`), `.chip.goal-chip`.

#### BudgetField (`frontend/components/budget-field.tsx`), shared by composer and goal bar

```ts
export type BudgetValue = { tokens: number | null; valid: boolean };
props: {
  initial: number | null;
  onChange: (value: BudgetValue) => void;
  selectClassName?: string;
  showError?: boolean;   // default true
  autoFocus?: boolean;   // default false
}
```

State: `choice` (preset value string or `"custom"`), `custom` text, `touched`. Select (sr-only label "Budget") with `budgetOptions` + "Custom…"; custom shows `input.input.budget-custom` (`aria-label="Custom token budget"`, placeholder "e.g. 50k", `aria-invalid` once touched). Reports its starting value on mount. CSS: `.budget-field`, `.select`, `.budget-custom`.

---

### 4.4 GoalBar

- File: `frontend/components/goal-bar.tsx`
- Purpose: pinned summary and controls for the conversation's single goal; hosts pause/resume, the overflow menu (edit objective, set budget, mark complete), stuck-goal actions, and the completion review.
- Parent: `page.tsx`, in `.bottom` above the composer. Rendered only when `session && goal`. Keyed by session id.

Props:

```ts
{
  sessionId: string;
  goal: Goal;
  review: GoalReview | null;
  onChange: (goal: Goal | null, review: GoalReview | null) => void;
  onReopen: (feedback: string) => void;
  onProvideInput: () => void;
  onFollowUp: () => void;
  running: boolean;               // a turn is in progress
  entries: Entry[];               // chat entries, for the closing summary
  documents: ConversationFile[];
  documentHref: (id: string) => string;
  failure: TurnFailure | null;
  provider?: string;
}
```

Internal state:

```ts
type Panel = "edit" | "budget" | null;
busy: boolean                         // disables all action buttons during a request
error: string                         // shown in .goal-error
reopening: boolean                    // review switched to feedback form
feedback: string
panel: Panel
draft: string                         // objective edit text (init goal.objective)
budget: BudgetValue                   // { tokens: goal.tokenBudget ?? null, valid: true }
menuPos: { top: number; right: number } | null   // fixed-position menu; null = closed
turns: number                         // turns seen while mounted; shown when >= 2
refs: trigger, menu, focusLast, counted
```

Derived: `accepted`, `reviewing`, `editable = status !== "complete"`, `working = running && active`, `finishing = running && paused`, `stoppedBy = goalFailure(...)`, `used` (budget %, capped 100, only with a budget), `total = goalTokens(goal)`.

Layout (top to bottom):
1. `.goal-strip`: target icon; `.goal-strip-text` objective (ellipsis, full text in title); `.goal-strip-meta.mono.sm` "{duration} · {used} / {budget}" or "{duration} · {total} tokens" (title with exact counts when budgeted); `.bar[role=progressbar]` "Token budget used" (only with budget); `.goal-status.{tone}` pill with `.pulse` dot and state label (title = status hint); `.goal-strip-actions`.
2. `.goal-run` row while working/finishing.
3. Accepted row, or warn block, or edit/budget panel, or review panel.
4. `.goal-error[role=alert]`.

Strip actions (`.icon-btn.ghost`, 14px icons):
- Pause (`pause`): only `active`. Label "Pause after this turn" when running, else "Pause goal". Calls set `{status:"paused"}`.
- Resume (`play`): only `paused`. Set `{status:"active"}`.
- More (`Ellipsis`, lucide): only when editable. Opens `.goal-menu.menu[role=menu]` fixed below the trigger. Keyboard: ArrowDown/ArrowUp on trigger opens (focus first/last); in menu ArrowUp/Down, Home, End, Escape (close, refocus), Tab (close). Outside click or resize closes.
  - "Edit objective" (`pencil`) → edit panel
  - "Set budget" (`Gauge`, lucide) → budget panel
  - "Mark complete" (`check`) → confirm → set `{status:"complete"}` → `POST goal/review {decision:"accepted"}`
- Clear (`x`): always. Confirm → `thread/goal/clear` → `onChange(null, null)`.

Visual states:

| State | Condition | Pill tone / label | `data-tone` | Extra UI |
|---|---|---|---|---|
| In progress, idle | active, not running | `s-running` "In progress" (pulse animates) | good | pause, menu, clear |
| Working | active + running | `s-running` | good | `.goal-run`: spinner + "Working on the goal[ · turn N]. Stop pauses it now." + `.text-btn` "Pause after this turn" |
| Pausing after this turn | paused + running | `s-paused` "Paused" | neutral | `.goal-run`: "Pausing after this turn. The assistant finishes its current step, then stops." + "Keep going" |
| Paused | paused, not running | `s-paused` "Paused" | neutral | resume, menu, clear |
| Needs input | blocked | `s-paused` "Needs input" | warn | `.goal-hint` + optional `GoalReason` + "Provide input" (`btn-soft`) + "Resume goal" (`btn-solid`, play) |
| Usage limit reached | usageLimited | `s-paused` | warn | hint + optional `GoalReason` + "Resume goal" |
| Budget reached | budgetLimited | `s-paused` | warn | hint + "Extend by 25k", "Extend by 50k" (`btn-soft`) |
| Context window stop | blocked/usageLimited with failure `contextWindow` | as above | warn | adds "Compact conversation" (`btn-soft`) |
| Ready for review | complete, not accepted | `s-done` "Ready for review" | review | `.goal-review` panel; no menu (not editable) |
| Accepted | complete + matching accepted review | `s-done` "Accepted" | good | `.goal-stuck-actions`: "Start a follow-up goal" (`btn-soft`, target) |
| Busy | request in flight | unchanged | unchanged | all action buttons disabled |
| Error | request failed | unchanged | unchanged | `.goal-error` message |

`s-ended` exists as a fallback but no known `GoalStatus` reaches it in the bar.

Edit panel (`form.goal-panel`, only editable): label "Objective", textarea (3 rows, max 4000, autofocus), note "Time and tokens so far carry over. If the assistant is working, it picks up the change.", `.goal-review-actions` with "Cancel" (`btn-ghost`) and "Save objective" (`btn-solid`, disabled if empty/busy). Saves only when changed. Escape cancels; focus returns to the menu trigger.

Budget panel (`form.goal-panel`): `BudgetField` (autofocus), note "Counted toward the budget so far: {tokensUsed} tokens ({total} in total). The assistant stops when it reaches the budget.", "Cancel" / "Save budget" (disabled if invalid). Sends `{tokenBudget}` (null removes it); keeps the current review.

Review panel (`.goal-review[aria-live=polite]`): "The assistant marked this goal complete after {duration} and {tokens} tokens. Does the result meet your goal?", then `GoalCompletion`, then either:
- Default: "Not yet" (`btn-soft`) and "Accept result" (`btn-solid`, check) → `POST goal/review {decision:"accepted"}`.
- Reopening: visually hidden label "What still needs work?", textarea (2 rows, max 4000, placeholder "What still needs work? (optional)", autofocus), "Cancel" (`btn-ghost`) and "Reopen goal" (`btn-solid`, `RotateCcw`) → `POST goal/review {decision:"reopened", feedback?}` → `onReopen(note)`.

CSS classes: `.goal-bar[data-tone="good|neutral|warn|review"]`, `.goal-strip`, `.goal-strip-text`, `.goal-strip-meta`, `.mono`, `.sm`, `.bar`, `.goal-status` + `.s-running|.s-paused|.s-done|.s-ended`, `.pulse`, `.goal-strip-actions`, `.icon-btn.ghost`, `.goal-menu.menu`, `.menu-item`, `.goal-run`, `.spinner`, `.text-btn`, `.goal-hint`, `.goal-stuck-actions`, `.btn-soft`, `.btn-solid`, `.btn-ghost`, `.goal-panel`, `.goal-panel-note`, `.goal-review`, `.goal-review-actions`, `.visually-hidden`, `.goal-error`. Definitions split between `app/shell.css` (older `.goal-bar`, `.goal-run`, `.goal-review`, `.goal-menu`, `.goal-panel`, `.goal-reason`) and `styles/v2/chat.css` (`.goal-strip*`, overrides the old `data-tone` pill colours) and `styles/v2/base.css` (`.goal-status` pills). `app/shell.css` also has now-unused `.goal-actions`, `.goal-progress i`. Below a breakpoint in `styles/v2/chat.css`, the strip's `.bar` and `.goal-strip-meta` are hidden.

---

### 4.5 GoalReason

- File: `frontend/components/goal-reason.tsx`
- Purpose: explains why a goal stopped, shown next to Codex's status (never in place of it).
- Parent: `GoalBar` warn block, only when `goalFailure(goal.status, failure)` is non-null (status `blocked` or `usageLimited` with a turn failure).

Props:

```ts
{ failure: TurnFailure; provider?: string }
```

Internal state: none.

Render: `div.goal-reason[role=status]` → `p` with `span.goal-reason-label` "{label}[ (HTTP {status})]" followed by the hint, or the safe `failure.message` for `other`; then `p.goal-reason-tip` with the provider tip for `quota`/`credentials`.

Visual states: one per `ErrorReason` (six), each with or without HTTP status; tip present only for quota/credentials.

CSS: `.goal-reason`, `.goal-reason-label`, `.goal-reason-tip` (`app/shell.css`).

---

### 4.6 GoalCompletion

- File: `frontend/components/goal-completion.tsx`
- Purpose: shows what a completed goal produced: the assistant's closing summary and documents created during the goal.
- Parent: `GoalBar` review panel (Ready for review only).

Props:

```ts
{
  goal: Goal;
  entries: Entry[];
  documents: ConversationFile[];
  href?: (id: string) => string;
}
```

Internal state: `expanded: boolean` (summary show more/less).

Data (`lib/goal-completion.ts`):

```ts
export const SUMMARY_PREVIEW_CHARS = 280;
export interface ClosingSummary { text: string; preview: string; truncated: boolean; }
```

- `closingSummary(entries, goal)`: last `final` assistant message after the matching `thread/goal/set` command entry (matched by `createdAt`), else from the list start. Order stands in for time.
- `previewText`: cuts at 280 chars, at a word boundary if one is past 60%, appends `…`.
- `goalDocuments(documents, goal)`: files with `createdAt` between goal `createdAt` and `updatedAt + 999ms` (end open if not complete), excluding `kind === "visualization"`, sorted oldest first.

Visual states:
- Nothing to show: renders `null`.
- Summary only / documents only / both.
- Summary truncated (collapsed/expanded toggle "Show more"/"Show less", `aria-expanded`) or short (no toggle).
- Documents heading "1 document created" / "N documents created"; each row: `DocumentIcon`, name (ellipsis, title), "Download" link (`a.btn-soft`, `download`, `aria-label="Download {name}"`) when `href` is set.

CSS (`app/panels.css`): `.goal-completion`, `.goal-completion-summary`, `.goal-completion-text[data-expanded]`, `.goal-completion-toggle` (+`.btn-ghost`), `.goal-completion-documents`, `.goal-completion-name`.

---

### 4.7 GoalTimeline

- File: `frontend/components/goal-timeline.tsx`
- Purpose: the Goal tab in session activity: current goal, progress by plan checkpoints, and the change history, newest first.
- Parent: `components/session-activity.tsx`, rendered when `panel === "goal"` with `sessionId`, `goal`, `review`, `plan`.

Props:

```ts
{
  sessionId?: string;
  goal: Goal | null;
  review: GoalReview | null;
  plan?: PlanStep[];   // default []
}
```

Internal state:

```ts
entries: GoalHistoryEntry[]
failed: boolean            // history fetch failed
missing: string | null     // turnId whose chat anchor wasn't found
```

Data fetch: `GET /api/sessions/:id/goal/history`, debounced 400ms, re-run only when `createdAt:objective:status:tokenBudget` or `review.decision:review.at` changes (token-only updates don't refetch). Errors logged via `warnFailure("goal history", e)`.

Pill tones:

```ts
const pillTone: Record<GoalStatus, "s-running" | "s-paused" | "s-done" | "s-ended"> = {
  active: "s-running", paused: "s-paused", blocked: "s-paused",
  usageLimited: "s-paused", budgetLimited: "s-paused", complete: "s-done",
};
// accepted review forces "s-done"
```

History icons by kind: set `target`, objective `pencil`, budget `gear`, status `pulse`, accepted `check`, reopened `play`, cleared `x`.

History labels (`historyLabel`): "Goal set", "Objective edited", "Budget set to {N} tokens" / "Budget removed", "Status: {label}" / "Status changed", "You accepted the result", "You reopened the goal", "Goal cleared".

Token delta (`tokenChange`): Codex tokens since the previous entry of the same goal; null for `set`, missing counts, non-growth, or across a `cleared`/`set` boundary.

Visual states:
- No goal: `.empty-tab` with `.tile.lg` target icon, "No active goal" (`.strong`), "Give the assistant an outcome. It keeps working until it's done, paused or out of budget." (`.muted.sm`). History shown below only if entries exist.
- With goal (`.goal-view`):
  - `.goal-head`: status pill (label via `goalStateLabel`) + "Started {h:mm}" (`.mono.sm.muted`) when `createdAt` is set.
  - `h3.goal-title` objective.
  - `.goal-progress`: `.bar[role=progressbar]` "Goal progress" + "{pct}%". pct = 100 if complete, else done/total plan steps, else 0.
  - `dl.goal-meta`: Budget ("{N} cap" / "No budget"), Used ("{total}" + muted " / {budget}", title "{duration} spent"), Checkpoints ("done/total" or "—").
  - Checkpoints (only if plan): `ol.checkpoints` of `li` with `.is-done` / `.is-current` (`aria-current="step"`, only while active) and `StepMark state="done|current|pending"`.
- History section (`.section-head` + `.eyebrow` "History"):
  - Load failed: `p.tl-empty` "Goal history couldn’t be loaded."
  - Empty: `p.tl-empty` "Goal changes will appear here."
  - List: `ol.timeline[aria-label="Goal history"]` of `li.tl-row[data-kind]` → `.tl-dot` icon; `.tl-body` with `.tl-title` label, `.tl-meta` objective (not for cleared), `q.goal-history-feedback` (reopen feedback), `.goal-history-meta` "{Mon d, h:mm} · {N} tokens · +{N} since the last change", "View turn" `button.link.goal-history-turn` when `turnId` exists, and `.goal-note[role=status]` "This turn isn’t loaded in the chat." if the anchor is missing.

Interactions: "View turn" scrolls to `#turn-{turnId}` (smooth unless reduced motion) and focuses it. No goal mutations here.

CSS: `.empty-tab`, `.tile.lg`, `.strong`, `.muted`, `.sm`, `.mono`, `.goal-view`, `.goal-head`, `.goal-status.s-*`, `.pulse`, `.goal-title`, `.goal-progress`, `.bar`, `.goal-meta`, `.section-head`, `.eyebrow`, `.checkpoints`, `.is-done`, `.is-current`, `.tl-empty`, `.timeline`, `.tl-row`, `.tl-dot`, `.tl-body`, `.tl-title`, `.tl-meta`, `.goal-history-feedback`, `.goal-history-meta`, `.link`, `.goal-history-turn`, `.goal-note` (mostly `styles/v2/session.css`).

---

### 4.8 Goal commands in the chat transcript

- `chat-messages.tsx`: a user message carrying a command shows `span.goal-tag` above the bubble, with a target icon for `thread/goal/*`, labelled "Goal" (`commandLabel`).
- `command-result.tsx` (`CommandResult`, props include `currentGoal?: Goal | null; goalReview?: GoalReview | null`): for goal commands, shows the objective (or "Goal cleared." / "No goal is set."), a status label that follows live state when `sameGoal(recorded, currentGoal)`, otherwise the recorded status, plus a `dl` of time, tokens (`goalTokens`) and budget. Follow-up buttons "Check goal status" (`/goal show`) and a clear action (`/goal clear`) fill the composer.
- Chat turn groups get `id="turn-{turnId}"` on their first response so the timeline's "View turn" can scroll to them.

---

### 4.9 Known gaps (from the status doc and code)

- Rate-limit reset time is not shown (not forwarded by the runtime).
- Closing summary is picked by chat order, not timestamp.
- Browser click-through of the new goal controls, error reason, View turn and completion card is not verified.
- Codex enforces the budget with its own, lower count; the bar's progress follows Codex, the totals show Truex's larger count.
- The "turn N" counter restarts on reload, so it only appears from turn 2.


## 5. Agents, Subagents, Tools & MCP

Scope: persistent agents (create dialog, badge/robot looks, agent picker menu), helper sub-agents spawned during a session (panel, detail, status chip, composer chip, delegation prefs), connected MCP tools (summary pill, settings sheet) and the advanced capabilities explorer.

Terminology used by the UI:
- "Agent" = a persistent specialist stored per tenant (`Agent` / `AgentSummary`). Picked in the dock, created in the New agent dialog, mentioned as `@handle`.
- "Helper" = a sub-agent the main agent spawns inside one session (`SubAgent`). Shown in the "agents" tab of the session activity panel.
- "Connected tools" = MCP servers attached to an agent (user-scoped or tenant-scoped).

Mounting status (checked by grep over `frontend/app`, `frontend/components`, `frontend/lib`):
- Mounted: `AgentDialog`, `AgentMenu`, `AgentsPanel` (+ `HelperDetail`, `Lanes`, `HelperRow`, `StatusChip`, `HelperAvatar`), `HelperChip`, `DelegationSettings`, `McpSettings`, `Badge`/`Robot`/`Confetti`.
- Not imported anywhere at present: `ConnectedTools` (`components/connected-tools.tsx`) and `Capabilities` (`components/capabilities.tsx`). They are v1 leftovers; their CSS still exists. Treat as optional surfaces for the redesign.
- Not implemented: agent edit and delete (no platform endpoints). `AgentMenu` supports an `onEdit` pencil but `page.tsx` does not pass it. There is no "deleting" confirm state anywhere in this slice. MCP delete/patch endpoints exist on the platform but no frontend UI calls them.
- No `Skill` type exists in `shared/contracts.ts`; the only skill reference is `Agent.skillIds?: string[]` (catalog skill ids). No skill UI exists in this slice.

---

### 5.0 Data model (shared/contracts.ts and related)

```ts
// shared/contracts.ts
import type { AskForApproval } from "./protocol/v2/AskForApproval";
import type { SandboxMode } from "./protocol/v2/SandboxMode";

export interface Agent {
  _id: string;
  name: string;
  description: string;
  modelProfileId: string;
  systemPrompt: string;
  /** Replaces the default Truex identity line; platform guardrails still apply. */
  persona?: string;
  /** "general" lifts the business-only framing. Defaults to "business". */
  scope?: "business" | "general";
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  mcpProfileIds: string[];
  /** Catalog skill ids; shared across tenants, subject to allowedSkillIds. */
  skillIds?: string[];
  /** Mention handle without "@"; unique per tenant. See agentHandle(). */
  handle?: string;
  /** Robot look index, 0 to AGENT_LOOK_COUNT - 1. */
  look?: number;
  tint?: AgentTint;
  /** Seeded by the Truex team; never set through the API. */
  builtin?: boolean;
}
export const AGENT_TINTS = ["ice", "mint", "butter", "peach", "lilac"] as const;
export type AgentTint = (typeof AGENT_TINTS)[number];
export const AGENT_LOOK_COUNT = 12;
export const DEFAULT_AGENT_LOOK = 2;          // "Navy"
export const DEFAULT_AGENT_TINT: AgentTint = "ice";
export const AGENT_NAME_MAX = 40;
export const AGENT_PURPOSE_MAX = 80;
export const AGENT_INSTRUCTIONS_MAX = 20000;
/** "Research Scout" → "researchscout" (design spec, app.tsx:83). */
export function agentHandle(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
}

/** A model the agent dialog can offer; never carries credentials. */
export interface ModelOption { id: string; name: string; provider: string; }

export const WIRE_APIS = ["responses", "chat", "anthropic", "gemini"] as const;
export type WireApi = (typeof WIRE_APIS)[number];
export type ModelRoute = "direct" | "gateway";
export interface ModelProfile {            // server-side; never sent to the browser
  _id: string; provider: string; baseUrl: string; modelName: string;
  reasoningEffort: string; apikey: string; wireApi: WireApi; route?: ModelRoute;
  contextWindow?: number; autoCompactTokenLimit?: number;
}
export interface McpProfile { _id: string; name: string; config: Record<string, unknown>; }

// What GET /api/agents returns and the UI stores in `agents` state.
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  sandbox: string;
  handle?: string;
  look: number;
  tint: AgentTint;
  builtin: boolean;
}

// Mirrors the runtime's CollabAgentStatus.
export type SubAgentStatus =
  | "pendingInit" | "running" | "interrupted" | "completed"
  | "errored" | "shutdown" | "notFound";
// A helper agent spawned by the session's main agent. Never carries raw tool arguments.
export interface SubAgent {
  threadId: string;
  path: string | null;
  nickname: string | null;
  role: string | null;
  depth: number;          // 1 = spawned by main agent; >1 = nested ("level N")
  status: SubAgentStatus;
  task?: string;
  lastMessage?: string;
  startedAt: string;      // ISO, server clock
  endedAt?: string;
}
export interface SubAgentTranscript {
  agent: SubAgent;
  messages: { id: string; text: string; final: boolean }[];
}
export type CollabTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
// Snapshot.subAgents?: SubAgent[]; DomainType includes
// "subagent.spawned" | "subagent.status" | "subagent.completed" | "subagent.event" | "mcp.status"
// StepSpan.agent: "main" for the session agent, else helper nickname/role.
```

Agent created by `POST /api/agents` (platform/src/agents.ts `newAgent`) always gets: `_id: "agent_" + uuid`, `sandbox: "read-only"`, `approvalPolicy: "on-request"`, `mcpProfileIds: []`, `skillIds: []`, `builtin: false`, `enabled: true`. The body accepts only `name, description, systemPrompt, look, tint, modelProfileId` (unknown fields rejected).

MCP server summary (platform/src/mcp.ts `mcpSummary` + service.ts wrappers). This is the shape in `GET /api/agents/:id/mcp` and `GET /api/mcp`:

```ts
type McpSummary = {
  id: string;                          // "mcp_" + uuid
  name: string;
  scope: "user" | "tenant";            // ownership: user = owned by one user; tenant = shared, admin-managed
  enabled: boolean;                    // false → shown as "unavailable"
  transport: string;                   // "http" or "configured" (legacy)
  hasKey: boolean;                     // an API key is stored (value never returned)
  urlHost?: string;                    // host[:port] only; path/query stripped
  agentIds: string[];                  // agents this server is attached to
  warnings?: string[];                 // e.g. plain-HTTP warning, name shadowed by tenant server
};
// service.ts adds:
//  user summary:   { ...McpSummary, editable: true, shadowed?: true }
//  tenant summary: { ...McpSummary, editable: boolean /* caller is admin */ }
// GET /api/agents/:id/mcp response:
type AgentMcpResponse = {
  profileIds: string[];                              // attached ids among `profiles`
  profiles: (McpSummary & { editable: boolean; shadowed?: true; attached: boolean })[];
     // caller's own user MCPs; for admins ALSO every tenant MCP (LEGACY frontend-v1)
  tenantProfiles: (McpSummary & { editable: boolean; attached: true })[]; // tenant MCPs attached, read-only
};
// GET /api/mcp response: { userProfiles: [...], tenantProfiles: [...] }
```

Known warning strings (verbatim):
- Shadowed: "A tenant MCP server is also named {name}. Chats use the tenant server and skip this one; rename it to use it."
- Plain HTTP: "This connector uses plain HTTP, so its API key and data travel unencrypted. Use HTTPS if the server supports it."

MCP auth model: `auth: { kind: "none" | "bearer" | "header"; headerName?: string }` + write-only `apiKey`. Server rules: name regex `/^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/`, max 64 ("MCP name must be 1–64 letters, digits or hyphens, with single underscores between words"); transport must be `"http"`; headerName 1–128 chars, HTTP token chars, not a reserved header; non-"none" auth requires an API key. Name clash on create → 409.

Note: the frontend has no UI for MCP runtime connection status (connected/disconnected/error) or OAuth "auth required". `mcp.status` domain events exist but are not rendered in this slice. The only availability state shown is `enabled: false` ("unavailable") and "missing profile".

---

### 5.1 lib/agent-look.ts (look + tint palettes)

Pure data; imported by dialog, badge and `page.tsx` (agent hue = `tintOf(a.tint).dot`).

```ts
export interface Look {
  name: string; body: string; visor: string; glow: string;
  face: "line" | "eyes" | "happy";
  acc?: string;      // "antenna" | "headphones" | "cap" | "chef" | "hardhat" | "scarf" | "bow"
  accColor?: string; // falls back to body
}
export interface Tint { id: AgentTint; label: string; bg: string; dot: string; }
export const tintOf = (id?: string): Tint => TINTS.find(t => t.id === id) || TINTS[0];
export const lookOf = (i?: number): Look => (i === undefined ? undefined : LOOKS[i]) || LOOKS[0];
export const tone = (hex: string, amt: number): string; // mix toward white (amt>0) / black (amt<0)
export const CONFETTI_COLORS = ["#3691CD","#BCDEE8","#A9D5BE","#EBCB8B","#F0B999","#C4BDE3","#F2C94C"];
```

LOOKS (index = `look` value):

| # | name | body | visor | glow | face | acc | accColor |
|---|---|---|---|---|---|---|---|
| 0 | Graphite | #3A4750 | #1F2A30 | #BCDEE8 | line | – | – |
| 1 | Antenna | #F4F7F8 | #2B3F6B | #BCDEE8 | eyes | antenna | – |
| 2 | Navy (default) | #2E4470 | #16213A | #BCDEE8 | line | – | – |
| 3 | Listener | #D5DDE1 | #2B3F6B | #BCDEE8 | happy | headphones | #3691CD |
| 4 | Scout | #D8C3A0 | #3A4750 | #EBCB8B | line | cap | #E07B6E |
| 5 | Chef | #F4F7F8 | #2B3F6B | #BCDEE8 | eyes | chef | – |
| 6 | Builder | #F4F7F8 | #3A4750 | #EBCB8B | eyes | hardhat | #F2C94C |
| 7 | Scarf | #3A4750 | #1F2A30 | #F0B999 | happy | scarf | #E07B6E |
| 8 | Mint | #BFE3CF | #1F2A30 | #A9D5BE | eyes | antenna | – |
| 9 | Lilac | #CFC8EC | #2B3F6B | #C4BDE3 | happy | bow | #F0A3B5 |
| 10 | Peach | #F5C7A8 | #3A4750 | #F0B999 | line | headphones | #3A4750 |
| 11 | Captain | #2E4470 | #16213A | #BCDEE8 | eyes | cap | #3691CD |

TINTS (fixed hex; do not change in dark mode). `bg` = badge/look-tile background, `dot` = lanyard strap colour and the agent's hue (dot in AgentMenu):

| id | label | bg | dot |
|---|---|---|---|
| ice (default) | Ice | #EAF5F8 | #3691CD |
| mint | Mint | #E7F4ED | #A9D5BE |
| butter | Butter | #FFF3D9 | #EBCB8B |
| peach | Peach | #FBE9DD | #F0B999 |
| lilac | Lilac | #EFEDF8 | #C4BDE3 |

---

### 5.2 lib/agents.ts (dialog helpers + API)

```ts
export function modelShort(name: string): string; // "Claude Opus 5.5" → "opus 5.5" (lowercase, strips leading "claude ")
export interface AgentFields {
  name: string; description: string; systemPrompt: string;
  look: number; tint: AgentTint; modelProfileId: string;
}
export function createAgentBody(fields: AgentFields): AgentFields; // trims name/description/systemPrompt
export function handleTaken(handle: string, agents: AgentSummary[]): boolean;
export const fetchModels = (): Promise<ModelOption[]> => api("/api/models");          // GET
export const createAgent = (body: AgentFields): Promise<AgentSummary> => api("/api/agents", body); // POST
```

`api(path, body?)`: body present → POST JSON; absent → GET.

---

### 5.3 Robot (components/v2/agent-badge.tsx)

- Purpose: SVG robot avatar for an agent look. Used in look picker tiles (40px), badge header (150px).
- Parent: `AgentDialog` look grid, `Badge`.
- Props: `{ look: number; size?: number /* default 64 */ }`
- State: none. Uses `useId` for unique gradient/filter ids.
- Rendering: viewBox 0 0 120 120, `aria-hidden`. Layers: ground shadow, backpack + legs, rounded shell (rx 31) with gradient + sheen + rim light, status LED (hidden when `acc === "scarf"`), visor (bezel, glass, bloom), glowing face (`line` bar / `eyes` two dots with catchlights / `happy` two arcs), glare, then accessory (antenna with glowing ball, cap with brim, hardhat with ridge + brim, chef hat puffs, headphones band + cups, bow, scarf wrap + tail). All shading derived from `body`, `visor`, `glow`, `accColor` via `tone()`.
- CSS: none (inline SVG).

### 5.4 Badge (components/v2/agent-badge.tsx)

- Purpose: draggable lanyard ID badge; live preview in the dialog and the hero of the success screen.
- Parent: `AgentDialog` (`.nad-stage` preview and `.celebrate-stage`).
- Props:
  ```ts
  { name: string; handle: string; look: number; tint: string; modelLabel: string; tag?: string; shine?: number /* default 0 */ }
  ```
- State: `drag: {x,y} | null`; refs `origin`, `rest {len: 92, r: 200}`, `strapRef`.
- Content: brand text "truex"; header `.badge-top` background `tintOf(tint).bg` with `Robot size=150`; name (`"Unnamed"` + `.is-empty` when blank); handle line `@{handle || "handle"}` plus ` · {tag}` (success screen uses tag `"new specialist"`); footer shows `modelLabel`.
- Interaction: pointer drag anywhere on the lanyard. Offsets pass through `tanh` (rubber-band); lanyard rotates by `atan2(dx, r+dy)` around the anchor; strap stretches (height ≥ 0.75·len) and thins (width 16–24px). Release springs back via CSS `cubic-bezier(.34, 1.56, .64, 1)`. Idle `sway` animation (±1.4deg), paused while dragging. `shine > 0` renders `.badge-shine` (keyed, replays on change; not used by the current create-only dialog). Entire lanyard is `aria-hidden`.
- Sub-component `Clip`: SVG metal crimp, swivel, split ring and clear tab (`.clip`, 56×70).
- CSS: `.lanyard-anchor`, `.lanyard`, `.lanyard.is-drag`, `.lanyard-sway`, `.strap` (uses `--strap` var = tint dot), `.clip`, `.badge` (256px wide, radius 18, white, ink #1F2A30), `.badge-slot`, `.badge-shine`, `.badge-brand`, `.badge-top`, `.badge-body`, `.badge-name`, `.badge-name.is-empty`, `.badge-handle`, `.badge-foot`. Keyframes: `sway`, `shine`, `drop`. File: `frontend/styles/v2/agent-dialog.css`.

### 5.5 Confetti (components/v2/agent-badge.tsx)

- Purpose: burst on successful agent creation.
- Props: none. State: memoised 56 pieces; each random angle, distance 110–330px, spin ±360deg, size (every third is a 7px dot, else 5–9 × 3–12px rect), delay 0–140ms, duration 1500–2400ms, colour cycling `CONFETTI_COLORS`. All passed as CSS vars `--x --y --r --c --w --h --d --t`.
- CSS: `.confetti`, `.confetti i`, `@keyframes burst` (fling then fall 170px and fade). `aria-hidden`. Reduced motion disables animations (per design doc).

### 5.6 AgentDialog (components/v2/agent-dialog.tsx)

- Purpose: "New agent" modal (design spec `s-dialog`). Create mode only.
- Parent: `app/page.tsx` (always mounted; `open={agentDialogOpen}`). Opened from `AgentMenu` "New agent".
- Props:
  ```ts
  {
    open: boolean;
    agents: AgentSummary[];                 // for client-side handle collision check
    onClose: () => void;
    onCreated: (a: AgentSummary) => void;   // page appends to agents list
    onSayHi: (a: AgentSummary) => void;     // page: close, newChat(), select agent, prefill "@{handle} hi, ", focus composer caret at end
  }
  ```
- Internal state:
  ```ts
  type Models = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; list: ModelOption[] };
  f = { name: "", description: "", systemPrompt: "", look: DEFAULT_AGENT_LOOK /*2*/, tint: "ice", modelProfileId: "" }
  models: Models            // "loading" on each open
  created: AgentSummary | null
  submitting: boolean
  error: string             // general error text; cleared on any field change
  serverTaken: string       // handle the server rejected with 409 AGENT_HANDLE_TAKEN
  ```
  On every open: form reset, `GET /api/models`, first model auto-selected, name input focused after 30ms.
- Two steps: Form → Success ("celebrate"). No multi-step wizard, no tabs.

Form fields:

| Field | Control | Default | Placeholder | Limits / validation |
|---|---|---|---|---|
| Name | `input.input` | "" | "Research Scout" | `maxLength=40` (AGENT_NAME_MAX). Derived handle `agentHandle(name)` (a–z0–9 only, max 20). Label hint shows `@handle`, or `@handle is taken` (`.field-hint.is-bad`, `aria-invalid`) if in `agents` or equals `serverTaken`. Server: required; 422 `AGENT_HANDLE_INVALID` "Name needs at least one letter or digit (a–z, 0–9) to form a handle"; 409 `AGENT_HANDLE_TAKEN` "@{handle} is taken. Choose a different name." |
| Purpose | `input.input` | "" | "What this specialist owns" | `maxLength=80` (AGENT_PURPOSE_MAX). Optional. Stored as `description`. |
| Instructions | `textarea.input rows=3` | "" | "Standing instructions injected into every one of its turns" | No client maxLength; server max 20000 (AGENT_INSTRUCTIONS_MAX). Optional. Stored as `systemPrompt`. |
| Look | radiogroup of 12 `button.look` (Robot 40px, background = current tint bg, `title`/`aria-label` = look name) | 2 (Navy) | – | Server: integer 0–11. |
| Tint | radiogroup of 5 `button.tint` swatches (background = tint bg) | "ice" | – | Server: one of AGENT_TINTS. |
| Model | native `select` in `span.select.full` with chevron icon | first model | – | Required. Options = `ModelOption.name`. Disabled when list empty. Server 422 `MODEL_UNAVAILABLE` "That model is not available. Pick another model." |

Submit enabled when: `handle && !taken && selectedModel && !submitting`.

Visual states:
- Models loading: select shows disabled option "Loading models…"; submit disabled.
- Models error: select `aria-invalid`; hint below `#nad-model-error.field-hint.is-bad` with message; submit disabled.
- No models: "No models available"; submit disabled.
- Empty name: no handle hint; badge preview shows "Unnamed" and "@handle".
- Handle taken (client or server 409): red hint, submit disabled.
- Submitting: button text "Creating…", disabled.
- Generic error: `p.field-hint.is-bad[role=alert]` above actions.
- Live preview panel (`.nad-stage`): `Badge` with current name/handle/look/tint and `modelShort(model.name)`; note "live preview · drag it around" (`aria-live=polite`).
- Success ("celebrate"): no card; full-viewport dark blurred scrim, close X top-right, confetti, badge drops from top (0.9s bounce), strap height `clamp(24px, 16vh, 180px)`, tag "new specialist". Copy fades up after 0.35s: heading "{name} is on the team"; body "Mention `@handle` anywhere to wake it. Drag the badge around while you're here."; buttons "Say hi to {name}" (`.btn-solid.lg`, autofocus) and "Done" (`.btn-soft.lg`).

Interactions: Escape closes (both steps); mousedown on scrim closes form step; X closes; Cancel closes; Enter submits form.
API: `GET /api/models` → `ModelOption[]` (filtered by tenant allow-list; `name = displayName || modelName`); `POST /api/agents` → 201 `AgentSummary`. No role check (any tenant user can create).

Design intent (agent-badge-standalone.md / agent-created-standalone.md): the source prototype also had edit mode (click agent in list to edit, save plays the shine, stage note switches to "saved" / "unsaved changes · drag it around"). Not ported because the platform has no edit/delete endpoints. Code comment: when added, pass an `editing` prop that seeds the form, fixes the handle and swaps the submit action.

CSS (`frontend/styles/v2/agent-dialog.css`, reuses base/shell classes): `.scrim.center`, `.scrim.celebrate`, `.agent-dialog` (2-col grid 1.1fr/0.9fr, max-width 920px, radius 20, `animation: rise .18s`), `.dialog-x`, `.nad-form` (flex col, gap 16, padding 24/24/20), `.nad-head`, `.field`, `.field-label`, `.field-hint`, `.field-hint.is-bad`, `.input`, `.select.full`, `.look-grid` (6 cols; 4 cols ≤760px), `.look`, `.look.is-active` (ink border), `.tint-row`, `.tint` (26px circle), `.tint.is-active` (double ring), `.nad-actions`, `.grow`, `.btn-solid.lg`, `.btn-soft.lg`, `.nad-stage` (min-height 540, `--surface-3`, left border), `.nad-stage-note`, `.celebrate-stage`, `.celebrate-copy`, `.nad-done-copy`. ≤760px: single column, dialog scrolls.

### 5.7 AgentMenu (components/v2/agent-menu.tsx)

- Purpose: agent picker popover in the floating dock (spec "Agent menu anatomy").
- Parent: `app/page.tsx` inside `<Popover className="pop-agent" aria-label="Choose agent">`, toggled by the dock agent button.
- Props:
  ```ts
  export type AgentMenuAgent = { id: string; name: string; description?: string; hue?: string };
  export type AgentMenuProps = {
    agents: AgentMenuAgent[];
    currentId?: string | null;
    onPick: (id: string) => void;
    onEdit?: (id: string) => void;   // shows hover pencil per row (not passed today)
    onAll?: () => void;              // "All agents" row (not passed today)
    onNew?: () => void;              // "New agent" row
  };
  ```
  page maps `AgentSummary` → `{ id, name, description, hue: tintOf(a.tint).dot }`.
- State: none.
- Layout: eyebrow "Choose agent"; one `.menu-row` per agent with `.menu-item` button: coloured `.agent-dot` (8px; fallback `var(--accent-soft-2)`), name (strong), description (muted sm), check icon when current (`aria-current`, `.is-active`); optional pencil `.icon-btn.ghost.menu-edit` ("Edit {name}"). Separator, then "All agents" (grid icon in `.menu-plus.solid`) and "New agent" (plus icon in `.menu-plus`).
- States: empty agent list renders only the eyebrow and action rows (no empty copy). No loading state inside the menu.
- Interactions: pick → `setAgentId`, close popover; New → close popover, open `AgentDialog`.
- CSS: `.menu`, `.eyebrow.pad`, `.menu-row`, `.menu-row.is-active`, `.menu-item`, `.menu-item.is-active`, `.agent-dot`, `.menu-edit`, `.menu-sep`, `.menu-plus`, `.menu-plus.solid`, `.strong.block`, `.muted.sm` (dock.css, base.css).

---

### 5.8 lib/subagents.ts (helper state, status, naming, delegation)

```ts
export interface SubAgentState { agents: SubAgent[]; previews: Record<string, string>; skewMs?: number; }
export const emptySubAgents: SubAgentState = { agents: [], previews: {} };
export const PREVIEW_LIMIT = 4000;     // chars kept of each helper's streamed output
export const TITLE_LIMIT = 48;
export const isRunning = (a) => a.status === "running" || a.status === "pendingInit";
// terminal: interrupted, completed, errored, shutdown, notFound
export const statusLabels: Record<SubAgentStatus, string> = {
  pendingInit: "Starting", running: "Running", interrupted: "Stopped", completed: "Finished",
  errored: "Failed", shutdown: "Closed", notFound: "Unavailable",
};
```

- Event reducer `applySubAgentEvent`: `snapshot` (authoritative membership), `subagent.spawned|status|completed` (upsert `d.agent`), `subagent.event` with `kind` `message.delta` (append preview), `message.final` (sets `lastMessage`, replaces preview), `turn.started` (clears preview). Finished helpers never revert to running. Clock skew learned from event `at` (samples >10 min ignored).
- Naming `helperName`: nickname → capitalised role (skips "default") → "Helper N" by spawn order.
- `taskTitle(task)`: first sentence, clipped at word boundary to 48 chars + "…"; empty → "Working on a task".
- `previewTail(text, maxChars=240, maxLines=4)`: tail of output, markdown-balanced, prefixed "…".
- `formatDuration` (from lib/observability in the panel): "0:38", "1:02:03".
- Delegation prefs (browser only, `localStorage["truex.delegation"]`):
  ```ts
  export type DelegationMode = "explicitRequestOnly" | "proactive";
  export interface DelegationPrefs { mode: DelegationMode; maxConcurrent: number; } // 1–5
  export const defaultDelegation = { mode: "explicitRequestOnly", maxConcurrent: 3 };
  ```

Status → chip tone mapping (`agents-panel.tsx`):

| status | label | chip class | extra |
|---|---|---|---|
| pendingInit | Starting | is-running | spinner |
| running | Running | is-running | spinner |
| completed | Finished | is-done | – |
| interrupted | Stopped | is-stopped | – |
| shutdown | Closed | is-stopped | – |
| errored | Failed | is-warn | ⚠ |
| notFound | Unavailable | is-warn | ⚠ |

Chip colours (base.css): running `--accent-soft`/`--accent-fg`; done `--success-bg`/`--success-text`; stopped `--surface-3`/`--ink-3`; warn `--warning-bg`/`--warning-text`.

Helper tones (tokens.css) cycle `index % 3`: tone-0 blue `#2872b8`/soft `#eef5fc` (dark `#3691cd`/`#0f1f2c`); tone-1 green `#0f7a55`/`#e6f5ee` (dark `#199e70`/`#0e211a`); tone-2 orange `#b84a1b`/`#fcece4` (dark `#d95926`/`#24120a`); `--tone-main` grey `#6b6b6b` for the main agent. `.tone-N` sets `--t` and `--ts`.

### 5.9 AgentsPanel (components/agents-panel.tsx)

- Purpose: "agents" tab of the session activity panel listing helper sub-agents; opens a per-helper detail view.
- Parent: `components/session-activity.tsx` inside `<div className="ag-tab">`, followed by `DelegationSettings` when detail is closed.
- Props:
  ```ts
  {
    sessionId?: string;
    agents: SubAgent[];
    previews: Record<string, string>;
    skewMs?: number;
    onDetailChange?: (open: boolean) => void; // shell widens panel to "detail" size while open
  }
  ```
- State: `openId: string | null` (helper in detail), `lit: string | null` (hover/focus highlight shared between rows and timeline lanes). `useClock` ticks while any helper runs.
- Derived: `Helper = { agent: SubAgent; name: string; tone: number; elapsed: number }` in spawn order.
- Visual states:
  - Empty: `.empty-tab` with `.tile.lg` bot icon, "No helpers yet", "When the assistant hands part of a task to a helper, it shows up here."
  - List: `.ag-summary` "N helper(s) · X running · Y done · Z stopped" + total span (mono). Timeline `Lanes` only when ≥2 helpers. `ul.ag-rows[aria-label="Helper agents"]` of `HelperRow`.
  - Detail: `HelperDetail` replaces the list.
- CSS: `.ag-tab`, `.empty-tab`, `.tile.lg`, `.ag-list`, `.ag-summary`, `.ag-rows` (styles/v2/session.css).

#### Lanes (internal)
- Props: `{ helpers: Helper[]; now: number; skewMs?: number; lit: string | null }`
- Gantt-style: per helper `.ag-lane.tone-N` (`.is-lit` on hover) with `.ag-lane-name`, `.ag-track` containing `.ag-span` (left/width % on shared axis; `.is-running` while live), `.ag-lane-time`. Axis `.ag-axis` "0s" … total. `aria-hidden`.

#### HelperRow (internal)
- Props: `{ helper: Helper; preview: string; lit: boolean; onLit: (id: string | null) => void; onOpen: () => void }`
- Button `#agent-card-{threadId}.ag-row.tone-N[.is-lit]` (page scrolls/focuses this id when a chat chip opens a helper). Contents: `HelperAvatar`; top line name (strong) + " · {role or taskTitle}" + `StatusChip`; meta "{duration}[ · working…][ · level N]"; `.ag-preview` = `previewTail` (200 chars, 3 lines) of live preview when running, else `lastMessage`; chevron `.ag-chev`.
- Hover/focus sets `lit`, click opens detail.
- CSS: `.ag-row`, `.ag-row-body`, `.ag-row-top`, `.ag-row-meta`, `.ag-preview`, `.ag-chev`.

#### HelperDetail (internal)
- Props: `{ sessionId?: string; helper: Helper; index: number; count: number; preview: string; onBack: () => void; onPage: (step: number) => void }`
- State: `seg: "output" | "task" | "transcript"` (default "output"), `transcript: SubAgentTranscript | null`, `loading`, `stopping`, `copied` (resets after 1.5s), `error`.
- Layout:
  - `.ag-nav`: "All helpers" back button (autofocused); pager when count>1: prev/next icon buttons (wrap around) + "i of N".
  - `.ag-ident`: large avatar, name, sub line "role · Level N · taskTitle".
  - `dl.ag-stats`: Status (chip), Duration, Started (locale "h:mm" or "—").
  - Warning `.ag-warn[role=note]`: errored "This helper failed before finishing."; notFound "This helper is no longer available."
  - Error `.ag-error[role=alert]`.
  - Tabs `.ag-seg-tabs[role=tablist]` with `.ag-seg-tab[role=tab]`: Output / Task / Transcript; panel `#ag-panel-{threadId}.ag-panel[role=tabpanel]`.
- Output tab: interrupted + output → "Stopped before finishing. Partial output:"; markdown (GFM) output; empty → running "Working… output appears when this helper finishes." else "No output yet."; actions: "Copy output" / "Copied" (not running, has output); "Stop" / "Stopping…" (running; disabled without sessionId). Copy failure → "Couldn't copy the output."
- Task tab: `.ag-task` full task text or "No task was recorded." + "Sent by the main agent".
- Transcript tab (lazy fetched on first open): no sessionId → "Transcript isn't available."; loading → spinner "Loading…"; messages as `.ag-msg.markdown`; unsaved live tail `pre.ag-live[aria-live=polite]`; running → spinner "Working…"; empty → "No output yet."; "Refresh transcript" / "Refreshing…" link.
- Keyboard: Escape returns to list unless a `.scrim` or open `<dialog>` exists.
- API (lib/api.ts): `getAgentTranscript(sessionId, agentId)` → GET `/api/sessions/:sessionId/agents/:threadId`; `interruptAgent(sessionId, agentId)` → POST `.../interrupt` `{}`.
- CSS: `.ag-detail.tone-N`, `.ag-nav`, `.ag-back`, `.btn-ghost`, `.ag-pager`, `.ag-pager-label`, `.ag-ident`, `.ag-ident-name`, `.ag-stats`, `.ag-warn`, `.ag-error`, `.ag-seg-tabs`, `.ag-seg-tab`, `.ag-panel`, `.ag-task`, `.ag-msg`, `.ag-live`, `.ag-pending`, `.spinner`, `.goal-actions`, `.btn-soft`, `.link`, `.markdown`, `.sr-only`.

### 5.10 StatusChip (components/agents-panel.tsx, exported)
- Props: `{ agent: SubAgent }`. Renders `span.ag-chip.{is-running|is-done|is-stopped|is-warn}` with spinner or ⚠ and `statusLabels[status]` (see table 5.8). Unknown status → `is-stopped` and raw status text.

### 5.11 HelperAvatar (components/agents-panel.tsx, exported)
- Props: `{ name: string; tone: number; size?: "xs" | "lg" }`. Renders `span.h-av.tone-{tone%3}[.xs|.lg]` with the uppercase first letter (fallback "H"). `aria-hidden`.
- Sizes (session.css): default 26px / radius 8 / 12px font; xs 18px / 6 / 10px; lg 38px / 11 / 16px. Background `var(--ts)`, text `var(--t)`. Also used in chat helper cards (`.hcard .h-av.xs`, chat.css).

### 5.12 HelperChip (components/helper-chip.tsx)
- Purpose: pill above the composer while helpers run.
- Parent: `app/page.tsx` (`{!empty && <HelperChip state={subAgents} onView={viewHelpers} />}`).
- Props: `{ state: SubAgentState; onView: () => void }`
- Renders nothing when no helper is running. Otherwise `.helper-chip.status-pill`: `.pulse` dot, "N helper(s) running · {LiveDuration}", "View" link (`.helper-chip-view`) opening the agents tab. Count announced via visually-hidden `aria-live=polite`; timer silent.

### 5.13 DelegationSettings (components/session-activity.tsx, internal)
- Purpose: helper delegation preferences for new chats (stored in this browser).
- Parent: agents tab, below `AgentsPanel`, hidden while a helper detail is open.
- Props: `{ value: DelegationPrefs; onChange: (prefs: DelegationPrefs) => void }`
- Fields: `fieldset.delegation` legend "Delegation for new chats"; radios `name="delegation-mode"`: "Only when I ask" (`explicitRequestOnly`, default) / "Whenever it helps" (`proactive`); select "Max helpers at once" 1–5 (default 3). Normalised and saved to `localStorage` `truex.delegation`.
- CSS: `.delegation`, `.delegation-opt`, `.delegation-max`.

---

### 5.14 McpSettings (components/mcp-settings.tsx)

- Purpose: attach MCP servers to the current agent and create new user MCP servers.
- Parent: `app/page.tsx` inside `<Sheet open={panel === "mcp"} title="Connected tools" description="MCP servers attached to {agent.name || "this agent"}. Changes apply to new chats.">`. Opened from `UserMenu` settings (and `/mcp`). If no agent selected: "Select an agent to manage its tools." Keyed by `agentId`.
- Props: `{ agentId: string; onSaved?: () => void }` (page bumps `mcpVersion`).
- Internal state:
  ```ts
  type Profile = { id: string; name: string; enabled: boolean; transport: string };
  profiles: Profile[]; selected: string[]; ready: boolean; busy: boolean;
  error: string; notice: string;
  auth: "none" | "bearer" | "header" (string, default "none");
  const transport = "http"; // fixed
  ```
  (Only these fields of the richer `AgentMcpResponse.profiles` entries are used; `scope`, `urlHost`, `warnings`, `shadowed`, `editable`, `hasKey` and `tenantProfiles` are returned but not displayed.)
- Sections:
  1. Error banner `p.error-banner[role=alert]`; notice `p.mcp-notice[role=status]`.
  2. Loading: "Loading configuration…" until GET resolves (if GET fails, error shows and loading text stays).
  3. `fieldset` (disabled while busy) legend "Available servers": empty → "No MCP servers configured yet."; one checkbox row `label.mcp-option` per profile: "{name} · {transport}"; disabled profiles show " (unavailable — remove attachment)" and can only be unchecked; attached ids not in the list appear as "Missing profile: {id} · unknown". Button "Save attachments".
  4. `details.mcp-add` summary "Add an MCP server" → form:

| Field | Control | Rules |
|---|---|---|
| Name | `input name=name` | required, `pattern="[A-Za-z0-9_-]{1,64}"`, maxLength 64, placeholder "sap-tools". Server regex stricter (single underscores between words); 409 on clash. |
| Endpoint URL | `input type=url` | required, placeholder "https://example.com/mcp". Plain http allowed with warning (not shown in UI). |
| Authentication | `select` | None (default) / Bearer token / API key header |
| Header name | `input name=headerName` | only when "header"; required; placeholder "x-api-key"; server: HTTP token, ≤128, not reserved. |
| API key | `input type=password autocomplete=new-password` | only when auth ≠ none; required; write-only. |

  Button "Create server".
- Visual states: loading, empty list, list with selected/unselected, unavailable (disabled) server, missing profile, busy (all fieldsets disabled; no spinner text), error banner, success notices:
  - after save: "Saved. Start a new chat to use these MCP servers."
  - after create: "Server created and selected. Save attachments to enable it for this agent."
- Not present: connected/disconnected/error runtime status, OAuth/auth-required flow, edit, delete, scope badges (user vs tenant), tenant admin section.
- API:
  - `GET /api/agents/:id/mcp` → `AgentMcpResponse` (uses `profiles`, `profileIds`).
  - `POST /api/agents/:id/mcp` `{ profileIds: string[] }` (≤50 ids, each ≤200 chars) → replaces the caller's own attachments; for admins also splits and replaces tenant attachments (LEGACY).
  - `POST /api/mcp` `{ name, transport: "http", url, auth: { kind, headerName? }, apiKey? }` → 201 user-scoped MCP (owned by caller).
  - Available but unused by UI: `GET /api/mcp`, `PATCH /api/mcp/:id`, `DELETE /api/mcp/:id`, `GET|POST /api/tenant/mcp`, `PATCH|DELETE /api/tenant/mcp/:id`, `GET|POST /api/agents/:id/tenant-mcp` (tenant routes 403 for non-admins).
- CSS: `.mcp-settings`, `.mcp-option`, `.mcp-notice`, `.mcp-add`, `.error-banner` (app/panels.css).

### 5.15 ConnectedTools (components/connected-tools.tsx), currently unmounted

- Purpose: compact pill summarising MCP servers attached to the selected agent; click opens the MCP sheet.
- Props: `{ agentId: string; refreshKey: number; onManage: () => void }`
- State: `servers: {id; name; enabled}[] | null` (null = loading), `failed: boolean`. Refetches on `agentId`/`refreshKey`. Ids without a profile become `{ id, name: id, enabled: false }`.
- Visual states: loading "Loading tools…"; failed "Tools unavailable" (`warnFailure` logged); empty "Connect tools"; list: up to 3 `.tool-chip` (dot `<i>` + name), `.tool-chip.off` for disabled, `.tool-chip.more` "+N".
- A11y: `aria-label` "Connected tools: a, b (unavailable). Manage connected tools" or "Manage connected tools"; `title` "Manage connected tools (/mcp)". Plug icon (lucide).
- API: `GET /api/agents/:id/mcp`.
- CSS: `.connected-tools`, `.connected-tools-empty`, `.tool-chip`, `.tool-chip i`, `.tool-chip.off`, `.tool-chip.more` (app/chat.css).

### 5.16 Capabilities (components/capabilities.tsx), currently unmounted

- Purpose: developer-style explorer for the pinned runtime's JSON-RPC methods.
- Props: `{ sessionId: string; onFork: (id: string) => void }`
- State: `methods: any[]`, `method` (default "thread/goal/get"), `params` (default "{}"), `result: string`, `schema: any`, `busy`.
- Layout: `QuickTools` at top; h3 "Advanced capabilities"; muted "Explore the pinned runtime's capabilities. Thread identity is supplied by the session."; select "Operation" (excludes initialize, thread/start, thread/resume, turn/start, turn/steer, turn/interrupt); textarea "Parameters" (JSON); button "Run operation" / "Running…" (disabled while busy or no session); `details` "Parameter schema" (pre JSON; "No parameters" when none); result `pre`.
- Errors: invalid JSON → "The parameters are not valid JSON. {message}"; others via `userMessage`.
- API: `GET /api/capabilities` → `{ requests: { method; params }[] }`; `GET /api/schemas/:name`; `POST /api/sessions/:id/capabilities { method, params }` (if response has `session`, calls `onFork(session._id)`).
- CSS: `.capabilities`, `.muted`; shadcn `Button`.
- Related mounted surface: the "tools" Sheet in page.tsx ("Capabilities, documents & visuals") renders `AssistantTools`, which has its own "Capabilities" list (out of this slice).

---

### 5.17 Redesign notes (gaps a designer should know)

- Agent lifecycle is create-only; edit (pencil already designed in `AgentMenu`), delete confirm and "All agents" view are unbuilt.
- Agents have `builtin`, `sandbox`, `approvalPolicy`, `persona`, `scope`, `skillIds` and `mcpProfileIds` that the create form does not expose.
- MCP UI shows one flat list; the API already distinguishes `scope: "user" | "tenant"`, `editable`, `shadowed`, `warnings`, `urlHost`, `hasKey`, and read-only `tenantProfiles`. A future settings screen can surface scope badges, warnings and admin-only tenant management.
- No live MCP connection status or OAuth sign-in states exist in the frontend.
- Helper status has 7 runtime states collapsed into 4 visual tones.


## 6. Observability & Insights

The observability UI has three levels plus a session panel and a composer hint.

- Level 1: `TurnReceipt`, one quiet line under a finished answer (or `LiveUsage` while the turn runs).
- Level 2: `TraceCard`, which expands from the receipt. It covers the step timeline, token split, context meter and privacy card.
- Level 3: `DeveloperDetails` inside `TraceCard`, behind a "Developer details" checkbox. It shows ids, the reconstructed prompt and the raw trace JSON.
- Session level: `InsightsPanel`, the "insights" tab of the session activity sidebar. It shows KPIs, charts and usage limits.
- Composer: `PrivacyNote`, a soft PII warning shown while typing.

Source files:

| File | Contents |
|---|---|
| `frontend/components/observability/charts.tsx` | `StackedBar`, `Meter`, `ColumnChart`, `Segment`, `Column` |
| `frontend/components/observability/insights-panel.tsx` | `InsightsPanel`, private `ShareBar`, `inPct`, `inShortK` |
| `frontend/components/observability/receipt.tsx` | `TurnReceipt`, `LiveUsage` |
| `frontend/components/observability/trace-card.tsx` | `TraceCard`, private `DeveloperDetails` |
| `frontend/components/observability/step-timeline.tsx` | `StepTimeline` |
| `frontend/components/observability/token-bar.tsx` | `TokenBar` |
| `frontend/components/observability/privacy-card.tsx` | `PrivacyCard` |
| `frontend/components/observability/privacy-note.tsx` | `PrivacyNote` |
| `frontend/components/observability/use-developer-mode.ts` | `useDeveloperMode` hook |
| `frontend/lib/observability.ts` | Pure helpers: formatters, token split, receipt, timeline layout, summary, rate limits, reducer |
| `shared/contracts.ts` (lines ~385–500, 208) | Data types |
| `shared/privacy.ts` | `privacyLabels`, `describeFinding`, `scanText`, `maskValue` |
| `frontend/app/observability.css` | Effectively empty: section comments plus one unused `@keyframes obs-running` |
| `frontend/styles/v2/session.css` (lines 162–287) | All `.in-*` and `.tc-*` styles |
| `frontend/styles/v2/chat.css` (lines 37–48, 302–310) | `.msg-foot*` and `.composer-note*` |
| `frontend/styles/v2/tokens.css` (lines 97–103) | `--tone-*` colours and `.tone-*` classes |

There is no cost or currency data anywhere in the contracts or UI. The only "cost" is token counts. Latency is limited to `TurnTrace.totalMs`, `StepSpan.startMs/durationMs` and `TurnTiming`.

Component tree:

```
app/page.tsx (composer)
  └─ PrivacyNote {draft}
components/chat-messages.tsx (per assistant message group)
  ├─ TurnReceipt {trace, sessionId}        // finished turn with a trace
  │    └─ TraceCard {trace, sessionId, id}
  │         ├─ StepTimeline {trace}
  │         ├─ TokenBar {usage, helperUsage}
  │         │    ├─ StackedBar
  │         │    └─ Meter (context window)
  │         ├─ PrivacyCard {report}
  │         └─ DeveloperDetails {trace, sessionId}   // developer mode only
  └─ LiveUsage {usage}                     // turn still running
components/session-activity.tsx (panel === "insights")
  └─ InsightsPanel {traces, summary, rateLimits, liveUsage, timings, agents, skewMs}
       ├─ ShareBar (private)
       ├─ ColumnChart ×2
       └─ Meter × (0–2 rate limit meters)
```

---

### Data model (shared/contracts.ts, verbatim)

```ts
// --- Observability -------------------------------------------------------
// One timed step of a turn, in plain words. Built from Codex item events.
export type StepKind =
  | "thinking"
  | "message"
  | "command"
  | "tool"
  | "fileChange"
  | "webSearch"
  | "agent"
  | "other";
export interface StepSpan {
  id: string;
  kind: StepKind;
  // Plain-words label, e.g. "Ran a command", "Read 3 files". Never raw args.
  label: string;
  // "main" for the session's agent, else the helper's nickname or role.
  agent: string;
  agentThreadId: string;
  // Offset from the turn's start.
  startMs: number;
  durationMs: number | null;
  status: "running" | "completed" | "failed" | "declined";
}
// Token counts as Codex reports them (TokenUsageBreakdown).
export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
export interface TurnUsage extends TokenCounts {
  contextWindow: number | null;
  // Input tokens of the latest model request: how full the context window is.
  contextUsedTokens: number | null;
}
export interface RateLimitView {
  limitName: string | null;
  primaryUsedPercent: number | null;
  primaryWindowMins: number | null;
  primaryResetsAt: number | null;
  secondaryUsedPercent: number | null;
  secondaryWindowMins: number | null;
  secondaryResetsAt: number | null;
  reached: string | null;
  at: string;
}
export type PrivacyKind =
  | "email"
  | "phone"
  | "card"
  | "iban"
  | "ssn"
  | "aadhaar"
  | "pan"
  | "ip"
  | "secret";
export type PrivacySource =
  "userMessage" | "toolOutput" | "command" | "fileContent" | "assistant";
// Never holds a raw value: only the kind, where, how many and a masked sample.
export interface PrivacyFinding {
  kind: PrivacyKind;
  source: PrivacySource;
  count: number;
  sample: string;
}
export interface PrivacyReport {
  scannedChars: number;
  findings: PrivacyFinding[];
}
export interface TurnTrace {
  turnId: string;
  // Internal runtime id; stripped from public API responses.
  threadId?: string;
  startedAt: string;
  totalMs: number | null;
  status: string;
  model?: string;
  steps: StepSpan[];
  // Main agent usage for this turn ("last" breakdown), null if not reported.
  usage: TurnUsage | null;
  // Summed usage of helper agents that ran during this turn.
  helperUsage: TokenCounts | null;
  rateLimits: RateLimitView | null;
  privacy: PrivacyReport;
}
// Live-only, never persisted: masked reconstruction of what the model was fed.
export interface TurnContext {
  turnId: string;
  reconstructed: true;
  sections: {
    kind: "user" | "toolOutput" | "command" | "fileContent" | "assistant";
    label: string;
    text: string;
    chars: number;
  }[];
  truncated: boolean;
}
// GET /api/sessions/:id/traces response.
export interface TraceSummary {
  turns: number;
  avgTotalMs: number | null;
  p95TotalMs: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  helperTokens: number;
  privacyFindings: number;
}
export interface SessionTraces {
  traces: TurnTrace[];
  summary: TraceSummary;
}

// Streaming timing per turn (used by InsightsPanel "Streaming details")
export interface TurnTiming {
  turnId: string;
  acceptMs: number | null;
  ttftMs: number | null;
  streamMs: number;
  adapterStreamMs: number;
  idleStreamMs: number;
  maxGapMs: number;
  deltaRate: number;
  finalizeMs: number;
  totalMs: number;
  deltaCount: number;
  nonStreaming: boolean;
  status: string;
}
```

`InsightsPanel` also takes `SubAgent[]` (helper agents), which is documented in the sub-agents slice. It uses `a.threadId`, `a.status === "completed"`, and the `spawnOrder`, `helperName`, `elapsedMs` and `isRunning` helpers from `lib/subagents`.

#### Privacy vocabulary (shared/privacy.ts)

```ts
export const privacyLabels: Record<PrivacyKind, string> = {
  email: "email address",
  phone: "phone number",
  card: "card number",
  iban: "bank account (IBAN)",
  ssn: "social security number",
  aadhaar: "Aadhaar number",
  pan: "PAN number",
  ip: "IP address",
  secret: "secret or access key",
};
const sourceLabels: Record<PrivacySource, string> = {
  userMessage: "your message",
  toolOutput: "a tool output",
  command: "a command",
  fileContent: "file content",
  assistant: "the reply",
};
// "2 email addresses in a tool output"
export function describeFinding(f: PrivacyFinding) {
  const label = privacyLabels[f.kind];
  return `${f.count} ${label}${f.count > 1 ? "s" : ""} in ${sourceLabels[f.source]}`;
}
```

- `scanText(text, source)` returns `PrivacyFinding[]`, grouped by kind with a count and one masked sample. For example, an email becomes `j***@***.com`.
- `MAX_SCAN_CHARS = 200_000`.
- Raw values never reach the browser. Only the masked `sample` is shown.

---

### lib/observability.ts: derived metrics and formatters

#### Frontend-only types

```ts
export interface TokenSplit {
  newInput: number;
  cached: number;
  // Visible reply tokens: output minus reasoning.
  output: number;
  reasoning: number;
  total: number;
}
export interface PrivacyLine { tone: "ok" | "warn"; text: string; }
export interface Receipt {
  duration: string | null;
  tokens: string | null;
  privacy: PrivacyLine;
  label: string;
}
export interface TimelineStep {
  id: string;
  label: string;
  kind: StepKind;
  status: StepSpan["status"];
  startMs: number;
  durationMs: number | null;
  left: number;      // % of turn span
  width: number;     // % of turn span
  slowest: boolean;
  // Sub-row inside the lane, so overlapping steps never cover each other.
  row: number;
}
export interface TimelineLane {
  id: string; label: string; helper: boolean; rows: number; steps: TimelineStep[];
}
export interface Timeline { spanMs: number; lanes: TimelineLane[]; slowest: TimelineStep | null; }
export interface LimitMeter { label: string; usedPercent: number; resets: string | null; }
export interface ObservabilityState {
  // Completed turn traces, oldest first.
  traces: TurnTrace[];
  // Usage reported for turns that have no trace yet.
  liveUsage: Record<string, TurnUsage>;
  rateLimits: RateLimitView | null;
}
export const emptyObservability: ObservabilityState = { traces: [], liveUsage: {}, rateLimits: null };
```

#### Formatters (units and rounding)

`formatDuration(ms)` handles null, undefined and non-finite input by returning `"—"`. Negative values clamp to 0.

| Range | Output | Rule |
|---|---|---|
| < 1000 ms | `850ms` | `Math.round` |
| < 10 s | `4.2s` | Floored to one decimal (4.29 s becomes `4.2s`) |
| < 60 s | `42s` | `Math.round(v/1000)` |
| ≥ 60 s | `1m 5s`, or `2m` when seconds round to 0 | Minutes floored, seconds rounded |

`formatPercent(fraction)` takes a 0–1 value:

- null or non-finite gives `"—"`.
- A value between 0% and 1% gives `"<1%"`.
- Anything else gives `Math.round(p)%`. There is no upper clamp.

`formatTokens(n)` (from `lib/goal.ts`):

| Range | Output | Rule |
|---|---|---|
| < 1000 | `"842"` | Integer |
| < 100k | `"12.3k"` | One decimal, trailing zero dropped (`"12k"`) |
| ≥ 100k | `"128k"` | Whole k |

There is no "M" unit, so 1.2M tokens renders as `"1200k"`.

`InsightsPanel` has two local formatters:

- `inPct(part, total)` returns `"0%"` when the total or part is 0, `"<1%"` below 1%, and a rounded percentage otherwise.
- `inShortK(n)` returns whole k at 10,000 and above (`"13k"`), and falls back to `formatTokens` below that.

#### Token math

- `splitTokens(u)` handles the fact that Codex counts cached input inside input, and reasoning inside output:
  - `cached = clamp(cachedInputTokens, 0, inputTokens)`
  - `newInput = inputTokens − cached`
  - `reasoning = clamp(reasoningOutputTokens, 0, outputTokens)`
  - `output = outputTokens − reasoning`
  - `total` is the sum of the four parts.
  - Null input returns all zeros.
- `tokenSegments` gives the legend order and labels: `newInput` "New input", `cached` "Cached input", `output` "Reply", `reasoning` "Reasoning".
- `turnCounts(t)` adds `t.usage` and `t.helperUsage` field by field.
- `turnTokens(t)` returns `turnCounts(t)?.totalTokens ?? 0`. This covers the main agent plus helpers.
- `contextFraction(u)` returns `contextUsedTokens / contextWindow`, clamped to 0–1. It returns null when there is no window or `contextUsedTokens === null`.

#### Session summary

- `summarize(traces)` builds a `TraceSummary`:
  - `turns` is the trace count.
  - `avgTotalMs` is the mean of the numeric `totalMs` values.
  - `p95TotalMs` is `percentile(times, 0.95)`, using the nearest-rank method (`sorted[ceil(p·n)−1]`).
  - The main-agent token fields are summed from `t.usage`.
  - `helperTokens` sums `helperUsage.totalTokens`.
  - `privacyFindings` sums the finding counts.
- `cachedFraction(s)` returns `cachedInputTokens / inputTokens`, or null when there is no input.
- `totalTokens(s)` returns `inputTokens + outputTokens + helperTokens`. Reasoning is already inside output.

#### Privacy lines

- `findingCount(f)` returns the sum of `f.count`.
- `privacyLine(findings)`:
  - With no findings it returns `{tone:"ok", text:"No personal data detected"}`. The UI deliberately never says "clean".
  - Otherwise it returns `{tone:"warn", text: describeFinding(first) + " and N more"}`, where N is the summed count of the remaining findings.
- `draftNote(findings)`:
  - It de-duplicates by kind and picks "a" or "an" depending on whether the label starts with a vowel.
  - Output looks like: "This looks like a phone number and an email address. It will be sent to the model."
  - Three or more kinds are joined as "a, b and c".
  - With no findings it returns `""`.

#### Receipt

`receipt(t)`:

- `duration` is `formatDuration(totalMs)`, or null.
- `tokens` is `"${formatTokens(turnTokens)} tokens"`, or null when the total is 0.
- `privacy` is `privacyLine`.
- `label` is the accessible sentence: "Took 4.2s, used 12.3k tokens, No personal data detected".

#### Timeline layout

`timelineLayout(t, nowMs?)`:

- `spanMs = max(1, totalMs, nowMs, every step's start+duration)`.
- Lanes are keyed by agent: `"main"`, or for a helper, its `agentThreadId || agent`.
  - The main lane is labelled "Assistant". A helper lane uses `agent`, or "Helper".
  - The main lane is always first.
- `left = start/spanMs·100`.
- `width = min(100−left, max(1.5, dur/spanMs·100))`, so the minimum width is 1.5%.
- A running step, where `durationMs` is null, extends to the end of the span.
- Overlapping steps inside a lane get separate `row`s through greedy first-fit.
- `slowest` is the completed step with the largest duration. It is only set when the turn has more than one step.
- The label falls back to `stepKindLabels`:

```ts
{ thinking:"Thinking", message:"Writing the reply", command:"Ran a command", tool:"Used a tool",
  fileChange:"Changed files", webSearch:"Searched the web", agent:"Worked with a helper", other:"Other step" }
```

The final fallback is "Step".

#### Rate limits

- `windowLabel(mins)` maps window lengths to labels:
  - null or 0 gives "Usage limit".
  - 10080 gives "Weekly limit", and multiples give "N-week limit".
  - 1440 gives "Daily limit", and multiples give "N-day limit".
  - Multiples of 60 give "N-hour limit".
  - Anything else gives "N-minute limit".
- `resetsIn(resetsAt, now)`:
  - It accepts unix seconds when the value is below 1e12, and milliseconds otherwise.
  - A time in the past gives "resets now".
  - Under an hour gives "resets in 23m", rounding minutes up.
  - Under a day gives "resets in 3h 5m".
  - Longer gives "resets in 2d 4h".
- `limitMeters(r, now)` returns 0–2 `LimitMeter`s, primary then secondary. A meter is only included when its `*UsedPercent !== null`. Percentages are clamped to 0–100.

#### Reducer

`applyObservabilityEvent(state, DomainEvent)`:

| Event | Effect |
|---|---|
| `snapshot` | Merges `d.traces` by turnId (incoming wins, sorted by `startedAt`), drops `liveUsage` entries that now have traces, and replaces `rateLimits` when present |
| `usage.updated` | `liveUsage[event.turnId] = d.usage` |
| `limits.updated` | `rateLimits = d.rateLimits` |
| `turn.completed` | Merges `d.trace`, drops its liveUsage entry, and sets `rateLimits = trace.rateLimits ?? previous` |

This reducer is where the live-to-completed transition happens. While a turn runs it only has an entry in `liveUsage`. On `turn.completed` it becomes a `TurnTrace`.

---

### TurnReceipt

- File: `frontend/components/observability/receipt.tsx`.
- Purpose: level 1. It is a single clickable line under a finished assistant answer that expands the `TraceCard`.
- Parent: `components/chat-messages.tsx`. It renders when `traceByTurn.has(turnId) && !active`, at the message index where the receipt belongs (`receiptAt`).

Props:

```ts
{ trace: TurnTrace; sessionId?: string }
```

State:

- `open: boolean`, false by default.
- `reduce`: the result of `useReducedMotion()`.

Derived:

- `r = receipt(trace)`.
- `cardId = "trace-" + turnId`, with non-word characters replaced by `-`.
- The shield icon is `ShieldAlert` (lucide) when `r.privacy.tone === "warn"`, and `ShieldCheck` otherwise.

Render:

- `div.msg-foot` contains `button.msg-foot-btn` (plus `.warn` when privacy is warn). The button holds:
  - `<span>{duration · tokens}</span>`, with null parts dropped. For example: "4.2s · 12.3k tokens".
  - `span.msg-foot-privacy`, with a 12px shield and the privacy text.
  - A `chevron` icon (12px) with class `msg-foot-chevron`, plus `.open` when expanded, which rotates it 180°.
- ARIA: `aria-expanded`, `aria-controls={cardId}` while open, and `aria-label="{r.label}. Show|Hide details"`.
- The expanded body is a `motion.div` inside `AnimatePresence`:
  - It animates height 0 to auto and opacity 0 to 1 over 0.2s with easeOut.
  - With reduced motion it only fades.
  - It uses `overflow:hidden`.
  - It contains `<TraceCard id={cardId}>`.

Visual states:

- Collapsed and expanded.
- Neutral (ok privacy) and warn. In the warn state the privacy span uses `--warning-text`.
- Duration and/or tokens may be missing. The privacy text is always present.

CSS (chat.css):

- `.msg-foot`: 12px, `--ink-3`, tabular numbers, margin-top 10px.
- `.msg-foot-btn`: an inline-flex wrap with gap `4px 8px` and no chrome. Hover sets `--ink-2`.
- Spans after the first get a "·" separator through `::before`.
- `.msg-foot-chevron` has a `.15s` transform transition.

### LiveUsage

- File: `receipt.tsx`.
- Purpose: the running-turn placeholder for the receipt. Only a live token count is known at this point.
- Parent: `chat-messages.tsx`, when `active && liveUsage[turnId]`.

Props:

```ts
{ usage: TurnUsage }
```

State: none.

Derived: `total = turnTokens({usage, helperUsage:null})`, which is the main agent only.

Render:

- If `total` is 0, it renders nothing.
- Otherwise it renders `<p class="msg-foot live" aria-live="off"><span>{formatTokens(total)} tokens so far</span></p>`.

Visual states:

- Hidden (zero tokens) or showing a live count.
- It is not interactive and has no duration.
- There is no dedicated `.msg-foot.live` CSS rule, so it inherits `.msg-foot`.

### TraceCard

- File: `frontend/components/observability/trace-card.tsx`.
- Purpose: level 2. It is the per-turn details card, covering time, tokens and privacy, plus the developer toggle.
- Parent: `TurnReceipt`.

Props:

```ts
{ trace: TurnTrace; sessionId?: string; id: string }
```

State: `[developer, setDeveloper] = useDeveloperMode()`, a global preference that is persisted.

Render: `section.tc#{id}[aria-label="Turn details"]` contains three `.tc-section` blocks, each with an `h4` whose right-side `<span>` holds mono metadata:

1. "Where the time went", with `<span>{formatDuration(totalMs)} total</span>`, followed by `StepTimeline`.
2. "What it used", with `<span>{trace.model}</span>` when a model is set, followed by `TokenBar`.
3. "Your data", followed by `PrivacyCard`.

After the sections:

- `label.tc-dev-toggle` holds a checkbox and a lucide `Code2` icon (13px) labelled "Developer details".
- `{developer && <DeveloperDetails/>}`.

Normal mode vs developer mode:

- Normal mode shows the three sections and an unchecked toggle.
- Developer mode also shows the `DeveloperDetails` block.
- The toggle is shared by every trace card on the page and remembered across reloads (see `useDeveloperMode`).

CSS (session.css):

- `.tc`: a flex column with gap 12, padding 12, margin-top 8, 1px `--line` border, radius 12, `--surface` background, 13px text in `--ink-2`.
- `.tc-section`: a column with gap 8. Adjacent sections get a top border and 12px padding.
- `.tc-section h4`: 13/600 `--ink`, space-between. Its `span` is 12px `--font-mono` in `--ink-3`.
- `.tc-dev-toggle`: 12px `--ink-3`, with the checkbox `accent-color: var(--accent)`.

### DeveloperDetails (private to trace-card.tsx)

- Purpose: level 3. It shows turn and thread ids, the reconstructed prompt ("What the model saw"), and the raw trace JSON with view and copy actions.
- Parent: `TraceCard`, only when developer mode is on.

Props:

```ts
{ trace: TurnTrace; sessionId?: string }
```

State:

```ts
type ContextState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "gone" }
  | { state: "error"; message: string }
  | { state: "ready"; context: TurnContext };
const [context, setContext] = useState<ContextState>({ state: "idle" });
const [copied, setCopied] = useState(false);   // resets after 1500ms
const [showRaw, setShowRaw] = useState(false);
```

Derived: `json = JSON.stringify(trace, null, 2)`.

Behaviour:

- `loadContext()` calls `getTurnContext(sessionId, turnId)` from `lib/api`.
  - With no `sessionId` it goes straight to `gone`.
  - A 404 `ApiRequestError`, or a response without a `sections` array, also gives `gone`.
  - Any other error gives `error` with the error message.
- `copy()` writes the JSON with `navigator.clipboard.writeText`. If that fails it falls back to showing the raw JSON (`showRaw=true`).

Render:

- `dl.tc-ids` lists Turn `<code>{turnId}</code>`, Thread `<code>{threadId}</code>`, and Status `{status}`.
  - `threadId` is stripped from public API responses, so it can be empty.
- `div.tc-dev-actions` holds three `button.link` actions:
  - "What the model saw". It shows "Loading…" and is disabled while loading. It has `aria-expanded` when ready.
  - "Show trace JSON" or "Hide trace JSON", with `aria-expanded`.
  - "Copy trace JSON", with a `doc` icon, which changes to "Copied" with a `check` icon.
  - An `sr-only` `role=status` element announces "Trace JSON copied".
- `gone` shows `p.tc-note[role=status]`: "No longer available, context is kept only while the session is live."
- `error` shows `p.tc-note[role=status]` containing the error message.
- `ready` shows `div.tc-context`:
  - A note: `span.tc-tag` "Reconstructed" followed by "Rebuilt from the turn's events with personal data masked. It may differ from the exact prompt."
  - One `details.tc-context-section` per section. Each `summary` shows the label and "{chars.toLocaleString()} chars", and the body is `<pre>{text}</pre>`.
  - When there are no sections: "Nothing was recorded for this turn."
  - When `truncated`: "Long sections were shortened."
- When `showRaw` is on: `pre.tc-json[tabIndex=0][aria-label="Trace JSON"]`.

Visual states:

- Context: idle, loading, ready (with sections, empty, or truncated), gone, error.
- Copy: idle, copied (1.5 s).
- Raw JSON: shown or hidden.

CSS:

- `.tc-dev`: a column with gap 10.
- `.tc-ids`: a 2-column grid at 12px. `dt` is `--ink-3`, `code` is 11.5px mono.
- `.tc-dev-actions`: a flex wrap with gap `4px 14px`.
- `.tc-context pre` and `.tc-json`: max-height 280px with scroll, padding 10, radius 8, `--surface-3` background, 11.5/1.5 mono, pre-wrap. `.tc-json:focus-visible` gets an `--accent-2` outline.
- `.tc-tag`: an 18px pill with `--warning-bg`/`--warning-text` at 11px/500.

### StepTimeline

- File: `frontend/components/observability/step-timeline.tsx`.
- Purpose: "Where the time went". It is a Gantt-style chart of steps with one lane per agent, and an ordered step list that doubles as the text alternative.
- Parent: `TraceCard`.

Props:

```ts
{ trace: TurnTrace }
```

State: none. It calls `timelineLayout(trace)` without `nowMs`, so it is only used on completed turns.

Chart:

- A horizontal Gantt chart. The x axis is time from 0 to `spanMs`, positioned as percentages. The y axis is lanes: "Assistant" first, then helper lanes.
- Each lane is a `.tc-lane` grid (72px name column, then the track).
- Track height is `rows·14 + (rows−1)·4` px.
- Each step is an absolutely positioned `<i class="tc-step">`:
  - `left`/`width` come from the layout, in %.
  - `top = row·18` px.
  - It carries a native `title` of "{label} · {duration}".
- The axis row, `.tc-axis`, shows only two ticks: "0s" and `formatDuration(spanMs)`.
- The whole chart is `aria-hidden`.

Step modifiers:

| Class | When | Colour |
|---|---|---|
| (base) | Main-agent step | `--tone-main` |
| `is-helper` | Helper lane | `--tone-0` |
| `is-slowest` | Slowest completed step, when there is more than one step | `--warning-text` |
| `is-failed` | Status `failed` or `declined` | `--error-text` |
| `is-running` | Status `running` | `ag-pulse` animation, 1.4s, opacity drops to .55 at 50% |

The step list is `ol.tc-steps[aria-label="Steps in order"]`, sorted by start time. Each item shows:

- `.tc-step-name`: the label, plus `span.tc-step-agent` " · {lane label}" for helper steps.
- `.tc-step-time`, depending on status:
  - running: "Running…"
  - failed: "Failed after {dur}"
  - declined: "Declined"
  - otherwise: `formatDuration(durationMs)`
- `span.tc-tag` "Slowest" on the slowest step. That `li` gets `.is-slowest`, which colours the time in the warning colour.

Visual states:

- Empty: `p.tc-empty` "No steps were recorded for this turn."
- Single lane or multiple lanes (with helpers).
- Overlapping rows.
- Running, failed or declined steps, and the slowest highlight.

CSS:

- `.tc-lanes`: gap 6.
- `.tc-lane-name`: 12px, ellipsis.
- `.tc-track`: `--surface-3`, radius 4.
- `.tc-step`: 14px high, min-width 3px, radius 4.
- `.tc-axis`: 10.5px mono in `--ink-3`.
- `.tc-steps li`: 12.5px, top border, 5px vertical padding.
- `.tc-step-time`: 12px mono in `--ink-3`.

### TokenBar

- File: `frontend/components/observability/token-bar.tsx`.
- Purpose: "What it used". It shows the turn's token split and how full the context window is.
- Parent: `TraceCard`.

Props:

```ts
{ usage: TurnUsage | null; helperUsage?: TokenCounts | null }
```

State: none.

Tone map:

```ts
const tones = { newInput: "seg-new", cached: "seg-cached", output: "seg-output", reasoning: "seg-reasoning" };
```

Render:

- If `usage` is null: `p.tc-empty` "Token usage was not reported for this turn."
- Otherwise a `.tc-section` containing:
  - `StackedBar`, labelled "Tokens this turn" and formatted with `formatTokens`. It has four segments from `splitTokens(usage)` in `tokenSegments` order.
  - When `helperUsage.totalTokens` is non-zero: `p.tc-note` "Helpers used another {n} tokens." Helper tokens are not part of the bar.
  - When `contextFraction(usage) !== null`: a `Meter` labelled "Context window", with caption "{formatPercent} of context" and detail "{used} of {window} tokens". It uses the default thresholds of 0.75 (warn) and 0.9 (crit).

Visual states: not reported, bar only, bar with helper note, bar with context meter (normal, warn or crit).

### StackedBar (charts.tsx)

- Purpose: a horizontal part-to-whole bar with a legend that always shows values.
- Parent: `TokenBar`.

Props:

```ts
export interface Segment {
  key: string;
  label: string;
  value: number;
  // CSS modifier naming the fill, e.g. "seg-new".
  tone: string;
}
{ segments: Segment[]; label: string; format: (n: number) => string }
```

State: none.

Chart:

- A flex bar (`div.in-stack[role=img]`). Only segments with a value above 0 render.
- Each segment is `<i class="in-seg {tone}" style="flex-grow:value" title="{label}: {v}">`.
- If the total is 0, a single `i.in-seg.is-empty` fills the bar with `--surface-3`.
- The aria-label reads "{label}: New input 1.2k, Cached input 8k, …", or "{label}: none".

Legend:

- `ul.in-keys[aria-hidden]` lists every segment, including zero ones.
- Each entry has an `i.in-key.{tone}` swatch, a label `span`, and `<b>{format(value)}</b>`.
- Zero-value entries get `li.is-zero`, which uses `--ink-3`.

Colours:

| Class | Colour |
|---|---|
| `seg-new` | `--accent` |
| `seg-cached` | `--accent-soft-2` |
| `seg-output` | `--ink-2` |
| `seg-reasoning` | `--ink-3` |

CSS:

- `.in-meter-block`: a column with gap 6.
- `.in-stack`: flex, gap 2px, height 14px, radius 4.
- `.in-seg`: min-width 2px. First, last and only segments get rounded ends.
- `.in-keys`: a wrapping flex list, 12px, gap `4px 12px`.
- `.in-key`: a 10×10 swatch with radius 3.

### Meter (charts.tsx)

- Purpose: a single 0–1 gauge with a caption.
- Parents: `TokenBar` (context window) and `InsightsPanel` (usage limits).

Props:

```ts
{ value: number; label: string; caption: string; detail?: string | null; high?: number /*0.75*/; critical?: number /*0.9*/ }
```

State: none. `value` is clamped to 0–1.

Render:

- `div.in-meter-block` contains:
  - `div.in-meter-head`, with `<span>{label}</span>` and `<b>{caption}</b>`.
  - `div.in-meter[role=meter]`, with `aria-valuenow` as a rounded percentage and `aria-valuetext = caption, detail`. Its fill is `<span style="width:{v·100}%">`.
  - When `detail` is set: `span.muted.sm` containing the detail.

Visual states:

| State | Condition | Track | Fill |
|---|---|---|---|
| normal | below `high` | `--accent-soft` | `--accent-2` |
| `is-warn` | ≥ `high` | `--warning-bg` | `--warning-text` |
| `is-crit` | ≥ `critical` | `--error-bg` | `--error-text` |

Other details:

- The fill animates width over `.4s`.
- The track is 8px high with radius 4.
- The fill has a min-width of 2px.

### ColumnChart (charts.tsx)

- Purpose: a vertical column chart with one column per turn and optional stacking.
- Parent: `InsightsPanel`, used twice.

Props:

```ts
export interface Column {
  id: string;
  // Short axis/tooltip label, e.g. "Turn 3".
  label: string;
  segments: { value: number; tone: string; label: string }[];
  highlight?: boolean;
}
{ columns: Column[]; title: string; summary: string; format: (n: number) => string; height?: number /*64*/ }
```

State: none.

Chart:

- An SVG with `svg.in-cols`, `viewBox = 0 0 (n·12) height` and `preserveAspectRatio="none"`, so it stretches to full width.
  - Each column slot is 12 units wide, with an 8-unit bar centred in it.
  - The y scale is linear, running from 0 to `max(1, max column total)` over `height−2`.
- There are no axis ticks or labels. The only axis mark is a baseline `line.in-base` (`--line`, non-scaling stroke).
- Segments stack bottom-up with a 1-unit gap between them. Each has `rx=1` and a minimum height of 0.5.
- Each column is a `<g>` (with `.is-high` when highlighted) and contains:
  - A `<title>` tooltip: "{label}: {total}", plus " (seg v, seg v)" when there are several segments.
  - A full-height transparent `rect.in-hit` hit target.
- Hover on a column sets its `.in-col` to opacity .8.
- The chart's `aria-label` and `<title>` are "{title}. {summary}".

Fills:

| Class | Fill |
|---|---|
| `.in-col` (default) | `--accent-2` |
| `seg-new` | `--accent` |
| `seg-cached` | `--accent-soft-2` |
| `seg-output` | `--ink-2` |
| `seg-reasoning` | `--ink-3` |
| `seg-time` | `--accent-soft-2` |
| `g.is-high .seg-time` | `--warning-text` |

### InsightsPanel

- File: `frontend/components/observability/insights-panel.tsx`.
- Purpose: session-level answers to "how fast, how much, how safe, how close to limits".
- Parent: `components/session-activity.tsx`, when `panel === "insights"`. It is passed `traces`, `traceSummary`, `rateLimits`, `liveUsage`, `timings`, `agents`, and `subAgents?.skewMs`.

Props:

```ts
{
  traces: TurnTrace[];
  summary?: TraceSummary | null;
  rateLimits: RateLimitView | null;
  liveUsage?: TurnUsage | null;
  timings: TurnTiming[];
  agents?: SubAgent[];   // default []
  skewMs?: number;
}
```

State:

- None of its own, apart from the `ShareBar` child's hover state.
- `now = useClock(!!rateLimits || agents.some(isRunning))`. This is a shared 1-second interval that is only active while there are rate limits or a running helper. It drives the reset countdowns and helper elapsed times.

Derived:

- `s`: the server `summary` if `summary.turns === traces.length`, otherwise `summarize(traces)`. Live traces win over a stale fetched summary.
- `meters = limitMeters(rateLimits, now)`.
- `contextUsage = liveUsage ?? traces.at(-1)?.usage ?? null`, and `context = contextFraction(contextUsage)`.
- `times = traces.map(t => t.totalMs ?? 0)`.
- `slowestMs = max(times)`, or null when there are no traces.
- `slowest = max(times)` only when there is more than one trace, otherwise −1. This value is used for the column highlight.
- `cached = cachedFraction(s)`.
- `mainTokens = s.inputTokens + s.outputTokens`, `helperTokens = s.helperTokens`, and `total = totalTokens(s)`.
- `helpers`: agents in `spawnOrder`, each with `name = helperName(a, agents)`, `tone = i % 3` (tone-0 to tone-2), and `elapsed = elapsedMs(a, now, skewMs)`.
- `finished` is the number of helpers with `status === "completed"`.
- `shares`: Main agent (`tone-main`) and, when helper tokens exist, Helpers (`tone-0`). Per-helper token counts are not reported.
- `timeRows`: Main agent with the sum of all turn `totalMs`, then one row per helper with its elapsed time and `tone-{i%3}`.
- `maxTime = max(1, …row values)`.
- `ctxPct = context·100`.

Empty state:

- Shown when there are no traces, no meters and `context === null`.
- It renders `div.empty-tab` containing:
  - `span.tile.lg` with a `chart` icon (20px)
  - `span.strong` "No insights yet"
  - `span.muted.sm` "Timing and usage for each response will appear here."

Sections, in order. Each card is `section.in-card[aria-labelledby]`, with `.in-card-head` holding `h3.in-card-title` and an optional `span.muted.sm` on the right.

1. KPI row, `dl.in-kpis`. Each `div.in-kpi` has a `dt` label, a `dd` value (20px/600) and an `.in-sub` line.

   | KPI | Value | Sub-line | Condition |
   |---|---|---|---|
   | Average time | `formatDuration(avgTotalMs)` | "{n} response(s)" | Always |
   | Slowest | `formatDuration(slowestMs)` | "Slowest 5% {p95}" when there is more than one turn | Always |
   | Tokens | `formatTokens(total)` | "{helperTokens} from helpers" when helpers used tokens, otherwise "{formatPercent(cached)} cached" | Always |
   | Helpers | `helpers.length` | "{n} finished" when at least one finished | Only when there are helpers |
   | Personal data | Count, or "None" | "Pattern checks on sent text" | Always. Gets `.is-warn` (warning background and text) when the count is above 0 |

2. Tokens by agent (when `total > 0`).
   - The header right side shows "{total} total".
   - The chart is `ShareBar`.
   - Below it is a legend `table.in-legend` with an sr-only caption and header. Each row has class `{tone}` and contains an `i.in-swatch`, the name, a right-aligned token count, and a muted share `inPct`.

3. Time by agent (when there are traces).
   - A horizontal bar list, `.in-rows`. Each `div.in-row.{tone}` is a 3-column grid: name (`minmax(56px,32%)`, ellipsis), track, and value (mono, `formatDuration`).
   - Bar width is `max(1%, value/maxTime·100%)`, with a right-rounded end and a `.4s` width transition.
   - When there are helpers, a muted note reads "Helpers run in parallel, so their times overlap."

4. Main agent context (when `context !== null`).
   - The header right side shows "{inShortK(used)} of {inShortK(window)} · {formatPercent}".
   - An inline `div.in-meter` (not the `Meter` component) is built by hand at the 75% warn and 90% crit thresholds, with `role=meter`.
   - `p.in-note` reads "Only the main agent's context is shown." When helpers used tokens it adds: "Helpers use their own context windows, so their tokens don't fill this one."
   - The meter reflects live usage while a turn runs.

5. Time per response (when there are traces).
   - The header right side shows "{n} response(s)".
   - `ColumnChart` with one `seg-time` segment per trace, labelled "Response {i+1}".
   - The slowest column is highlighted (warning fill) when there is more than one trace and the slowest time is above 0.
   - Summary: "Average {avg}, slowest {max}".

6. Tokens per response (when there are traces).
   - The header right side shows "{max turnTokens} max".
   - `ColumnChart` stacked in three segments:
     - `seg-new` "New input"
     - `seg-cached` "Cached"
     - `seg-output` "Output", which is reply + reasoning + helper total. Reasoning is not shown separately here.
   - Summary: "{total} tokens in total, {cached%} of input cached".
   - A static `ul.in-keys` legend with the three swatches and no values.

7. Usage limits (when there is at least one meter).
   - One `Meter` per window, with the label from `windowLabel`, caption "{round}% used", and the detail from `resetsIn`. The detail updates every second through `useClock`.
   - When `rateLimits.reached` is truthy: `p.in-note.is-warn[role=status]` "Usage limit reached. New requests may wait until it resets."

8. Streaming details (when there are timings). This is a collapsed `details.in-card.in-details`.
   - The summary reads "Streaming details".
   - Each timing is a `div.in-timing` containing:
     - "**Turn {i+1}** · {status}" and, when applicable, " · non-streaming".
     - A 6px three-part bar, `.in-timing-bar`. Its three `<i>` children use widths `ttftMs/totalMs`, `streamMs/totalMs` and `finalizeMs/totalMs`, in `--accent-soft-2`, `--accent-2` and `--ink-3`, on a `--surface-3` track.
     - A muted caption: "First output {ttft} · stream {stream} · total {total}".
   - This is the most developer-facing block. It is always available and not gated by developer mode.

Visual states:

- Empty.
- Limits-only or context-only. These happen before any trace exists, for example while the first turn is running with `liveUsage`.
- Populated with one turn. The p95 sub-line and the slowest highlight are hidden.
- Populated with several turns.
- With helpers running. The clock ticks and the elapsed rows grow.
- Privacy warn KPI.
- Context warn or crit.
- Limit reached.

There is no loading or error state. The data arrives through the parent's reducer.

CSS (session.css):

- `.in`: a column with gap 12.
- `.in-kpis`: an auto-fit grid with `minmax(130px,1fr)` columns and gap 8.
- `.in-kpi`: padding 10/12, 1px `--line` border, `--radius`, `--surface`. `.is-warn` uses `--warning-bg` with a transparent border.
- `.in-card`: a column with gap 12, padding 12, border, `--radius`, `--surface`.
- `.in-card-title`: 13/600.
- `.in-legend`: 12px, rows separated by a top border, `.num` tabular and right-aligned.
- `.in-swatch`: 10×10, radius 3, `background: var(--t)`.
- `.in-note`: `--surface-2`, radius 8, 12px/1.45. `.is-warn` uses warning colours.
- `.in-details > summary`: 13/600, pointer cursor.

Tone tokens (tokens.css):

- `.tone-0`, `.tone-1`, `.tone-2` and `.tone-main` set `--t` and `--ts`.

| Token | Light | Dark |
|---|---|---|
| `--tone-0` | `#2872b8` | `#3691cd` |
| `--tone-1` | `#0f7a55` | `#199e70` |
| `--tone-2` | `#b84a1b` | `#d95926` |
| `--tone-main` | `#6b6b6b` | `#8f8f8f` |

### ShareBar (private, insights-panel.tsx)

- Purpose: an interactive part-to-whole bar for "Tokens by agent", with a tooltip that never overflows.
- Parent: `InsightsPanel`.

Props:

```ts
interface Share { key: string; label: string; value: number; tone: string; }
{ shares: Share[]; total: number }
```

State: `hover: number | null`, the index of the hovered or focused segment.

Derived:

- `spans` lists the visible segments (value above 0), each with `start` and `end` as percentages.
- Tooltip placement depends on the segment midpoint:
  - Midpoint below 25%: anchored with `left: start%`.
  - Midpoint above 75%: anchored with `right: (100−end)%`.
  - Otherwise: centred at `left: mid%` with `translateX(-50%)`.

Interaction:

- The bar has `tabIndex=0`.
- Focus selects the first segment.
- ArrowLeft and ArrowRight cycle through segments, wrapping at the ends.
- Mouse enter on a segment selects it. Mouse leave or blur clears the selection.

Render:

- `div.in-stack-wrap` contains `div.in-stack[role=img]`, plus `.is-hovering` while a segment is selected.
- Each segment is `i.in-seg.{tone}`, plus `.is-hover` when selected. While hovering, the other segments drop to opacity .55.
- The tooltip is `div.in-tip[aria-hidden]`, absolutely positioned 6px above the bar. It shows `<b>{label}</b>` followed by "{tokens} · {pct}".
- The aria-label reads "Tokens by agent: Main agent 12k, 80%; Helpers 3k, 20%".

CSS:

- `.in-tip`: padding 6/8, border, radius 8, `--surface`, `--shadow-md`, 12px text, nowrap, `pointer-events:none`.
- `.in-stack:focus-visible`: a 2px `--ink` outline.

### PrivacyCard

- File: `frontend/components/observability/privacy-card.tsx`.
- Purpose: "Your data". It lists what pattern checks detected in text the model saw. Only masked samples are shown.
- Parent: `TraceCard`.

Props:

```ts
{ report: PrivacyReport }
```

State: none.

Render, when there are no findings (the "ok" state):

- `div.tc-privacy` with a success background and text colour.
- `p.tc-privacy-head` shows the `ShieldCheck` icon (15px) and "No personal data detected".
- `p.tc-note` reads: "Checked {scannedChars.toLocaleString()} characters for emails, phone numbers, card and account numbers, IDs and access keys. Pattern checks can miss things."

Render, when there are findings (the warn state):

- `div.tc-privacy.is-warn`.
- The head shows the `ShieldAlert` icon and "Personal data detected".
- A `ul` has one `li` per finding (key `kind:source`), containing `<span>{describeFinding(f)}</span>` and `<code aria-label="Masked sample …">{f.sample}</code>`.
- `p.tc-note` reads: "This was sent to the model as part of the turn. Samples are masked."

Icons: lucide shields are used because the v2 icon set has no shield.

CSS:

- `.tc-privacy`: a column with gap 6, padding 10/12, radius 10, `--success-bg`/`--success-text`. `.is-warn` uses `--warning-bg`/`--warning-text`.
- `.tc-privacy-head`: 13/600.
- `li`: space-between, 12.5px.
- `code`: 12px mono.
- `.tc-note` inside the card: inherits colour at opacity .85.

### PrivacyNote

- File: `frontend/components/observability/privacy-note.tsx`.
- Purpose: a soft, non-blocking warning while typing when the draft looks like it contains PII. Once dismissed, it stays hidden until the draft is cleared.
- Parent: `app/page.tsx`, inside the composer's top slot, after the pending-project chip.

Props:

```ts
{ draft: string }
```

State:

- `note: string`, the current warning text.
- `dismissed: string`, the note text the user dismissed.

Behaviour:

- A blank draft clears both states immediately.
- Otherwise the draft is debounced by 250 ms, then the note is set to `draftNote(scanText(draft, "userMessage"))`.
- The note is hidden when it is empty or equals `dismissed`. A different kind set produces new note text, which makes the note reappear.
- Scanning runs entirely client-side.

Render:

- `div.composer-note.is-warn[role=status]` contains:
  - The `ShieldAlert` icon (14px).
  - `<span>{note}</span>`, for example "This looks like a phone number and an email address. It will be sent to the model."
  - `button.icon-btn.ghost[aria-label="Dismiss privacy note"]` with an `x` icon (13px).

Visual states: hidden, visible (warn), dismissed.

CSS (chat.css):

- `.composer-note`: flex, `align-items:flex-start`, gap 8, margin `-4px 0 8px`, padding `7px 6px 7px 10px`, radius 10, 12.5px/1.45.
- `.is-warn`: `--warning-bg`/`--warning-text`.
- The ghost button is 22×22 and inherits colour. Hover gives it a 12% `currentColor` mix.

### useDeveloperMode (hook)

- File: `frontend/components/observability/use-developer-mode.ts`.
- Purpose: a global, persisted "Developer details" preference shared by every `TraceCard` on the page.
- Used by: `TraceCard`.

Signature:

```ts
export function useDeveloperMode(): readonly [boolean, (next: boolean) => void]
```

Storage:

- It uses the `localStorage` key `"truex:observability:developer"`. `"1"` means on, and a missing key means off.
- Every access is wrapped in try/catch. If storage is unavailable, the toggle still works for the current page view.

State:

- Local `on` starts as `false` so the server and client render the same markup. It is read from storage after mount.
- A module-level `listeners: Set<(on:boolean)=>void>` broadcasts changes, so toggling one card updates all open cards at once.

What developer mode changes:

- It only adds the `DeveloperDetails` block to `TraceCard`: ids and status, "What the model saw", and the JSON view and copy actions.
- The receipt, the timeline, tokens and privacy sections, and `InsightsPanel` are all identical in both modes. The InsightsPanel "Streaming details" block is not gated.

---

### Cross-cutting notes for the redesign

- Colour conventions (from the `observability.css` header comment): colour is used only for meaning. `--warn` marks slow steps and privacy findings. Everything else stays in the neutral and accent tokens.
  - Error colours are used for failed steps and critical meters.
  - Success colours are used for the "no personal data" card.
- Accessibility patterns to keep:
  - Every chart has a text alternative: `role=img` with an aria-label, SVG `<title>`, or the step list.
  - Legends always show values.
  - Meters use `role=meter` with value text.
  - Copied and error messages use `role=status`.
  - `ShareBar` is keyboard navigable.
- Motion:
  - The receipt expand is 0.2 s and respects reduced motion.
  - The chevron rotates in .15 s.
  - Meter and row widths animate over .4 s.
  - Running steps pulse (`ag-pulse` 1.4 s).
  - `@keyframes obs-running` in `app/observability.css` is defined but unused.
- Visual states by lifecycle:
  - Running: `LiveUsage` count, and live context in `InsightsPanel`.
  - Completed: `TurnReceipt` and `TraceCard`.
  - Missing data:
    - Timeline: "No steps were recorded for this turn."
    - Tokens: "Token usage was not reported for this turn."
    - Formatters fall back to "—".
  - Error: only the developer-mode context fetch has error states (`error`, and `gone` for a 404 or a session that is no longer live). Nothing else fetches.
- Data gaps a designer may be tempted to show but that do not exist:
  - Cost in currency.
  - Per-helper token counts. Helpers share one "Helpers" segment.
  - Per-step token counts.
  - A timeline for running turns in the card. The card only exists after completion.


## 7. Data Contracts, API & Streaming

Sources read: `shared/contracts.ts`, `shared/assistant-capabilities.ts`, `shared/business-capabilities.ts`, `shared/visualizations.ts`, `shared/errors.ts`, `frontend/lib/{api,transport,mock,projects,utils,agents,approval-mode,chat,plan,request-input,document-kind}.ts`, `platform/src/{index,http,public,service,auth,user,access,tenant,features}.ts`, `docs/protocol.md`. Routes are registered in `platform/src/index.ts` (not `http.ts`, which holds middleware and stream error framing).

Important for designers: the browser never sees raw runtime (Codex) data. Everything passes through allowlist projections in `platform/src/public.ts` (`publicSession`, `publicSnapshot`, `publicEvent`, `publicApproval`, `publicTrace`...). Where the projected shape differs from the `shared/contracts.ts` type, this doc shows the projected shape, because that is what the UI receives.

---

### 7.1 Client plumbing (`frontend/lib/api.ts`)

- Base URL: `NEXT_PUBLIC_PLATFORM_URL`, default `http://localhost:4000`.
- `api(path, body?)`: `body === undefined` means GET, otherwise POST with JSON. No other verbs. 45 s timeout (`AbortSignal.timeout(45000)`). 204 returns `undefined`.
- No `credentials: "include"` is set on `fetch`, and `EventSource` is created without `withCredentials` (observed; relevant once Google cookie auth is on cross-origin).
- Every failure throws `ApiRequestError`:

```ts
class ApiRequestError extends Error {
  status: number;      // HTTP status, 0 for network/timeout
  code: string;        // server `code`, or HTTP_<status>, NETWORK_ERROR, REQUEST_TIMEOUT, INVALID_RESPONSE
  requestId?: string;  // from body.requestId or x-request-id header
}
interface ErrorRef { code?: string; requestId?: string; turnId?: string } // shown under errors for support
```

- Server error body (`errorHandler`): `{ error: string, code: string, requestId: string }`. The UI shows `error` verbatim when present; otherwise a fixed per-status message:

| Status | Fallback message |
|---|---|
| 400 | The request is invalid. Check your input. |
| 401 | Your session is not authenticated. Sign in again. |
| 403 | You do not have permission to perform this operation. |
| 404 | The requested conversation, agent, or file was not found. |
| 409 | The request conflicts with the conversation's current state. Refresh it before retrying. |
| 413 | The request is too large. Reduce the attachment or message size. |
| 422 | The request could not be processed. Check your input and agent configuration. |
| 429 | Too many requests. Wait before trying again. |
| 502 / 503 / 504 | Invalid response / temporarily unavailable / timed out (may have been accepted) |

- Helpers: `userMessage(err, fallback)`, `errorRef(err)`, `warnFailure(tag, err)` (quiet background failures).
- `lib/utils.ts` only exports `cn(...)` (clsx + tailwind-merge).

Common server error codes the UI can meet: `INVALID_INPUT`, `INVALID_JSON`, `REQUEST_TOO_LARGE`, `CONFLICT`, `STORAGE_UNAVAILABLE`, `PLATFORM_INTERNAL`, `UNAUTHENTICATED` (401), `WRONG_APP` (403), `CSRF_ORIGIN` (403), `RATE_LIMITED` (429, /auth only, 60/min), `CAPABILITY_DENIED` (403), `SESSION_NOT_FOUND` / `PROJECT_NOT_FOUND` (404), `NOT_SESSION_OWNER` / `NOT_PROJECT_OWNER` (403), `THREAD_LOST` (410), `OWNER_UNAVAILABLE` / `OWNER_UNCONFIGURED` / `STREAM_UNAVAILABLE` (503/502), `DUPLICATE_MESSAGE` (409), `FEATURE_DISABLED` (404), `INVALID_APPROVAL_MODE` (422), `INVALID_REVIEW` (400), `GOAL_NOT_COMPLETE` (409), `MODEL_UNAVAILABLE` (422), `AGENT_HANDLE_TAKEN` (409), `INVALID_PROJECT`, `TENANT_DISABLED` (403), `NOT_A_MEMBER` (403).

---

### 7.2 API inventory (everything the frontend calls)

All paths are relative to the platform base. `:id` is a session id (`sess_<uuid>`).

#### Identity, config, catalog

| Frontend caller | Method + path | Request | Response | Notes / errors |
|---|---|---|---|---|
| `app/page.tsx` health probe | GET `/healthz` (raw `fetch`, 10 s) | – | `{ ok, mongo: boolean, agentCore: { ok, code? } }` | 503 when unhealthy |
| (not yet called by `lib/`) | GET `/api/me` | – | `MeResponse` (7.4) | 401 in google mode without session |
| `lib/approval-mode.ts` `loadApprovalModes()` | GET `/api/features` | – | `{ approvalModes: ApprovalModesConfig }` | any failure is treated as feature off |
| (sidebar/composer) | GET `/api/assistant-capabilities` | – | `AssistantCapability[]` (7.3.12) | static list |
| `app/page.tsx` | GET `/api/agents` | – | `AgentSummary[]` | |
| `lib/agents.ts` `createAgent()` | POST `/api/agents` | `AgentFields` | 201 `AgentSummary` | 409 `AGENT_HANDLE_TAKEN`, 422 `MODEL_UNAVAILABLE`; unknown fields rejected |
| `lib/agents.ts` `fetchModels()` | GET `/api/models` | – | `ModelOption[]` | filtered by tenant `allowedModelIds` and usable credentials |
| `components/connected-tools.tsx`, `mcp-settings.tsx` | GET `/api/agents/:agentId/mcp` | – | agent's MCP profile list | |
| `components/mcp-settings.tsx` | POST `/api/agents/:agentId/mcp` | `{ profileIds: string[] }` | updated list | |
| `components/mcp-settings.tsx` | POST `/api/mcp` | MCP create body | 201 MCP profile | user-scoped MCP |
| (not via `api()`) | GET/POST `/api/mcp`, PATCH/DELETE `/api/mcp/:id`, `/api/tenant/mcp[/:id]`, `/api/agents/:id/tenant-mcp` | | | tenant routes are admin-only (403) |
| `components/capabilities.tsx` | GET `/api/capabilities`, GET `/api/schemas/:name` | – | – | always 403 `CAPABILITY_DENIED` (blocked by middleware) |

#### Sessions (conversations)

| Frontend caller | Method + path | Request | Response | Notes / errors |
|---|---|---|---|---|
| `app/page.tsx` | GET `/api/sessions` | query `projectId?` | `PublicSession[]` | newest 100, not archived, owner-filtered; untitled ones get first user message (80 chars) as title |
| `lib/projects.ts` `listProjectSessions()` | GET `/api/sessions?projectId=` | – | `PublicSession[]` | |
| `app/page.tsx` | POST `/api/sessions` | `{ agentId: string; subAgents?: { mode?: "explicitRequestOnly" \| "proactive"; maxConcurrent?: 1..5 }; projectId?: string }` (built by `createSessionBody`) | 201 `PublicSession` | 400 `INVALID_INPUT`; project must be writable |
| `app/page.tsx` | GET `/api/sessions/:id` | – | `SessionHistory` (7.3.5) | never fails on runtime outage: returns `snapshot: null` + `recoveryError` |
| `lib/projects.ts` `setSessionProject()` | POST `/api/sessions/:id/project` | `{ projectId: string \| null }` | `PublicSession` | null removes from folder |
| `lib/approval-mode.ts` `setApprovalMode()` | POST `/api/sessions/:id/approval-mode` | `{ mode: ApprovalMode }` | `{ mode: ApprovalMode }` | 404 `FEATURE_DISABLED`, 422 `INVALID_APPROVAL_MODE` |
| `app/page.tsx` | GET `/api/sessions/:id/timings` | – | `{ runtimeStartup?: { spawnMs, initializeMs }, threadStartMs?: number, turns: TurnTiming[], averages: { totalMs: number, ttftMs: number } }` | |

#### Turn lifecycle (`lib/transport.ts`)

| Function | Method + path | Request | Response | Notes / errors |
|---|---|---|---|---|
| `transport.send(id, text, clientId)` | POST `/api/sessions/:id/messages` | `{ text: string (1–100000), clientId: string (/^[-\w]{1,100}$/) }` | 202 `{ turnId: string, steer: boolean, platformRoundTripMs: number }`, or replay `{ turnId, steer, duplicate: true }` | `steer: true` means the text was injected into the running turn. 409 `DUPLICATE_MESSAGE` if the same clientId was sent but not accepted. Server persists a `Message` with `delivery` pending → accepted / failed / unknown |
| `transport.interrupt(id)` | POST `/api/sessions/:id/interrupt` | `{}` | runtime ack (`{ ok: true }` in mock) | write access required |
| `transport.answer(id, requestId, result)` | POST `/api/sessions/:id/approvals/:requestId` | `{ result: unknown }` (for `item/tool/requestUserInput`: `{ answers: { [questionId]: { answers: string[] } } }`, free-text note as an extra `"user_note: ..."` entry) | runtime ack | invalid answers return 400 and leave the request pending |
| `transport.subscribe(...)` | GET `/api/sessions/:id/events?cursor=` | SSE (7.5) | | |

#### Commands and capabilities

| Caller | Method + path | Request | Response |
|---|---|---|---|
| `app/page.tsx`, `goal-bar.tsx`, `quick-tools.tsx` | POST `/api/sessions/:id/capabilities` | `{ method, params?, command?: { clientId, text } }` | with `command`: `{ commandMessage: Message }` (a transcript row with `command: CommandRecord`); without: the runtime result, e.g. `{ goal: Goal \| null }` |

Allowed `method` values (`shared/business-capabilities.ts`) and their allowed param keys:

| method | params |
|---|---|
| `help` (command only) | none |
| `thread/fork` | `lastTurnId`, `beforeTurnId` |
| `thread/compact/start` | – |
| `thread/archive`, `thread/unarchive` | – |
| `thread/goal/get` | – |
| `thread/goal/set` | `objective`, `status`, `tokenBudget` |
| `thread/goal/clear` | – |
| `thread/settings/update` | `model`, `effort`, `summary`, `serviceTier`, `personality` |

Anything else: "This operation is not available in Truex".

#### Goals

| Caller | Method + path | Request | Response | Errors |
|---|---|---|---|---|
| `goal-timeline.tsx` | GET `/api/sessions/:id/goal/history` | – | `{ entries: GoalHistoryEntry[] }` | |
| `goal-bar.tsx` | POST `/api/sessions/:id/goal/review` | `{ decision: "accepted" \| "reopened"; feedback?: string (≤4000) }` | `{ goal: Goal, review: GoalReview }` | 400 `INVALID_REVIEW`, 409 `GOAL_NOT_COMPLETE` |

#### Documents and visualizations

| Caller | Method + path | Request | Response | Limits |
|---|---|---|---|---|
| `assistant-tools.tsx`, `page.tsx` | GET `/api/sessions/:id/documents` | – | `ConversationFile[]` (7.3.9) | |
| `assistant-tools.tsx` | POST `/api/sessions/:id/documents` | `{ name: string, base64: string }` | 201 `ConversationFile` | 1 byte–1 MB per file, max 50 files / 25 MB per conversation |
| download link | GET `/api/sessions/:id/documents/:fileId` | – | binary attachment (`Content-Disposition`) | 400 for visualizations |
| `components/visualization.tsx` | GET `/api/sessions/:id/visualizations/:fileId` | – | `Visualization` | |

Upload accept list (`lib/document-kind.ts`): `.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.abap,.cds,.json,.xml,.yaml,.sql,.js,.ts`. `documentKind(name)` maps extension to `DocumentKind = "code" | "text" | "sheet" | "slides" | "document"` plus a label (PDF, Word, Excel, ...).

#### Helper agents and observability (`lib/api.ts`)

| Function | Method + path | Response |
|---|---|---|
| `listAgents(sessionId)` | GET `/api/sessions/:id/agents` | `SubAgent[]` |
| `getAgentTranscript(sessionId, agentId)` | GET `/api/sessions/:id/agents/:agentId` | `SubAgentTranscript` (404 if unknown) |
| `interruptAgent(sessionId, agentId)` | POST `/api/sessions/:id/agents/:agentId/interrupt` | `{ ok: true }` |
| `getTraces(sessionId)` | GET `/api/sessions/:id/traces` | `SessionTraces` |
| `getTurnContext(sessionId, turnId)` | GET `/api/sessions/:id/turns/:turnId/context` | `TurnContext` (live only, `no-store`) |

#### Projects (`lib/projects.ts`)

| Function | Method + path | Request | Response |
|---|---|---|---|
| `listProjects()` | GET `/api/projects` | – | `Project[]` (sorted `updatedAt` desc; UI re-sorts with `sortProjects`) |
| `createProject(name)` | POST `/api/projects` | `{ name }` (trimmed, 1–80, `PROJECT_NAME_MAX`) | 201 `Project` |
| `renameProject(id, name)` | POST `/api/projects/:id` | `{ name }` | `Project` |
| `deleteProject(id)` | POST `/api/projects/:id/delete` | `{}` | `{ ok: true }` (its sessions stay, un-foldered) |

UI helpers: `checkProjectName`, `sessionProjectActions(session, projects) → { mode: "add" | "move", targets, canRemove, current }`, `draftProject(draftProjectId, projects)`.

#### Auth routes (Google mode)

| Method + path | Request | Response |
|---|---|---|
| GET `/auth/google/start`, `/auth/google/callback` | redirects | sets session cookie |
| POST `/auth/logout` | – | 204 |
| GET `/auth/tenants` | – | `{ tenants: { id, name, role: UserRole }[] }` |
| POST `/auth/switch-tenant` | `{ tenantId }` | `{ tenant: { id }, role }`; 403 `NOT_A_MEMBER`; rotates cookie |
| `/auth/invites/*`, `/auth/admin/*`, `/api/admin/*` | | invite lookup and admin dashboard (separate admin session) |

---

### 7.3 Entity types (verbatim from source)

#### 7.3.1 Agent

Full stored type (server side; the UI gets `AgentSummary`):

```ts
interface Agent {
  _id: string;
  name: string;
  description: string;
  modelProfileId: string;
  systemPrompt: string;
  persona?: string;            // replaces default Truex identity line
  scope?: "business" | "general"; // default "business"
  sandbox: SandboxMode;        // Codex type
  approvalPolicy: AskForApproval; // Codex type
  mcpProfileIds: string[];
  skillIds?: string[];         // catalog skill ids
  handle?: string;             // mention handle without "@", unique per tenant
  look?: number;               // robot look index 0..AGENT_LOOK_COUNT-1
  tint?: AgentTint;
  builtin?: boolean;           // seeded by Truex; never set via API
}
const AGENT_TINTS = ["ice", "mint", "butter", "peach", "lilac"] as const;
type AgentTint = (typeof AGENT_TINTS)[number];
AGENT_LOOK_COUNT = 12; DEFAULT_AGENT_LOOK = 2; DEFAULT_AGENT_TINT = "ice";
AGENT_NAME_MAX = 40; AGENT_PURPOSE_MAX = 80; AGENT_INSTRUCTIONS_MAX = 20000;
agentHandle(name) // "Research Scout" → "researchscout", max 20 chars

interface AgentSummary {       // GET /api/agents
  id: string;
  name: string;
  description: string;
  provider: string;            // from model profile, "unknown" if missing
  model: string;               // model name, "unknown" if missing
  sandbox: string;             // default "read-only"
  handle?: string;
  look: number;
  tint: AgentTint;
  builtin: boolean;
}

interface AgentFields {        // POST /api/agents body (frontend/lib/agents.ts)
  name: string; description: string; systemPrompt: string;
  look: number; tint: AgentTint; modelProfileId: string;
}
```

UI helpers: `modelShort("Claude Opus 5.5") → "opus 5.5"`, `handleTaken(handle, agents)`.

#### 7.3.2 Model

```ts
interface ModelOption { id: string; name: string; provider: string } // GET /api/models; never has credentials
// Server-only, not exposed:
interface ModelProfile { _id; provider; baseUrl; modelName; reasoningEffort; apikey;
  wireApi: "responses" | "chat" | "anthropic" | "gemini"; route?: "direct" | "gateway";
  contextWindow?: number; autoCompactTokenLimit?: number }
```

#### 7.3.3 Session (conversation / chat)

Stored `Session` (server) and what the UI gets, `PublicSession`:

```ts
interface Session {
  runtimePolicyVersion?: number;
  approvalMode?: ApprovalMode;     // absent = configured default
  settings?: { model?: string; effort?: string; summary?: string;
               serviceTier?: string | null; personality?: string };
  _id: string;                     // "sess_" + uuid
  userId?: string;                 // owner, set once on create
  agentId: string;
  title?: string;
  threadId: string;                // internal
  agentCoreHost: string;           // internal
  status: "active" | "orphaned" | "dead";
  cwd: string;
  createdAt: string;               // ISO
  cursor?: string;
  approvals?: Record<string, unknown>[];
  timings?: TurnTiming[];
  goal?: SessionGoal;
  goalReview?: GoalReview;
  goalCleared?: { createdAt: number | null; eventAt?: string };
  goalHistory?: GoalHistoryEntry[];
  archived?: boolean;
  projectId?: string;
  threadStartMs?: number;
  runtimeStartup?: { spawnMs: number; initializeMs: number };
  mcpFingerprint?: string;
}

type PublicSession = Pick<Session,
  "_id" | "userId" | "agentId" | "title" | "status" | "createdAt"
  | "goal" | "projectId" | "approvalMode">;
```

Actual projection (`publicSession`): `userId`/`projectId` only when set; `approvalMode` only when the approval-modes flag is on (resolved via `effectiveMode`); `goal` is trimmed to `{ objective, status }`.

Status meaning: `active` normal; `orphaned` runtime host unreachable, resumes on next message; `dead` thread lost, every runtime call returns 410 `THREAD_LOST` (read-only history).

#### 7.3.4 Message

```ts
interface Message {
  command?: CommandRecord;      // set when the row is a slash command
  _id: string;                  // user: "<sessionId>:user:<clientId>"; assistant: "<sessionId>:assistant:<turnId>:<messageIndex>"
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  at: string;                   // ISO
  turnId?: string;
  itemId?: string;
  clientId?: string;            // idempotency key from the browser
  delivery?: "pending" | "accepted" | "failed" | "unknown";
  steer?: boolean;              // sent while a turn was running
  order?: number;
  messageIndex?: number;        // nth assistant message within a turn
  runtimeItemId?: string;
}
interface CommandRecord {
  method: string;
  params: Record<string, unknown>;
  state: "running" | "succeeded" | "failed" | "unknown";
  afterMessageId?: string;
  result?: { help?: string; goal?: Goal | null; sessionId?: string };
  error?: string;
}
```

Client-side transcript model (`frontend/lib/chat.ts`), what the chat actually renders:

```ts
type Entry =
  | { kind: "message"; command?: Message["command"]; id: string; role: string; text: string;
      turnId?: string; itemId?: string; aliases?: string[]; messageIndex?: number;
      final?: boolean; done?: boolean; delivery?: string; steer?: boolean }
  | { kind: "thinking"; id: string; turnId?: string; itemId?: string; text: string;
      summary?: string; raw?: string; done?: boolean }
  | { kind: "item"; id: string; turnId?: string; item: any }
  | { kind: "agents"; id: string; turnId?: string; threadIds: string[] } // helper agents a turn started
  | { kind: "approval"; id: string; turnId?: string; record: ApprovalRecord };
```

Assistant text can embed visuals as a standalone line `[truex-visualization:<uuid>]`; `splitVisualizations(text)` yields `VisualPart = { type: "markdown"; text } | { type: "visualization"; id }`.

#### 7.3.5 Session history (GET `/api/sessions/:id`)

```ts
{
  session: PublicSession;
  messages: Message[];                 // ordered transcript
  snapshot: PublicSnapshot | null;     // null when runtime unreachable
  plan: { steps: PlanStep[]; explanation?: string; turnId?: string; updatedAt?: string } | null; // saved plan
  approvals: ApprovalRecord[];         // resolved-request audit trail
  goalReview: GoalReview | null;
  goalHistory: GoalHistoryEntry[];
  recoveryError: string | null;        // "Conversation recovery: ..."
  recoveryErrorRef: { code: string; requestId?: string } | null;
}
```

#### 7.3.6 Turn

There is no single "Turn" entity. A turn is identified by `turnId` and appears as:

```ts
type TurnState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" | "interrupting"; turnId: string };

interface TurnTiming {            // per-turn latency (status projected to completed|failed|interrupted)
  turnId: string; acceptMs: number | null; ttftMs: number | null;
  streamMs: number; adapterStreamMs: number; idleStreamMs: number; maxGapMs: number;
  deltaRate: number; finalizeMs: number; totalMs: number; deltaCount: number;
  nonStreaming: boolean; status: string;
}

interface TurnTrace {             // observability
  turnId: string;
  threadId?: string;              // stripped from public responses
  startedAt: string;
  totalMs: number | null;
  status: string;                 // "completed" | "failed" | "interrupted"
  model?: string;
  steps: StepSpan[];              // max 300
  usage: TurnUsage | null;
  helperUsage: TokenCounts | null;
  rateLimits: RateLimitView | null;
  privacy: PrivacyReport;
}
type StepKind = "thinking" | "message" | "command" | "tool" | "fileChange" | "webSearch" | "agent" | "other";
interface StepSpan {
  id: string; kind: StepKind;
  label: string;                  // plain words, ≤120 chars, never raw args
  agent: string;                  // "main" or helper nickname/role
  agentThreadId: string;          // "main" for main agent
  startMs: number;                // offset from turn start
  durationMs: number | null;
  status: "running" | "completed" | "failed" | "declined";
}
interface TurnContext {           // live-only masked reconstruction
  turnId: string; reconstructed: true;
  sections: { kind: "user" | "toolOutput" | "command" | "fileContent" | "assistant";
              label: string; text: string; chars: number }[];
  truncated: boolean;
}
interface TraceSummary { turns; avgTotalMs: number | null; p95TotalMs: number | null;
  inputTokens; cachedInputTokens; outputTokens; reasoningOutputTokens; helperTokens; privacyFindings }
interface SessionTraces { traces: TurnTrace[]; summary: TraceSummary }
```

#### 7.3.7 Usage and limits

```ts
interface TokenCounts { inputTokens: number; cachedInputTokens: number; outputTokens: number;
                        reasoningOutputTokens: number; totalTokens: number }
interface TurnUsage extends TokenCounts {
  contextWindow: number | null;
  contextUsedTokens: number | null;   // input tokens of latest request = context fullness
}
interface RateLimitView {
  limitName: string | null;
  primaryUsedPercent: number | null; primaryWindowMins: number | null; primaryResetsAt: number | null; // epoch s
  secondaryUsedPercent: number | null; secondaryWindowMins: number | null; secondaryResetsAt: number | null;
  reached: string | null;
  at: string;
}
type PrivacyKind = "email" | "phone" | "card" | "iban" | "ssn" | "aadhaar" | "pan" | "ip" | "secret";
type PrivacySource = "userMessage" | "toolOutput" | "command" | "fileContent" | "assistant";
interface PrivacyFinding { kind: PrivacyKind; source: PrivacySource; count: number; sample: string } // masked, ≤24 chars
interface PrivacyReport { scannedChars: number; findings: PrivacyFinding[] }
```

#### 7.3.8 Approvals and input requests

Pending (live) request, as projected. Only `item/tool/requestUserInput` requests reach the browser; other methods are dropped.

```ts
interface PendingRequest {
  requestId: string;
  method: string;                  // always "item/tool/requestUserInput" publicly
  detail: Record<string, unknown>; // publicly: { questions: InputQuestion[] }
  expiresAt: string;               // ISO; unanswered requests auto-resolve
  responseSchema: string | null;   // always null publicly
}
interface InputOption { label: string; description?: string }
interface InputQuestion {
  id: string;
  kind?: "toolApproval";           // MCP tool permission prompt
  header?: string;                 // "Permission needed" for tool approvals
  question: string;
  action?: string;                 // humanised tool name, e.g. "Create sales order"
  isOther?: boolean;               // allows free text
  isSecret?: boolean;              // masked input; answer never echoed back
  options?: InputOption[] | null;
}
```

Tool approval option labels (values sent back) and UI copy: `Allow` → "Allow once", `Allow for this session` / `Allow for this chat` → "Allow for this chat", `Allow and don't ask me again` → "Always allow", `Cancel` → "Don't allow". Plan approval uses question id `plan_approval` with options `Approve` / `Revise`.

Resolved audit record:

```ts
interface ApprovalRecord {
  requestId: string;
  at?: string;
  turnId?: string;
  outcome: "answered" | "auto" | "expired" | "interrupted";
  autoMode?: "readOnly" | "auto" | "grant";   // which approval mode answered
  items: (
    | { kind: "toolApproval"; action?: string;
        decision: "allowedOnce" | "allowedSession" | "allowedChat" | "allowedAlways"
                | "declined" | "expired" | "interrupted" }
    | { kind: "question"; question: string; answer?: string; note?: string; secret?: true }
  )[];
}
```

UI labels (`lib/approval-mode.ts`): allowedOnce "Allowed once", allowedSession/allowedChat "Allowed for this chat", allowedAlways "Always allowed", declined "Not allowed", expired "No answer — timed out", interrupted "No answer — stopped". Auto labels: readOnly "Auto-allowed (read-only)", auto "Auto-accepted (Autopilot)", grant "Allowed for this chat". Footer: "You answered" / auto label or "Recommended option chosen" / "Closed".

#### 7.3.9 Attachment / document

```ts
interface ConversationFile {       // shared/assistant-capabilities.ts
  id: string;                      // uuid
  name: string;
  size: number;                    // bytes
  createdAt: string;
  mediaType: string;
  sourceId?: string;               // previous version this revises
  kind?: "visualization";
  title?: string;                  // visualizations only
  description?: string;
  mode?: "inline" | "wide";
}
interface Visualization { id: string; title: string; description: string; html: string; mode: "inline" | "wide" }
interface VisualizationState { modelContent: unknown; privateContent: unknown } // widget state, ≤16 KiB, per browser
```

Files are per conversation (not per message). Messages reference visuals by the `[truex-visualization:ID]` token only.

#### 7.3.10 Goal

```ts
type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
interface Goal {                   // live projection
  objective: string; status: GoalStatus;
  tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number;
  createdAt: number | null; updatedAt: number | null;   // runtime epoch values
  tokensObserved?: number;         // UI shows max(tokensUsed, tokensObserved)
}
interface SessionGoal {            // stored on session; PublicSession exposes only objective + status
  objective: string; status: GoalStatus; updatedAt?: string; createdAt?: number | null;
  tokensObserved?: number; tokenBudget?: number | null; goalUpdatedAt?: number | null; goalEventAt?: string;
}
interface GoalHistoryEntry {
  at: string;
  kind: "set" | "objective" | "budget" | "status" | "accepted" | "reopened" | "cleared";
  objective: string; status?: GoalStatus; tokens?: number; tokenBudget?: number | null;
  feedback?: string; turnId?: string; tokensUsed?: number;
}
interface GoalReview {             // agent marks complete, user accepts or reopens
  objective: string; goalCreatedAt: number | null;
  decision: "accepted" | "reopened"; feedback?: string; at: string;
}
```

#### 7.3.11 Plan and helper agents

```ts
type PlanStep = { step: string; status: "pending" | "inProgress" | "completed" }; // "in_progress" tolerated client-side

type SubAgentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound";
interface SubAgent {
  threadId: string;                // public helper id /^[A-Za-z0-9_-]{1,128}$/
  path: string | null; nickname: string | null; role: string | null;
  depth: number;                   // 0..8
  status: SubAgentStatus;
  task?: string; lastMessage?: string;   // ≤2000 chars
  startedAt: string; endedAt?: string;
}
interface SubAgentTranscript { agent: SubAgent; messages: { id: string; text: string; final: boolean }[] }
type CollabTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
```

Display name: `nickname || role`, capitalised, else "Helper agent".

#### 7.3.12 Project, assistant capabilities

```ts
interface Project {
  _id: string;        // "proj_" + uuid
  ownerId?: string;   // creator
  name: string;       // 1–80 chars
  createdAt: string;
  updatedAt: string;  // bumped when a session is added/created in it
}
// GET /api/assistant-capabilities: static cards
{ id: "explain" | "questions" | "web" | "documents" | "visualize" | "goals" | "collaboration";
  name: string; description: string; prompt: string /* composer prefill */ }[]
```

#### 7.3.13 User and tenant (no shared TS type; server shapes)

```ts
type UserRole = "user" | "admin";          // per tenant membership
interface UserRef { id: string; email: string; role: UserRole }
type ChatVisibility = "own" | "all";       // tenant setting, missing = "all"
interface TenantRef { id: string; dbName: string; allowedModelIds?: string[];
                      allowedSkillIds?: string[]; chatVisibility?: ChatVisibility }
// Stored (google mode): UserDocument { _id, googleSub, email, emailKey, name?, picture?,
//   status: "active" | "disabled", createdAt, lastLoginAt? }
// MembershipDocument { userId, tenantId, role, status: "active" | "removed", inviteId?, createdAt }
// InviteDocument status: "pending" | "accepted" | "revoked"
```

---

### 7.4 Auth, session and permissions exposed to the UI

`GET /api/me` response:

```ts
type MeResponse = {
  user: { id: string; email: string; name?: string; picture?: string }; // name/picture only in google mode
  tenant: { id: string; name: string };
  role: UserRole;                                    // role in the current tenant
  tenants: { id: string; name: string; role: UserRole }[]; // workspace switcher; dev mode = current only
};
```

- Auth modes (`AUTH_MODE`): `dev` (fixed user `dev-user`, role default `admin`; optional `x-truex-user` / `x-truex-role` headers when `DEV_USER_HEADER=on`) or `google` (HTTP-only session cookie, idle + absolute expiry; tenant switch rotates the cookie).
- CSRF: state-changing `/api` and `/auth` requests need an allowed `Origin` and JSON (403 `CSRF_ORIGIN`).
- Access matrix (`platform/src/access.ts`), applies to sessions and projects:

| Caller | visibility "all" | visibility "own" |
|---|---|---|
| Owner | read + write | read + write |
| Admin (not owner) | read only | read only |
| Other user | read only | hidden (404) |

  Writing someone else's chat returns 403 `NOT_SESSION_OWNER` ("Only the person who started this conversation can change it"). The UI must therefore support a read-only chat view (composer, approvals, goal review, project move, interrupt disabled) when `session.userId !== me.user.id`. Hidden records are 404, never 403.
- Any user may create agents (no role check, alpha). Tenant MCP management is admin-only.

### 7.5 Streaming protocol

- Transport: Server-Sent Events via browser `EventSource` at `GET /api/sessions/:id/events[?cursor=<cursor>]`. The platform proxies agent-core's thread SSE, passing `Last-Event-ID` (or `cursor`) upstream, and filters every frame through `publicEvent()`.
- Frames: `id: <cursor>\ndata: <JSON DomainEvent>\n\n`. Heartbeats are SSE comments (`: heartbeat`). Unknown or malformed frames are dropped server-side. Frames over 4 MB kill the stream.
- Fatal end: a named `event: stream.error` frame with `{ code: "STREAM_FAILED" | "STREAM_ENDED", error: string, requestId?: string }`, then close. Messages: STREAM_FAILED "Live updates stopped unexpectedly. Reopen the conversation to reconnect."; STREAM_ENDED "The assistant service stopped live updates, usually for a restart. Reconnect in a moment."
- Client status (`StreamStatus`): `"Connected"` (onopen), `"Reconnecting"` (onerror while EventSource retries), `"Disconnected"` (CLOSED or after `stream.error`). The mock transport reports `"Mock"`.
- Reconnect and resume: the last `lastEventId` is saved in `sessionStorage` under `cursor:<sessionId>` and sent as `?cursor=` on the next subscribe; the browser's own `EventSource` retry sends `Last-Event-ID`. After `stream.error` only a new `subscribe()` reconnects. An unparseable frame calls `handlers.onResync()` (UI reloads the transcript via GET `/api/sessions/:id`) without advancing the cursor.
- Ordering: events carry monotonically increasing `seq` and opaque `cursor`. A fresh connection starts with a `snapshot` (full current state), then live deltas. `resync.required` means the cursor is too old; reload.

Envelope (`shared/contracts.ts`):

```ts
interface DomainEvent {
  type: DomainType;
  seq: number;
  cursor: string;
  at: string;          // ISO
  threadId: string;    // NOTE: publicEvent() does not copy threadId; absent in the browser
  turnId?: string;
  itemId?: string;
  data: Record<string, any>;
}
```

Public event types and their `data` payloads (exact projection in `publicEvent`):

| type | data | UI meaning |
|---|---|---|
| `snapshot` | `PublicSnapshot` (below) | initial / resumed full state |
| `resync.required` | `{ reason: "Reconnect to refresh this conversation." }` | reload history |
| `turn.started` | `{}` | turn begins (`turnId` on envelope) |
| `message.delta` | `{ delta: string; messageIndex?: number }` | append assistant text |
| `message.final` | `{ text: string; messageIndex?: number }` | replace with final text |
| `reasoning.delta` | `{ delta: string; method: "item/reasoning/textDelta" \| "item/reasoning/summaryTextDelta" }` | thinking stream (raw vs summary channel) |
| `item.started` / `item.completed` (reasoning only) | `{ item: { id: string; type: "reasoning"; summary: string[] } }` | thinking block open / done |
| `activity.updated` | `{ label: string }` | status line; synthesised from item events for webSearch, collabAgentToolCall, subAgentActivity, dynamicToolCall, mcpToolCall |
| `plan.updated` | `{ plan: PlanStep[]; explanation?: string }` | plan checklist |
| `goal.updated` | `{ goal: Goal }` | goal bar |
| `goal.cleared` | `{}` | remove goal |
| `approval.requested` | `PendingRequest` (questions projected) | show question / permission card |
| `approval.resolved` | `{ requestId: string; audit?: ApprovalRecord }` | close card, add audit entry |
| `subagent.spawned` / `subagent.status` / `subagent.completed` | `{ agent: SubAgent; label: string; tool?: CollabTool }` | helper agents panel; label e.g. "Spawned Researcher", "Researcher finished/failed/stopped", "Researcher is working" |
| `subagent.event` | `{ agentThreadId; agentPath: string\|null; nickname; role; depth; kind: "message.delta" \| "message.final" \| "reasoning.delta" \| "turn.started" \| "turn.completed"; delta?; text?; itemId? }` | helper transcript live |
| `usage.updated` | `{ usage: TurnUsage }` | context meter, token counts |
| `limits.updated` | `{ rateLimits: RateLimitView }` | rate-limit meter |
| `error` | `{ message: string; code: string; reason: ErrorReason; httpStatus?: number; willRetry?: boolean; turnId?: string }` | inline error; `willRetry` true = transient |
| `turn.completed` | `{ timing?: TurnTiming; trace?: TurnTrace; turn: { status: "completed" \| "failed" \| "interrupted"; error?: { message, code, reason, httpStatus? } } }` | turn ends |

`ErrorReason = "rateLimited" | "quota" | "credentials" | "providerDown" | "contextWindow" | "other"` (codes `PROVIDER_RATE_LIMITED`, `PROVIDER_QUOTA_EXCEEDED`, `PROVIDER_AUTH_FAILED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_CONNECTION_FAILED`, `CONTEXT_LIMIT`).

In `DomainType` but never emitted to the browser (dropped by the allowlist): `session.created`, `thread.started`, `mcp.status`, `diff.updated`, `runtime.event`, and item events other than those listed.

Public snapshot (`publicSnapshot`, differs slightly from the `Snapshot` type):

```ts
{
  cursor: string;
  state: { kind: "idle" | "starting" | "running" | "interrupting"; turnId?: string };
  messages: { id: string; turnId?: string; text: string; final: boolean; messageIndex?: number }[];
  pending: PendingRequest[];          // open questions/approvals
  plan: PlanStep[];                   // falls back to the saved plan if runtime lost it
  goal: Goal | null;
  diff: "";                           // always empty publicly
  timings: TurnTiming[];
  traces: TurnTrace[];                // recent completed turns, oldest first
  rateLimits: RateLimitView | null;
  subAgents: SubAgent[];
  thinking: { id: string; turnId?: string; summary: string; raw: string; done: boolean }[];
}
```

Typical turn order: `turn.started` → (`reasoning.delta`* / `item.started|completed` reasoning / `activity.updated`* / `plan.updated` / `approval.requested` → `approval.resolved` / `subagent.*`)* → `message.delta`* → `message.final` → `usage.updated` / `limits.updated` → `turn.completed`. A message sent during a running turn returns `steer: true` and joins the same turn. The mock transport (`lib/mock.ts`) plays exactly: turn.started, reasoning.delta, approval.requested (15 s expiry), approval.resolved (`reason: "user" | "expired"`), word-by-word message.delta (100 ms), message.final, usage.updated, turn.completed with a sample trace.

`docs/protocol.md` is the Codex app-server JSON-RPC inventory (agent-core ↔ runtime). The browser never speaks it directly; only the methods in 7.2 "Commands and capabilities" are reachable, via the platform.

### 7.6 Feature flags that change UI behaviour

| Flag | Source | UI effect |
|---|---|---|
| `APPROVAL_MODES=on` | GET `/api/features` → `approvalModes.enabled` | shows the approval-mode picker; `PublicSession.approvalMode` present; `/approval-mode` route works (else 404 `FEATURE_DISABLED`) |
| `APPROVAL_MODES_DEFAULT` | `approvalModes.defaultMode` | preselected mode (`"ask"` unless valid; `"auto"` needs autopilot) |
| `APPROVAL_MODES_AUTOPILOT=on` | `approvalModes.autopilot` | adds "Autopilot" (`auto`) option |
| `APPROVAL_NAME_HEURISTIC=on` | `approvalModes.nameHeuristic` | server-side read-only detection by tool name; no direct UI |
| `AUTH_MODE=dev \| google` | server | sign-in flow, profile name/picture, tenant switcher |
| Tenant `chatVisibility` "own" / "all" | tenant registry | who sees which chats/projects; read-only chat views |
| Tenant `allowedModelIds` | tenant registry | which models the new-agent dialog lists |

```ts
type ApprovalMode = "ask" | "readOnly" | "auto";
interface ApprovalModesConfig { enabled: boolean; defaultMode: ApprovalMode; autopilot: boolean; nameHeuristic: boolean }
```

Picker copy: ask "Ask me every time", readOnly "Auto-allow read-only tools", auto "Autopilot". Selection priority: session mode, then pre-chat draft choice, then default. Plan approval and secret questions always ask.

### 7.7 Enum quick reference

| Enum | Values |
|---|---|
| Session.status | active, orphaned, dead |
| Message.role | user, assistant |
| Message.delivery | pending, accepted, failed, unknown |
| CommandRecord.state | running, succeeded, failed, unknown |
| TurnState.kind | idle, starting, running, interrupting |
| Turn/Trace/Timing status | completed, failed, interrupted |
| GoalStatus | active, paused, blocked, usageLimited, budgetLimited, complete |
| GoalHistoryEntry.kind | set, objective, budget, status, accepted, reopened, cleared |
| GoalReview.decision | accepted, reopened |
| PlanStep.status | pending, inProgress, completed |
| SubAgentStatus | pendingInit, running, interrupted, completed, errored, shutdown, notFound |
| Delegation mode | explicitRequestOnly, proactive (maxConcurrent 1–5) |
| StepKind | thinking, message, command, tool, fileChange, webSearch, agent, other |
| StepSpan.status | running, completed, failed, declined |
| ApprovalRecord.outcome | answered, auto, expired, interrupted |
| ApprovalRecord.autoMode | readOnly, auto, grant |
| Tool decision | allowedOnce, allowedSession, allowedChat, allowedAlways, declined, expired, interrupted |
| ApprovalMode | ask, readOnly, auto |
| UserRole | user, admin |
| ChatVisibility | own, all |
| AgentTint | ice, mint, butter, peach, lilac |
| Agent.scope | business, general |
| Visualization.mode | inline, wide |
| DocumentKind (UI) | code, text, sheet, slides, document |
| StreamStatus | Connected, Reconnecting, Disconnected |
| ErrorReason | rateLimited, quota, credentials, providerDown, contextWindow, other |
| PrivacyKind | email, phone, card, iban, ssn, aadhaar, pan, ip, secret |

### 7.8 Entity relationships

- A User has many Memberships; each Membership links one User to one Tenant with a role (user/admin). A Tenant has many Users through Memberships.
- A Tenant has many Agents, MCP profiles, Projects and Sessions (one database per tenant). Models and skills live in a shared catalog; a Tenant may restrict them (`allowedModelIds`, `allowedSkillIds`).
- An Agent uses one Model profile, many MCP profiles and many skills.
- A User owns many Sessions (`Session.userId`) and many Projects (`Project.ownerId`).
- A Project has many Sessions; a Session belongs to zero or one Project. Deleting a Project keeps its Sessions.
- A Session belongs to one Agent and has: many Messages, many Turns (by `turnId`, with TurnTiming and TurnTrace each), many ApprovalRecords, many ConversationFiles (documents and visualizations; a file may revise another via `sourceId`), zero or one live Goal with many GoalHistoryEntries and zero or one GoalReview, one current Plan, many SubAgents (each with one SubAgentTranscript), and at most one PendingRequest set at a time.
- A Turn has many Messages (by `messageIndex`), many StepSpans, one TurnUsage, optional RateLimitView and a PrivacyReport; it may raise many PendingRequests, each resolved into one ApprovalRecord with many items.


## 8. Design Tokens, Styles & Responsive

Scope: `frontend/styles/v2/*.css`, `frontend/app/*.css`, `frontend/app/layout.tsx`, `frontend/lib/use-theme.ts`, `frontend/components/v2/icon.tsx`, `components.json`, `postcss.config.mjs`, compared against `docs/truex-design-spec.html` (spec v2, "locked for build").

### 8.1 Stylesheet pipeline

`app/layout.tsx` imports only `app/globals.css`, which imports in this order:

1. `@import "tailwindcss"` (Tailwind v4 via `@tailwindcss/postcss`; `postcss.config.mjs` = `{plugins:{'@tailwindcss/postcss':{}}}`; no `tailwind.config.*`)
2. Legacy: `app/shell.css`, `app/chat.css`, `app/panels.css`, `app/observability.css`, `app/responsive.css`
3. v2 (imported last so they win on shared class names): `styles/v2/tokens.css`, `base.css`, `shell.css`, `dock.css`, `chat.css`, `session.css`, `agent-dialog.css`
4. Inline in globals: `button { cursor: pointer }`, `::selection { background: var(--accent-soft-2) }`

Notes:
- Tailwind is loaded but no component uses Tailwind utility classes (a grep for `flex|px-N|text-sm|bg-|rounded-` in `className` strings returned 0). It effectively only contributes Preflight/reset.
- `components.json` is a shadcn config (`style: "new-york"`, `baseColor: "neutral"`, `cssVariables: true`, `rsc: true`). Only two `components/ui` files exist (`button.tsx`, `select.tsx`). `Button` maps variants to legacy classes (`button-primary`, `button-outline`, `button-ghost`) via `cva`, not Tailwind.
- `tokens.css` header: "Copied unedited from docs/truex-design-spec.html → Appendix... Single source of truth for color, type, radius, shadow. Do not add literal hex in components."

### 8.2 Theming mechanism

- Light is the `:root` default (`color-scheme: light`).
- Dark applies in two ways, with identical values duplicated:
  - `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...} }` (system dark unless the user forced light)
  - `:root[data-theme="dark"] {...}` (user-forced dark)
- `lib/use-theme.ts`: `localStorage["truex-theme"]` stores `"" | "light" | "dark"`. Empty means follow system. `write()` sets or removes `document.documentElement.dataset.theme`. It subscribes to `matchMedia("(prefers-color-scheme: dark)")` changes.
- `THEME_BOOT_SCRIPT` is inlined in `<head>` (layout.tsx) before paint to avoid a theme flash: `try{var t=localStorage.getItem("truex-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`. `<html suppressHydrationWarning>`.
- Toggle surfaces (per comment in use-theme.ts): topbar toggle and account menu.
- Dark theme is not part of the brand system. tokens.css says it is "derived from graphite with #3691CD / #BCDEE8 accents."
- Some colors stay fixed across themes by design: the agent badge (`.badge` `#FFFFFF` bg, `#1F2A30` text, "Badge colours are fixed in both themes"), `.strap` gradient mixes with `#1F2A30`/`#fff`, and the celebrate scrim (`rgb(12 15 17 / 78%)`, text `#F4F7F8`).

### 8.3 Color tokens (`styles/v2/tokens.css`)

Brand ramp (light only, not redefined in dark):

| Token | Value |
|---|---|
| `--brand-50` | `#F8FCFD` |
| `--brand-100` | `#F4FAFC` |
| `--brand-200` | `#EAF5F8` |
| `--brand-300` | `#D8EBF0` |
| `--brand-400` | `#BCDEE8` (pastel) |
| `--brand-500` | `#3691CD` (primary blue) |
| `--brand-600` | `#2A7DB4` |
| `--brand-700` | `#226A9B` |

Semantic tokens:

| Token | Light | Dark | Role (from comments) |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#171717` | page background |
| `--surface` | `#FFFFFF` | `#171717` | panels, cards |
| `--surface-2` | `#FFFFFF` | `#171717` | stage, hover |
| `--surface-3` | `#F6F9FA` | `#242424` | soft surface, active row |
| `--line` | `#E3ECEF` | `#2A2A2A` | borders |
| `--line-strong` | `#D8E0E4` | `#363636` | hover borders, separators |
| `--border-control` | `#D8E0E4` | `#404040` | inputs/selects |
| `--ink` | `#1F2A30` | `#EEF4F6` | graphite text |
| `--ink-2` | `#5F6D73` | `#B7C3C8` | secondary text |
| `--ink-3` | `#849198` | `#8B999F` | muted text |
| `--ink-disabled` | `#B4BEC3` | `#4E5C62` | disabled |
| `--accent` | `#3691CD` | `#3691CD` | primary action fill |
| `--accent-2` | `#2A7DB4` | `#5AA8DC` | strong: dots, progress, focus border |
| `--accent-hover` | `#2A7DB4` | `#2A7DB4` | solid button hover |
| `--accent-pressed` | `#226A9B` | `#226A9B` | pressed |
| `--accent-soft` | `#EAF5F8` | `#14283A` | "ice": selected, secondary, focus halo |
| `--accent-soft-2` | `#BCDEE8` | `#1F4461` | pastel border, selection bg |
| `--signature` | `#BCDEE8` | (not redefined) | signature pastel |
| `--accent-fg` | `#2A72A3` | `#BCDEE8` | blue text/icons, focus ring ("AA on white and ice") |
| `--accent-text` | `#2A72A3` | `#BCDEE8` | same as accent-fg |
| `--accent-ink` | `#1F2A30` | `#1F2A30` | content on pastel fills |
| `--on-accent` | `#FFFFFF` | `#FFFFFF` | content on `#3691CD` |
| `--warn` | `#7D5D1D` | `#E6C27A` | paused dot |
| `--success-bg` / `--success-text` | `#E7F4ED` / `#35624E` | `#16291F` / `#A8D8BE` | |
| `--warning-bg` / `--warning-text` | `#FFF3D9` / `#7D5D1D` | `#2E2512` / `#E6C27A` | |
| `--error-bg` / `--error-text` | `#FBE7E7` / `#8D4545` | `#2F1A1A` / `#EDB0B0` | |
| `--info-bg` / `--info-text` | `#EAF5F8` / `#2A72A3` | `#14283A` / `#BCDEE8` | |
| `--neutral-bg` / `--neutral-text` | `#F6F9FA` / `#5F6D73` | `#242424` / `#8B999F` | |
| `--glow-1` | `rgb(188 222 232 / 60%)` | `rgb(54 145 205 / 16%)` | |
| `--glow-2` | `rgb(234 245 248 / 90%)` | `rgb(188 222 232 / 6%)` | |

Helper tone tokens (for multi-agent lanes, charts; comment: "validated: dataviz validate_palette.js, --pairs all, both modes"):

| Token | Light | Dark |
|---|---|---|
| `--tone-0` / `--tone-0-soft` | `#2872b8` / `#eef5fc` | `#3691cd` / `#0f1f2c` |
| `--tone-1` / `--tone-1-soft` | `#0f7a55` / `#e6f5ee` | `#199e70` / `#0e211a` |
| `--tone-2` / `--tone-2-soft` | `#b84a1b` / `#fcece4` | `#d95926` / `#24120a` |
| `--tone-main` / `--tone-main-soft` | `#6b6b6b` / `#f0f0f0` | `#8f8f8f` / `#262626` |

Classes `.tone-0 | .tone-1 | .tone-2 | .tone-main` set local `--t` (strong) and `--ts` (soft). Consumers: `.hcard-mark`, `.h-av`, `.ag-row`, `.ag-span`, `.ag-lane.is-lit`, `.in-seg`, `.in-swatch`, `.in-row-bar`, `.tc-step`.

Legacy alias tokens (`base.css`, "Delete each once its area is rebuilt"):

| Alias | Maps to |
|---|---|
| `--background` | `var(--bg)` |
| `--foreground` | `var(--ink)` |
| `--fg-2` | `var(--ink-2)` |
| `--muted`, `--subtle` | `var(--ink-3)` |
| `--border` | `var(--line)` |
| `--border-strong` | `var(--line-strong)` |
| `--surface-hover` | `var(--surface-3)` |
| `--ring` | `var(--accent-fg)` |
| `--good` | `var(--success-text)` |
| `--warn-bg` / `--warn-fg` | `var(--warning-bg)` / `var(--warning-text)` |
| `--warn-border` | `color-mix(in srgb, var(--warning-text) 25%, var(--line))` |
| `--danger` | `var(--error-text)` |

Common derived colors (via `color-mix`, not tokens): scrim `color-mix(in srgb, var(--ink) 18%, transparent)`; composer focus border `accent 45% / line`, halo `0 0 0 4px accent 10%`; goal strip border `accent 25% / line`, bg `accent-soft 70% / surface`; dock bg `surface 78% / transparent`; `.pulse` ring `accent-2 60%`.

Hard-coded non-token colors that remain: legacy `.sheet::backdrop` `rgb(24 26 20 / 0.18)`; badge/celebrate literals listed in 8.2; `.badge-name.is-empty` `#A3AFB5`; `.badge-foot` `#E3ECEF` / `#5F6D73`.

### 8.4 Typography

Fonts load through a Google Fonts `<link>` in `layout.tsx` (explicitly not `next/font`, "which renames families and would break the spec's --font-* tokens"), with preconnect to `fonts.googleapis.com` and `fonts.gstatic.com`:

`Figtree:wght@400;500;600;700;800`, `Newsreader:ital,opsz,wght@1,6..72,400..500` (italic only), `JetBrains+Mono:wght@400;500`, `Caveat:wght@600;700`, `display=swap`.

| Token | Value |
|---|---|
| `--font-sans` | `"Figtree", ui-sans-serif, system-ui, sans-serif` |
| `--font-display` | `"Figtree", ui-sans-serif, system-ui, sans-serif` |
| `--font-accent` | `"Newsreader", ui-serif, Georgia, serif` |
| `--font-mono` | `"JetBrains Mono", ui-monospace, monospace` |
| `--display-weight` | `600` |
| `--display-track` | `-.035em` |
| `--accent-style` / `--accent-weight` / `--accent-scale` | `italic` / `400` / `1.04` |

Base: `body { font: 14px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; overflow: hidden }`; `button { font: inherit; color: inherit }`.

Type scale in v2 CSS (px, all fixed, no fluid type except hero):

| Size | Weight | Line-height | Extras | Selectors |
|---|---|---|---|---|
| `clamp(28px, 4vw, 44px)` | `var(--display-weight)` | 1.08 | display, track `var(--display-track)`, `text-wrap: balance` | `.hero h1` |
| `calc(1.04 * 1em)` | 400 italic | — | Newsreader, `-.01em`, `--accent-fg` | `.hero h1 em` |
| 32px / 26px | display-weight | 1.2 | display | `.celebrate-copy h2`, `.nad-done-copy h2` |
| 24px | 700 | 1.15 | display, `-.03em` | `.badge-name` |
| 22px | 800 | 1 | `-.04em` | `.brand-word.sm` |
| 20px | display-weight | 1.2 | `-.02em` | `.nad-head h2` |
| 20px | 600 | 1.25 | tabular | `.in-kpi dd` |
| 17px | 700 | — | display, `-.03em` | `.brand-word` |
| 16px | 400 | — | — | `.brand-slash`, `.h-av.lg` (700) |
| 15px | 400 | 1.5 | — | `.composer textarea`, `.palette-input input` |
| 14px | 400 | 1.5 / 1.65 | — | body, `.bubble` (1.5), `.answer` (1.65), `.input`, `.btn-*.lg`, `.p-title` (600), `.brand-sub` (500) |
| 13.5px | — | 1.5 | — | `.nad-head p`, `.ag-panel` |
| 13px | 500 | — | — | `.btn-solid/.btn-soft/.btn-ghost`, `.chip`, `.status-pill`, `.tab`, `.goal-strip`, `.hcard-row` |
| 12.5px | 500 | 1.45 | — | `.field-label`, `.composer-note`, `.ag-preview` |
| 12px | 400–500 | — | — | `.sm`, `.msg-foot`, `.goal-tag`, `.goal-status`, `.dock-tip`, `.field-hint` (mono), `.link` |
| 11.5px | 500 | — | — | `.ag-chip`, `.tc-json` (mono, 1.5) |
| 11px | 500 | normal | mono, `.06em`, uppercase | `.eyebrow`, `.badge-handle`, `.delegation legend`, `kbd` (no transform), `.convo-time` (400) |
| 10.5px | 600 | normal | mono | `.tab-count` |
| 10px | 700 | 1 | — | `.hcard-mark`, `.h-av.xs` |

Numeric readouts use `font-variant-numeric: tabular-nums` (`.msg-note`, `.msg-foot`, `.hcard-time`, `.goal-strip-meta`, `.in-kpi dd`, `.in-row-val`, `.helper-chip`).

Legacy files mostly use `var(--font-mono)`, except `app/shell.css:706` and `:786` which hard-code `ui-monospace, SFMono-Regular, Menlo, monospace`.

### 8.5 Spacing

There is no spacing scale token. Values are literal px, recurring set: 1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 40.

Key layout spacing:

| Area | Value |
|---|---|
| Shell outer padding + gap | `10px` / `10px` (0 at ≤720px) |
| Sidebar inner padding | `14px 12px`, gap `6px` |
| Topbar | height `56px`, padding `0 12px 0 18px` |
| Thread | `max-width: 740px`, padding `16px 20px 24px`, gap `22px` between messages |
| Bottom (composer area) | padding `0 20px 14px`, gap `12px` (`0 16px 12px` at ≤720px) |
| Composer | padding `12px 10px 8px 12px`, `max-width: 740px` |
| Hero | `max-width: 760px`, padding `24px 16px 40px`, composer `margin-top: 28px` |
| Session panel body | padding `16px`; section head margin `24px 0 8px` |
| Agent dialog form | padding `24px 24px 20px`, gap `16px` |

### 8.6 Radii

| Token / literal | Value | Used by |
|---|---|---|
| `--radius` | `16px` | `.panel-inner`, `.stage`, `.in-kpi`, `.in-card` |
| `--radius-sm` (alias) | `6px` | legacy |
| `--radius-md` (alias) | `10px` ("old --radius") | legacy |
| `--radius-lg` (alias) | `14px` | legacy |
| 20px | | `.dock`, `.agent-dialog` |
| 18px | | `.composer`, `.badge` |
| 16px | | `.palette`, bubble `16px 16px 4px 16px` (tail bottom-right) |
| 14px | | `.popover` |
| 12px | | `.goal-strip`, `.goal-menu`, `.hcard-output`, `.ag-row`, `.ag-stats`, `.look`, `.tile.lg`, images |
| 11px | | `.send`, `.h-av.lg` |
| 10px | | `.icon-btn`, `.input`, `.search-trigger`, `.btn-new`, `.goal-meta > div`, `.ag-warn` |
| 9px | | buttons (`.btn-*`), `.side-link`, `.convo`, `.menu-item`, `.tile`, `.select select` |
| 8px | | `.agent-avatar`, `.h-av`, `.dock-tip`, `.ag-seg-tab`, `:focus-visible` ring |
| 999px / 50% | | chips, pills, `.goal-tag`, `.goal-status`, `.ag-chip`, dots, `.dock-btn`, `.avatar` |

### 8.7 Shadows / elevation

| Token | Light | Dark |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgb(31 42 48 / 5%)` | not redefined (same) |
| `--shadow-md` | `0 1px 2px rgb(31 42 48 / 4%), 0 8px 24px -8px rgb(31 42 48 / 10%)` | `0 1px 2px rgb(0 0 0 / 30%), 0 8px 24px -8px rgb(0 0 0 / 50%)` |
| `--shadow-lg` | `0 2px 4px rgb(31 42 48 / 4%), 0 10px 35px rgb(31 42 48 / 8%)` | `0 2px 4px rgb(0 0 0 / 30%), 0 24px 48px -16px rgb(0 0 0 / 70%)` |

Usage: `sm` = panels, status pills, hero greet; `md` = composer, `.in-tip`; `lg` = dock, popovers, palette, dialogs, overlay panels, goal menu. Blur surfaces: dock `backdrop-filter: blur(14px) saturate(1.4)`; scrim `blur(2px)`; celebrate scrim `blur(6px)`.

### 8.8 Z-index layers

| z | Element | File |
|---|---|---|
| 1 | `.scroll`, `.tl-dot` | v2 shell / session |
| 2 | `.stage .topbar`, `.in-tip`, `.confetti`, `.badge-shine`, `.clip` | v2 |
| 3 | `.bottom` (composer area), `.dialog-x`, `.celebrate-copy` | v2 |
| 5 | `.slash-menu` | app/chat.css |
| 20 | `.popover`; legacy `.goal-menu` (fixed) | v2 dock / app/shell.css |
| 30 | `.activity.is-overlay.is-open`, `.activity.is-open` (≤900), `.panel.sidebar.is-open` (≤720) | v2 shell |
| 50 | `.scrim` (search palette, agent dialog, celebrate); legacy `.select-content` | v2 shell / app/shell.css |
| 60 | legacy `.menu` (`position: fixed`) | app/shell.css |
| top layer | `.sheet` (native `<dialog>` with `::backdrop`) | app/panels.css |

No z-index tokens exist.

### 8.9 Motion

Keyframes:

| Name | Definition | Used by | File |
|---|---|---|---|
| `pulse` | `70% { box-shadow: 0 0 0 7px transparent } 100% { box-shadow: 0 0 0 0 transparent }` | `.pulse` 1.6s infinite, `.dock-badge`, `.goal-status.s-running .pulse` | base.css |
| `spin` | `to { rotate(360deg) }` | `.spinner` .7s linear infinite | base.css |
| `rise` | `from { opacity: 0; translateY(6px) }` | `.hero` .35s, `.msg.agent` .3s, `.goal-strip` .2s, `.palette`/`.popover` .16s, `.agent-dialog` .18s, `.celebrate-copy` .4s .35s | base.css |
| `blink` | `50% { opacity: 0 }` | `.caret` 1s steps(2) infinite | base.css |
| `fade` | `from { opacity: 0 }` | `.scrim` .12s, `.scrim.celebrate` .25s | base.css |
| `sway` | `rotate(-1.4deg) ↔ rotate(1.4deg)` | `.lanyard-sway` 6s ease-in-out infinite | agent-dialog.css |
| `shine` | `to { translateX(120%) }` | `.badge-shine` .9s ease-out | agent-dialog.css |
| `drop` | `from { translateY(-110%) }` | `.celebrate-stage .lanyard-anchor` .9s `cubic-bezier(.34, 1.56, .64, 1)` | agent-dialog.css |
| `burst` | confetti translate/rotate/fade driven by `--x --y --r --t --d` | `.confetti i` `cubic-bezier(.2, .7, .35, 1)` | agent-dialog.css |
| `ag-pulse` | `50% { opacity: .55 }` | `.ag-span.is-running`, `.tc-step.is-running` 1.4s | session.css |
| `sheet-in` | `from { translateX(24px); opacity: 0 }` | `.sheet[open]` .22s `cubic-bezier(0.2, 0.8, 0.2, 1)` | app/panels.css |
| `obs-running` | `to { background-position: -200% 0 }` | (no rule in file uses it; observability.css is otherwise section comments only) | app/observability.css |

Easings: panel open/close `width .32s cubic-bezier(.2, .8, .2, 1), opacity .2s`; lanyard/strap spring `.7s cubic-bezier(.34, 1.56, .64, 1)`; dock hover `.14s ease-out`; progress `.bar span` `width .4s ease`; generic hover `.15s`; press `transform .12s` (`.btn-new:active scale(.98)`, `.send:active scale(.94)`); tooltip `.12s`.

No duration/easing tokens. Memory note "spec-only motion" applies: no animations beyond the spec.

### 8.10 Breakpoints

All are `max-width` (desktop-first); rules cascade, so at ≤720 the ≤900 rules also apply.

| Query | File | Changes |
|---|---|---|
| `≤900px` | v2/shell.css | Activity panel becomes a fixed overlay: `position: fixed; right/top/bottom: 10px; z-index: 30`, inner gets `--shadow-lg`. Before first fit (`.shell:not(.is-ready)`), panels forced to `width: 0; opacity: 0` to avoid an open→closed flash. |
| `≤760px` | v2/agent-dialog.css | Dialog collapses to one column, `overflow: auto`; form padding `20px 16px`; stage moves on top (`order: -1`), `min-height: 380px`, border-bottom instead of border-left; strap `56px`; look grid 6 → 4 columns. |
| `≤720px` | v2/shell.css | Shell padding/gap `0`; stage loses radius and border (full-bleed). Sidebar opens as a fixed left drawer (`z-index: 30`, inner radius `0 16px 16px 0`, `--shadow-lg`). Activity overlay goes edge-to-edge, width `min(var(--pw, 360px), 100vw)`. Bottom padding `0 16px 12px`. Topbar padding `0 8px 0 16px`, grid `auto 1fr auto`; `.crumb` hidden; status pill moves to column 1. |
| `≤720px` | v2/chat.css | Goal strip hides `.bar` and `.goal-strip-meta`. |
| `≤720px` | v2/session.css | `.p-head .p-size` (panel resize button) hidden. |
| `≤700px` | v2/chat.css | `.hcard-row .ag-chip` hidden; `.hcard-detail` padding-left `12px`. |
| `≤700px` | app/responsive.css | Legacy: `.select-trigger` `max-width: 150px`; `.transcript` padding `16px`; `.error-banner` margin `8px 16px`. |
| `≤640px` | v2/chat.css | Approval-mode `<select>` `max-width: 128px` (190px otherwise). |
| `≤520px` | app/panels.css | Request approval actions stack vertically; request card head wraps. |
| `max-height ≤720px` | v2/agent-dialog.css | Celebrate strap `20px`, heading `26px`. |
| `hover: none` | v2 shell, dock; app/chat.css, shell.css | Row menus (`.convo-menu`, `.menu-edit`) always visible; convo time hidden when a menu exists. |

Panel widths: sidebar `268px` open, `0` closed; activity `var(--pw, 360px)` (resizable via inline `--pw`). Dock and composer have no breakpoint of their own; the dock (`height: 56px`) stays centered in `.bottom` at all widths. Width fitting beyond CSS (spec "fitPanel") is done in JS, not CSS.

### 8.11 Class inventory by file

**styles/v2/tokens.css**: tokens only, global reduced-motion rule, `.tone-*`.

**styles/v2/base.css** (shared primitives, spec Core §1, 3, 5, 7, 8):
- Utilities: `.grow` (flex 1, min-width 0), `.strong`, `.block`, `.muted`, `.sm`, `.mono`, `.pad`, `.eyebrow(.pad)`, `.sr-only`, `kbd`
- Buttons: `.btn-solid`, `.btn-soft`, `.btn-ghost(.danger)`, `.btn-danger` (all `height: 32px; padding: 0 12px; radius 9px`; `.lg` = 38px), `.icon-btn` (34×34, `.ghost` 32×32), `.text-btn`, `.link`
- Chips/status: `.chip` (h30 pill), `.agent-dot` (8px), `.status-pill` (h30), `.pulse(.idle)`, `.spinner` (10px), `.step-mark` (16px), `.tile(.lg)` (32/44px), `.bar` (h4 progress), `.goal-tag`, `.goal-status` + `.s-running|.s-paused|.s-done|.s-ended`, `.ag-chip` + `.is-running|.is-done|.is-stopped|.is-warn` (h20)
- Menus: `.menu`, `.menu-item(.is-active)`, `.menu-sep`
- Forms: `.field`, `.field-label`, `.field-hint(.is-bad)`, `.input` (h40, `aria-invalid` red border), `textarea.input` (min 84px), `.select(.full)`

**styles/v2/shell.css** (spec Layout §1–4, 7; Core §6):
- Frame: `.shell` (flex, padding/gap 10), `.panel(.is-open)`, `.panel.sidebar`, `.panel.activity`, `.is-overlay`, `.panel-inner`, `.stage` (flex column, flex 1)
- Sidebar: `.brand`, `.brand-mark` (24px ink tile), `.brand-word(.sm)`, `.brand-slash`, `.brand-sub`, `.search-trigger` (h34), `.btn-new` (h36, ink fill, kbd hint), `.side-nav`, `.side-link(.is-active,.side-foot)` (h34), `.side-scroll`, `.side-group`, `.side-error`, `.side-retry`, `.convo-row(.has-menu)`, `.convo(.is-active)`, `.convo-title`, `.convo-time`, `.convo-menu`
- Stage: `.stage .topbar` (grid `1fr auto 1fr`, h56), `.crumb`, `.crumb-title`, `.top-actions`, `.scroll`, `.hero`, `.hero-greet`, `.hero h1/em`, `.hero-composer`, `.thread`, `.bottom`
- Search palette: `.scrim`, `.palette` (max 540px), `.palette-input` (h52), `.palette-list` (max-h 320)

**styles/v2/dock.css** (spec Layout §5, Core §5):
- `.dock-wrap`, `.dock` (flex, h56, radius 20, blurred glass), `.dock-sep`, `.dock-btn(.is-active)` (circular; size animated via inline width/height), `.dock-icon`, `.dock-pip`, `.dock-badge`, `.dock-tip` (tooltip above, shown on hover/focus-visible)
- `.popover` (absolute, `bottom: calc(100% + 12px)`, w280), `.pop-agent` (centered), `.pop-user` (right, w300), `.menu-row`, `.menu-edit`, `.menu-plus(.solid)`, `.user-card`, `.avatar` (34px)
- Explicit resets of legacy `.menu` / `.menu-item` inside `.popover`

**styles/v2/chat.css** (spec Core §2–4; non-spec areas reuse primitives):
- Messages: `.chat-messages` (gap 22), `.msg.user`, `.bubble-wrap` (max 80%), `.bubble` (ink fill), `.msg-note`, `.msg.agent` (flex gap 12), `.agent-avatar` (26px), `.msg-meta`, `.answer`, `.caret`, `.msg-foot`, `.msg-foot-btn(.warn)`, `.msg-foot-privacy`, `.msg-foot-chevron(.open)`
- Steps: `.steps`, `.step-caret`, step detail (max-h 280)
- Helper card: `.hcard`, `.hcard-row`, `.hcard-mark` (18px tone), `.hcard-name`, `.hcard-time`, `.hcard-output` (max-h 320), `.hcard-detail`, `.hcard-error`, `.hcard-actions`, `.helper-chip.status-pill`
- Markdown inside `.answer` (headings, lists, code, `table` scrollable, `img`)
- Suggested follow-ups
- Cards: `.command-result`, `.approval-record(-row,-dot,-body)`, `.request-card`, `.request-card-icon` (28px), `.request-option`, `.request-text`, visualizations, error reference
- Composer: `.composer(.goal-mode,.is-focus,.is-hero)`, `.composer textarea` (min 60 / max 240; hero min 76), `.composer-goal-head`, `.composer-bar`, `.chip.goal-chip[aria-pressed]`, `.send(.is-stop)` (34×34), `.composer-project`, `.composer-note`, slash menu, `.budget-field`, `.approval-mode`, `.composer-form` (max 740)
- Goal strip: `.goal-bar`, `.goal-strip` (h38), `.goal-strip-text`, `.goal-strip-meta`, `.goal-strip-actions`, `.goal-menu.menu`, `.goal-run`, `.goal-panel`, `.goal-review`, `.goal-completion(-toggle,-documents)`
- `.runtime-item`

**styles/v2/session.css** (spec Session panel §1–5b):
- Frame: `.session-panel`, `.p-head` (min-h 48), `.p-title`, `.p-size`, `.tabs` (horizontal scroll, hidden scrollbar), `.tab(.is-active)` (h38, 2px accent underline), `.tab-count`, `.tab-dot`, `.activity-body`, `.empty-tab`, `.section-head`
- Activity: live row (`.live-meta`, `.live-row`), `.timeline` (1px rail at left 13px), `.tl-dot` (27px), `.tl-body`
- Goal: `.goal-meta` (3-col grid), `.cp-dot`
- Agents: `.h-av(.xs,.lg)`, `.ag-lane` (grid `72px 1fr 40px`), `.ag-track`, `.ag-span`, `.ag-row(.is-lit)`, `.ag-row-body`, `.ag-preview` (2-line clamp), `.ag-chev`, `.ag-pager-label`, `.ag-ident`, `.ag-stats` (auto-fit minmax 110), `.ag-warn`, `.ag-seg-tab`, `.ag-panel`, `.ag-tab`, `.delegation`, `.delegation-max`
- Plan: `.pl-item` (grid `18px 1fr`), `.pl-status`
- Insights: `.in-kpis` (auto-fit minmax 130), `.in-kpi`, `.in-card`, `.in-stack`, `.in-seg`, `.in-tip`, `.in-legend`, `.in-swatch`, `.in-row` (grid `minmax(56px,32%) 1fr auto`), `.in-row-bar`, `.in-meter`, `.in-note`, `.in-cols` (SVG columns), `.in-key`, `.in-timing-bar`
- Trace card: `.tc-empty`, `.tc-note`, `.tc-tag`, `.tc-lane` (grid `72px 1fr`), `.tc-step`, `.tc-step-name`, `.tc-ids`, `.tc-context pre`, `.tc-json`

**styles/v2/agent-dialog.css** (spec Session §7):
- `.scrim.center`, `.agent-dialog` (grid `1.1fr .9fr`, max 920, `max-height: calc(100dvh - 32px)`), `.dialog-x`, `.nad-form`, `.nad-head`, `.look-grid` (6 cols), `.look(.is-active)`, `.tint-row`, `.tint(.is-active)` (26px), `.nad-actions`
- Preview: `.nad-stage` (min-h 540), `.nad-stage-note`, `.lanyard-anchor`, `.lanyard(.is-drag)`, `.lanyard-sway`, `.strap`, `.clip`, `.badge` (w256), `.badge-slot`, `.badge-brand`, `.badge-top` (h188), `.badge-body`, `.badge-name(.is-empty)`, `.badge-handle`, `.badge-foot`, `.badge-shine`
- Done/celebrate: `.nad-done-copy`, `.scrim.celebrate`, `.celebrate-stage`, `.celebrate-copy`, `.confetti i`

**app/shell.css** (legacy, 792 lines): `.app-error(-card)`, `.error-banner(-body)`, `.error-ref(-copy,-text)`, `.inline-retry`, `.button`, `.button-primary|-outline|-ghost`, `.icon-button`, `.select-trigger`, `.select-content` (Radix), `.select-item`, `.menu` (fixed, z60), `.menu-item`, `.menu-heading`, `.menu-sep`, `.row-menu`, `.row-action`, project sidebar (`.project-list`, `.project-section`, `.project-toggle`, `.project-sessions`, `.project-name-input`, `.session-link`, `.session-row`, `.sidebar-label`, `.sidebar-empty`, `.sidebar-error`, `.sidebar-refresh-error`), goal bar (`.goal-bar`, `.goal-actions`, `.goal-error`, `.goal-hint`, `.goal-menu`, `.goal-meta`, `.goal-panel(-note)`, `.goal-progress`, `.goal-reason(-label,-tip)`, `.goal-review(-actions)`, `.goal-run`, `.goal-status`, `.goal-stuck-actions`), `.budget-*`, `.request-question`, `.transcript`, `.visually-hidden`.

**app/chat.css** (legacy, 453 lines): `.animated-link(-arrow,-tail,-text)`, `.chat-messages`, `.composer`, `.composer-notice`, `.composer-project`, `.connected-tools`, `.tool-chip`, `.live-duration(-digits)` (uses `--number-flow-mask-height: 0.2em`), `.markdown`, `.slash-menu` (absolute, z5, max-h 260), `.smooth-caret`, `.smooth-field`, `.smooth-mirror` (custom textarea caret), `.suggested-questions`, `.transcript`.

**app/panels.css** (legacy, 904 lines): sheets (`.sheet` native dialog `width: min(480px, 100vw); height: 100dvh`, `.sheet-inner`, `.sheet-head`, `.sheet-body`), MCP (`.mcp-settings`, `.mcp-add`, `.mcp-notice`), capabilities (`.capabilities`, `.capability-grid`, `.quick-tools`, `.assistant-tools-body`), documents (`.conversation-documents`, `.document-row`, `.document-upload`), visualizations (`.visualization`, `-controls`, `-dialog`, `-error`, `-question`, `.conversation-visualizations`), request cards (`.request-card`, `-head`, `-icon`, `-timer`, `-approval`, `.request-option(-label,-description,-other)`, `.request-options`, `.request-step`, `.request-submit`, `.request-text`, `.request-action(-label)`, `.request-approval-actions`, `.request-error`, `.request-expired`), plan (`.plan-approval(-question)`, `.plan-feedback(-label)`), runtime (`.runtime-item`, `.runtime-commandExecution`, `.runtime-fileChange`, `.runtime-mcpToolCall`), `.thinking-body`, `.goal-completion(-documents,-name,-summary)`, `.sidebar`, `.sr-only`, `.actions`, `.error`.

**app/observability.css**: only section comments and `@keyframes obs-running`. All observability styling now lives in v2/session.css (`.in-*`, `.tc-*`).

**app/responsive.css**: the ≤700px legacy block in 8.10.

### 8.12 Legacy (app/*.css) vs v2 (styles/v2)

- Both are live. All are imported by `globals.css`; v2 comes last and wins ties.
- v2 is authoritative for: tokens, shell, sidebar, topbar, hero, dock, popovers, search palette, messages, composer, goal strip, session panel (all tabs), trace card, agent dialog.
- Legacy is still the only source for: sheets (MCP settings, assistant tools), request/plan-approval cards (base layout; v2 restyles colors/borders), visualizations, documents, capabilities/quick tools, runtime items, project sidebar sections, Radix select, error banner / app error card, animated link, smooth textarea caret, live duration, slash menu positioning.
- Every legacy class I checked is still referenced by at least one `.tsx` file (for example `sheet` 3 files, `request-card` 2, `project-section` 1, `transcript` 2, `button-primary` 4). `components/project-sidebar.tsx` is still imported by `app/page.tsx`. I did not trace whether each import actually renders at runtime.
- Duplicated class names that v2 overrides or resets explicitly: `.composer`, `.chat-messages`, `.goal-bar`, `.goal-menu`, `.goal-status`, `.goal-panel`, `.goal-review`, `.goal-run`, `.menu`, `.menu-item`, `.menu-sep`, `.request-card`, `.request-option`, `.runtime-item`, `.goal-completion`, `.budget-field`, `.sidebar`, `.sr-only`/`.visually-hidden`, `.eyebrow`, `.muted`, `.brand`, `.topbar`. Comments in v2 shell.css and dock.css list specific leaked properties being neutralized (legacy `.brand` 28px/750 with 56px margin; `.topbar` translucent bg + blur; `.menu` fixed + ellipsis).
- Dead: `app/observability.css` (empty rules; `obs-running` unused). Legacy aliases in base.css exist only to keep legacy files readable.
- Two component systems coexist: `components/v2/*` (spec) and older `components/*.tsx` plus `components/ui` (shadcn-style `Button`/`Select` mapped to legacy classes).

### 8.13 Icon system

- Primary: `components/v2/icon.tsx`, a single `<Icon name size stroke />` rendering inline SVG from a `PATHS` map ("Icon set from docs/truex-design-spec.html (Foundations §5). One 24×24 stroked path per icon"). Defaults `size = 18`, `stroke = 1.75`, `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, round caps and joins. Color comes from `currentColor`.
- Names: `sidebar activity user bot plus search home folder book gear arrowUp paperclip globe at mic check chart table doc sun moon share chevron chevronR chevronL upDown x pulse expand shrink spark stop target plug pause play pencil lock grid logout`.
- Secondary: `lucide-react` `^0.468.0` is still imported by 11 legacy/observability files (`project-sidebar`, `connected-tools`, `sheet`, `assistant-tools`, `runtime-item`, `goal-bar`, `ui/select`, `observability/receipt`, `trace-card`, `privacy-card`, `privacy-note`). Lucide's default stroke is 2px vs the spec's 1.75, so strokes are visibly inconsistent across areas.
- Ad-hoc inline `<svg>` appears in 8 places (e.g. `document-icon.tsx`, charts).
- Robot "looks" for agents are rendered in the agent dialog (`.look`, `.agent-avatar` tinted fills) with `--accent-ink` content on pastel.

### 8.14 Accessibility-relevant styles

- Focus: global `:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; border-radius: 8px }` (spec says `border-radius: 6px`). Re-asserted for `.panel.sidebar`, `.stage .topbar`, `.popover .menu-item`, `.hcard`, `.request-option`. Variants: `.tab` uses `--accent-2` with `outline-offset: -2px`; `.ag-seg-tab` `--accent-2`, offset 1px; `.ag-row` uses tone `--t`; `.in-stack` uses `--ink`; `.hcard-row` offset `-2px`.
- Inputs replace outlines with a border + halo: `border-color: var(--accent-2); box-shadow: 0 0 0 3px var(--accent-soft)`. The composer rings only while the textarea is focused (`.composer.is-focus`, JS-driven), not on `:focus-within`, so tabbing to composer buttons shows only the per-button ring.
- `.msg.agent:focus { outline: none }` and `.composer textarea:focus-visible { outline: none }` remove outlines (the latter compensated by the composer halo; the former has no replacement).
- Reduced motion: global rule in tokens.css sets all `transition-duration` and `animation-duration` to `0ms !important` (the spec's own page uses `none`, the app spec Appendix uses `0ms`). Extra per-area rules in v2/chat.css (`.caret` animation none; transitions off on `.step-caret`, `.msg-foot-chevron`, `.hcard-row`, `.send`, `.composer`) and legacy chat/shell/panels files.
- Touch: `@media (hover: none)` reveals hover-only row menus and agent edit buttons.
- Screen-reader utilities: `.sr-only` (v2 base and legacy panels) and `.visually-hidden` (legacy shell).
- Contrast notes (from token comments, not independently measured): `--accent-fg #2A72A3` is described as AA on white and ice. `--ink-3 #849198` on `#FFFFFF` is roughly 3.3:1 by my estimate, below 4.5:1 for small text, and it is used for 11–12px text (`.eyebrow`, `.convo-time`, `.msg-foot`, placeholders). `.btn-solid` uses white on `#3691CD` (about 3.6:1 by estimate, AA only for large or bold text; 13px/500 buttons fall short). `.btn-ghost` is `--ink-3` by default. Full validation needs manual testing with assistive technologies.
- `.chip`, `.goal-chip` use `aria-pressed`; `.input[aria-invalid="true"]` gets an error border; `.convo-menu:has([aria-expanded="true"])` keeps the menu visible while open.

### 8.15 Spec vs CSS gaps

| Spec item | Status in CSS |
|---|---|
| Type presets (`:root[data-type="editorial|grotesk|literary|geist"]`, `localStorage["truex-type"]`, `useTypePreset()`) | Not implemented. No `data-type` rules or hook in frontend. Only the editorial defaults exist. |
| `--font-hand: "Caveat", ...` scoped to `.roster` | Caveat is loaded in layout.tsx but `--font-hand` is not defined anywhere, so the font download is unused. |
| Agents roster "pinboard" (Session §6: `.roster`, `.bp-board`, `.polaroids`, `.polaroid`, `.pol-card`, `.pol-robot`, `.pol-hint`, `.pol-handle`, `.pol-meta`) | Absent, including its `≤520px`, `hover: none` and reduced-motion rules. |
| `.hint { display: none }` at ≤900px | No `.hint` class in CSS. |
| `:focus-visible` radius 6px (spec page) | App uses 8px. The spec app Appendix may differ from the doc page's own style; this is the doc page's value. |
| Reduced-motion extras for `.ag-span.is-running` (animation none), `.ag-row`, `.ag-seg-tab`, `.in-row-bar`, `.in-meter span` (transition none) | Not present as explicit rules in session.css; covered only by the global `0ms` rule, which shortens rather than disables (infinite `ag-pulse` with 0ms duration effectively stops visually). |
| Dark `--shadow-sm`, `--signature`, `--brand-*` | Not redefined in dark (matches the copied Appendix, but dark `--shadow-sm` at 5% graphite is nearly invisible on `#171717`). |
| Surfaces not covered by spec (cards, markdown, visualizations, sheets, MCP settings, request cards) | Built from spec primitives in v2/chat.css or still legacy-only in app/panels.css; spec gives no values. |
| Tailwind / shadcn | Not in the spec; installed but effectively unused. |


