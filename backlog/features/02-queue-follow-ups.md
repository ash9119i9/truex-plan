# Chat: queue unrelated follow-ups (second gesture next to steer)

Status: open · Added 2026-10-19 · Depends on: chat steer (`tasks/chat-steer-plan.md`)

## Goal

Let the user send an unrelated message while a reply is running without changing that reply. The message waits and is sent as its own turn once the reply finishes. Steer stays the default (Enter); queueing is a second, explicit gesture. No Codex changes.

## Problem

Enter while busy steers the running turn. That is right when the new message changes the current answer ("make it about a dragon"). It is wrong for an unrelated question: on 2026-10-19, "Tell me a story" plus a steered "2+2" produced one merged answer ("2 + 2 = 4. Here's a short story about it") on Claude Sonnet 5.5. A steer sent before the first text also waits for the first call's first byte and then restarts it (about 13–16 s instead of about 7 s).

Today the only way to ask something unrelated is to wait and send it manually after the reply finishes.

## Prior art

- **Codex terminal UI (pinned source, `vendor/codex/codex-rs/tui`):** Enter steers, Tab queues. Queued messages are sent as a new turn after the current turn completes (`chatwidget/input_queue.rs`, `chatwidget/input_flow.rs`). The footer shows "Tab to queue message". Esc with pending messages stops the turn and sends them at once (`chatwidget/input_restore.rs`).
- **DeepSeek Harness (`~/deepseek-harness`):** queue is the default and Cmd/Ctrl+Enter steers; a settings toggle swaps them. Queued messages sit in a dock above the composer ("{n} queued messages") with Edit, Remove and "Steer queued message".

## Proposed UX

- **Gesture:** a "Queue" action next to Send while a reply runs, plus a keyboard shortcut. Tab conflicts with focus navigation in a browser, so pick an accessible shortcut (for example Alt+Enter) and keep the button as the primary path.
- **Dock:** queued messages appear above the composer with Edit, Remove and "Steer now" (turns a queued message into a steer of the running reply).
- **Send order:** when the reply settles, the first queued message is sent as a normal message; the rest follow one per turn, in order.
- **Failures:** a queued message that fails to send shows the existing "Not sent" state with Resend.
- **Stop:** queued messages stay queued after Stop and are not sent automatically (open decision 3).

## Design notes

- Platform owns the queue so it survives reload and shows in every tab. Store it on the chat, keyed by `clientMessageId`, so enqueue and dequeue are idempotent.
- Dequeue happens in the same settle path that already handles "message arrived as the reply ended" (it becomes a normal send). Reuse that path instead of adding a second scheduler.
- Queued sends count toward the 20-per-minute limit when they are actually sent, not when queued. Cap the queue length (about 5).
- The adapter needs no changes: a queued message is a normal `start` once the reply is saved.
- Settle and dequeue must be safe against two platform instances and a crash between "reply saved" and "next send started" (see `backlog/performance/06-multi-instance-streams.md`).

## Open decisions

1. Shortcut and button placement (Tab is not usable as-is in a browser).
2. Server-stored queue (recommended) or browser-only.
3. After Stop: keep queued messages waiting (recommended) or send them, Codex Esc style.
4. Settings toggle to make queue the Enter default, like DeepSeek. Recommended: not until MCP tools make replies multi-step and the steer/queue difference matters more.

## Done when

- A queued message never changes the running reply and is answered as its own turn after it.
- Queued messages survive reload, show in a second tab, and are sent exactly once, including across a platform restart mid-settle.
- Edit, Remove and "Steer now" work while the reply runs; the queue cap and rate limit are enforced with a clear error.
- Real-model check: "Tell me a story", queue "2+2" mid-reply; the story completes and the next reply is just "4".
