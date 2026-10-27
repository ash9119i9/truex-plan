# 03 — Codex TUI presentation of sub-agents

Source: `vendor/codex/codex-rs/tui/src` (multi_agents.rs, app/agent_navigation.rs, app/agent_status_feed.rs, app/agents_overview_details.rs, app/agent_picker.rs, app/thread_routing.rs, app/side.rs).

## Core idea

The UI is a **projection of events**. Every child is a separate thread with its own buffered event channel. The parent transcript only shows compact orchestration rows built from `CollabAgentToolCall` / `SubAgentActivity` items. The full child transcript lives in the child's own thread view, and you switch into it.

```text
app-server notifications ─▶ thread_routing::enqueue_thread_notification
                              ├─ per-thread ThreadEventStore (bounded buffer)
                              ├─ active thread ⇒ render now
                              └─ inactive thread ⇒ buffer; replay on switch
```

## Surfaces

1. **Inline history rows in the parent** (`multi_agents.rs`):
   - V2 rows: `Started <path>`, `Interacted with <path>`, `Interrupted <path>`, `Completed <path>`.
   - V1 rows: `Spawned <nickname> [role] (model, effort)` + prompt preview, `Sent input to`, `Waiting for N agents` → `Finished waiting` (with per-agent status), `Closed`, `Resuming/Resumed`.
   - In-progress spawn renders nothing; the row appears when the spawn is accepted. Failed spawn → "Agent spawn failed".
   - send_message / followup / interrupt / list are analytics-only in V2 (no row). Noise is deliberately suppressed.
2. **`/subagents` status card** (`agent_status_feed.rs`): one entry per live child, title = agent path, preview = last ≤6 activity items, ≤3 lines, ≤240 graphemes, de-duplicated by item id. Empty state: "No sub-agents running." / "No recent activity yet."
3. **Agent picker** (`/subagents` picker, `agent_picker.rs`): `Main [default]` + children as `nickname [role]`, status dot (running / closed dimmed). Background refresh scoped to the root tree.
4. **Overview details panel** (`agents_overview_details.rs`): bounded previews (512 chars) of last message / reasoning / pending request per agent, built **only from already-delivered events** — observing never attaches to a thread or fetches history.
5. **Thread switching**: `Alt+←/Alt+→` cycle agents in **first-seen spawn order** (stable even when entries close). macOS Option+b/f fallback only when the composer is empty. Footer shows the label of the watched agent.
6. **Side conversations** (`side.rs`): ephemeral fork for a quick question, with hidden instructions that make inherited history read-only context and discourage mutations. Parent status changes are tracked while the side thread is visible.

## Approvals from children

Child approval / elicitation requests are routed to the child's channel. If the child is not visible, `surface_pending_inactive_thread_interactive_requests` pushes them into the active view as modals, labelled with the source thread (`thread_label`); patch approvals also render a diff preview into history first. A child never silently blocks on an approval the user cannot see.

## Lessons for Truex UI

1. Parent transcript shows compact, event-driven rows (Started / Completed / Failed), never the child's raw stream.
2. Each child has its own viewable transcript; switching replays the buffered events.
3. A live "agents" panel with bounded previews (counts, char caps) from data already received — no extra fetches per render.
4. Stable ordering by spawn time; closed agents stay listed but dimmed.
5. Child approvals bubble up to the visible view with a clear "from agent X" label.
6. Suppress low-value orchestration noise (messages, list calls) in the main transcript.
