# Plan: steer a reply while it is being written

Date: 2026-10-19. Builds on chat v1 ([chat-v1-plan.md](chat-v1-plan.md)).

## Decisions (user, 2026-10-19)

1. **Interrupt.** A message sent while a reply streams joins the running turn
   (`turn/steer`). With Codex's `instant_interrupt` (default on, pinned
   explicitly) the reply being written is cut off and the model answers again
   with the steer in context.
2. **Cut-off text stays visible**, labelled "Cut short by your next message".
   Codex drops it from history, so the model never sees it (same as Stop).
3. **A steer the model never read** (Stop or failure before Codex read it) is
   saved as **"Not sent"** with a **Resend** button.
4. **"Turn just ended" race:** the platform handles it. It waits for the
   finished reply to be saved and sends the message as a new turn. The browser
   sends one POST and gets either a steer receipt or a normal send receipt.

## Pinned Codex behaviour (probe `.runtime/steer-probe/probe.ts`, pin 1ef30bc)

- `turn/steer {threadId, expectedTurnId, clientUserMessageId, input}` → `{turnId}`.
- Steer mid-stream: the streaming agentMessage never gets `item/completed`;
  Codex emits `item/started|completed userMessage {clientId}` for the steer,
  then a new agentMessage. History: user, steer, reply (cut text absent).
- Two quick steers: two userMessage items, one follow-up reply.
- Steer before output: works; first answer covers both.
- Steer after the turn ended: `-32600 "no active turn to steer"`; stale turn id:
  `-32600 "expected active turn id …"`.
- Steer racing the end: sometimes accepted (Codex continues the turn), sometimes
  "no active turn".
- Steer then interrupt: with `instant_interrupt` on, Codex had already read the
  steer (userMessage item exists), so it survives in history.

## Runtime adapter contract additions

`features.instant_interrupt: true` is set explicitly in the adapter's Codex
config (it is "under development" upstream; pinning it makes a default change
fail the pin tests instead of silently changing behaviour).

### `POST /v1/runs/:runId/steer`

Body `{tenantId, chatId, input: {text, clientMessageId}}`, validated like the
start input (same text rules, `clientMessageId` matches `ID`).

| Answer | Meaning |
| --- | --- |
| `202 {status: "queued"}` | Codex took the message into the running turn. `input.accepted` marks where it entered. |
| `404 RUN_NOT_FOUND` | Unknown or expired run, or another chat's. |
| `409 RUN_ENDED` (retryable false) | The run finished, is stopping, or Codex reports no active turn / another turn. Nothing was delivered: send it as a new run after `run.completed`. |
| `409 RUN_CONFLICT` | Same `clientMessageId` with different text, or equal to the run's own input. |
| `409 STEER_LIMIT` | More than 20 steers on one run (safety cap; the platform caps at 5). |
| `503 STEER_UNKNOWN` (retryable false) | `turn/steer` went out and its answer was lost (RPC timeout, process exit). Never resend; `run.completed.items` shows whether it was used. |

- **Idempotent per run on `clientMessageId`.** A repeat with the same text gets
  the same answer (waits for the first if still in flight).
- **Before acceptance:** while the run is `starting`, the steer waits for
  `run.accepted`, then steers. If the run finishes first: `RUN_ENDED`.
- Steers on one run are sent to Codex one at a time, in arrival order.

### Events

- New `input.accepted {clientMessageId}`: a steer entered the turn (Codex's
  userMessage item for it completed). Once per steer, in stream order. A reply
  item still streaming at that point was cut off and never gets
  `item.completed`.
- `run.completed.items` and `run.snapshot.items` become an **ordered** list in
  the order Codex produced them:
  - reply: `{type: "reply", itemId, text, completed}` (a reply entry is placed
    when its first text or completion arrives; empty replies never appear)
  - input: `{type: "input", clientMessageId}`
  The run's own input is not in the list.

### History

`GET /v1/chats/:chatId/history` turns gain `items`, ordered:
`{type: "input", clientMessageId: string | null}` (including the turn's first
input) and `{type: "reply", text}`. `clientMessageId` and `text` stay as they are.

## Platform (platform-next) contract

### Data

- `MessageState` adds `"interrupted"` (assistant: cut short by the member's next
  message; partial text kept, not in the model's memory) and `"not_sent"`
  (user: a message added to a reply that the assistant never read).
- `RunDoc.steers?: Array<{clientMessageId, text, textHash, createdAt}>`, at most
  `STEERS_PER_RUN = 5`. Saved on the run **before** it is sent to the adapter.
- `SettleItem = {type: "reply", itemId, text, completed} | {type: "input", clientMessageId}`.

### `POST /chats/:id/messages` on a chat with an active run (steer)

1. Replay: a saved message with this `clientMessageId` → today's receipt. A
   steer on the active run with it → steer receipt (`created: false`); different
   text → `CONFLICT`.
2. Same refusals as a send (archived, lost thread), then the rate limit (steers
   count toward 20/minute).
3. `$push` the steer onto the run, conditional on: not settled, not
   `stopRequested`, id not already there, fewer than 5 steers. No match → re-read:
   this steer present → replay; 5 already → `409 STEER_LIMIT`; settled or stopping
   → fallback (step 5).
4. Send to the adapter (wait first, bounded, if this process is reading the run
   and the adapter has not accepted it yet):
   - `202` → `202` steer receipt.
   - `STEER_UNKNOWN` or unreachable → keep the steer; `202` steer receipt (settle decides).
   - `RUN_ENDED` → `$pull` the steer (only while the run is unsettled). Pulled →
     fallback. Not pulled (the run settled with it as `not_sent`) → `200` send
     receipt of that saved message.
   - `RUN_NOT_FOUND` / other refusals → `$pull`; `409 CHAT_BUSY` / `UNAVAILABLE`.
5. Fallback: refund the rate-limit slot, wait (≤ 15 s) for the run to be
   saved, then do a normal send once (a second active run found then is
   steered normally; no further fallback). Not saved in time → `409 CHAT_BUSY`.

Steer receipt (HTTP 202 new / 200 replay):

```json
{ "chat": {…}, "run": { …RunView, "steers": [SteerView] }, "steer": { "clientMessageId", "text", "createdAt" }, "created": true }
```

A steer receipt has `steer` and no `message`. `RunView.steers` is present only
while the run is unsettled (`GET /chats/:id` included), so a reload shows them.

### Live stream (`GET /chats/:id/runs/:runId/stream`)

- `snapshot.items` and `completed.items`: ordered entries, reply
  `{type: "reply", itemId, text, completed}`, input `{type: "input", clientMessageId}`.
- New event `input {clientMessageId}` when the adapter reports `input.accepted`.
- `delta` / `item` unchanged (`item` = that reply completed).
- `saved.messages` now holds every message the run wrote: replies and steer user
  messages (states `complete`, `interrupted`, `not_sent`, `stopped`, `failed`), in seq order.

### Settle

After the run's own message (`replySeq` = its seq + 1), in Codex's order:
each non-empty reply → assistant message; each input matching a steer → user
message (`complete`, with `clientMessageId` and `textHash`). Then every steer not
in the items → user message `not_sent`, in steer order. Reply state: if an input
follows it in the items, `completed ? "complete" : "interrupted"`; otherwise the
run's state (`complete` / `stopped` / `failed`). Inputs naming no saved steer are
ignored (logged). `nextSeq` grows by the number written. Recovery from history
uses the history turn's ordered items (reply IDs `history:<turnId>:<n>`).

## Frontend

- While a reply streams the composer stays usable; Send and Stop sit side by
  side. Enter sends (steers).
- The steer bubble appears at once at the bottom of the active reply; when
  `input` arrives it is fixed at that point and the new reply streams below it.
- `interrupted` reply: quiet "Cut short by your next message" label.
- `not_sent` user message: "Not sent" label and a Resend button (sends the same
  text with a new `clientMessageId` through the normal send path).
- `STEER_LIMIT` is shown in the composer; the draft is kept.
- A run renders all its messages in seq order (several user messages per run).
