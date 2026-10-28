# Chat v1 operations

How tenant chat behaves in production, what to watch, its limits, and how to
roll it back. Request flow and API: [../README.md](../README.md). AWS
validation is still open: [backlog/release/01-agentcore-validation.md](../../backlog/release/01-agentcore-validation.md).

## What to watch

platform-next logs JSON lines through Nest's logger; the runtime adapter
writes one JSON object per line to stdout. Neither logs message text, prompts,
tokens or provider errors verbatim.

| Log line                                                                             | Source          | Meaning / action                                                                                  |
| ------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------- |
| `tenants are missing this release's indexes`                                         | platform-next   | Run `ensure-tenant-indexes --all`. Until then retried sends can duplicate chats. Alert on it.     |
| `saving run outcome failed`                                                          | platform-next   | MongoDB refused a settle after every retry. The chat stays busy until recovery saves it. Alert.   |
| `saving run acceptance failed`                                                       | platform-next   | Non-fatal; settle records the thread anyway. Repeated lines mean MongoDB trouble.                 |
| `runtime refused run`, `run reader failed`                                           | platform-next   | Adapter unreachable or refusing (`DRAINING`, `RUNTIME_BUSY`). Check the adapter.                  |
| `recovery sweep found lapsed replies`                                                | platform-next   | A platform process died or gave up a reply; the sweep is saving it. Rare; frequent means crashes. |
| `recovery sweep failed for a tenant` / `could not list`                              | platform-next   | The sweep skipped a tenant this minute; it retries next sweep. Repeated means MongoDB trouble.    |
| `released a chat claimed by a missing run`, `settled a run whose message is missing` | platform-next   | Hand-edited or corrupted data was unlocked. Investigate the chat.                                 |
| `run_finished`                                                                       | runtime-adapter | One per reply: `status`, `code`, `delivery`, `ms`. Source for error rate and duration.            |
| `model_timeout`, `interrupt_timeout`, `codex_exit_mid_run`, `run_error`              | runtime-adapter | Provider silent, Codex not stopping, or Codex crashing. Alert on a rising rate.                   |
| `subscriber_dropped`                                                                 | runtime-adapter | platform-next read too slowly; it reattaches. Repeated means platform-next is overloaded.         |

Every response carries `Server-Timing` with each step and its MongoDB calls.
A normal message makes 6–7 MongoDB calls in total (new chat / follow-up).

## Limits

| Limit                                | Value                                      | Where                           |
| ------------------------------------ | ------------------------------------------ | ------------------------------- |
| Message text                         | 1–32 000 characters                        | platform-next and adapter       |
| Agent prompt                         | 40 000 characters                          | adapter                         |
| Sends per member                     | 20 a minute (per process)                  | `SENDS_PER_MINUTE`              |
| Replies per chat                     | one at a time; later messages steer it     | platform-next and adapter       |
| Steers per reply                     | 5 (`STEER_LIMIT`; adapter caps at 20)      | `STEERS_PER_RUN`                |
| Time to first model output           | 180 s, then `MODEL_TIMEOUT`                | adapter                         |
| Model silence mid-reply              | 120 s, then `MODEL_TIMEOUT`                | adapter                         |
| Codex processes per adapter          | 20 (`RUNTIME_MAX_PROCESSES`)               | idle ones stop after 10 min     |
| Unsent stream data                   | 1 MB browser, 4 MB adapter                 | slow reader dropped, reconnects |
| Run lease                            | 30 s, renewed every 10 s                   | `LEASE_MS`                      |
| Recovery sweep                       | every 60 s, 100 chats per tenant per sweep | `RecoverySweep`                 |
| Stream heartbeat and access re-check | 15 s                                       | `STREAM_HEARTBEAT_MS`           |
| Access token                         | 5 min                                      | revocation window for routes    |
| Model and built-in cache             | 60 s, served 60 s more while reloading     | disable takes up to 2 min       |
| Shutdown drain                       | 30 s                                       | adapter `RUNTIME_DRAIN_MS`      |

Capacity per adapter was not measured locally by decision; it is measured on
AgentCore in the validation slice.

## Recovery: what is and is not guaranteed

- A closed browser never stops or loses a reply; reconnecting replaces the
  browser's text with a snapshot, so nothing is duplicated.
- A platform crash: the reply's lease lapses within 30 s, and the next access
  or the sweep (within about 90 s) takes the lease over. One process wins. It
  reattaches to the runtime's run, or settles from the runtime's history.
- A message the runtime may have received is never sent again. One it has no
  trace of is saved as `NOT_SENT` and the member resends it. This is
  at-most-once delivery to the model, not exactly-once.
- An adapter shutdown mid-reply saves the partial text as failed
  (`RUNTIME_SHUTDOWN`). An adapter crash is not covered by a test:
  recovery then reads Codex's history, which may not hold the partial text.
- A runtime that lost a chat's state (`chat.json` gone) makes the chat
  read-only (`THREAD_LOST`). No replacement thread is ever started; the saved
  history stays readable.
- Live streams need the browser to reach the process reading the reply. Run
  one platform-next process until sticky routing or shared fan-out exists
  ([backlog/performance/06](../../backlog/performance/06-multi-instance-streams.md)).
  The recovery sweep itself is safe with several processes.

## History retention

- MongoDB keeps chats, messages and runs until deleted; v1 has archive only,
  no delete. Removing a member or disabling an agent or model hides nothing
  from the owner and erases nothing.
- The runtime keeps each chat's Codex home (transcript and thread state)
  under `RUNTIME_STATE_DIR`. It is what follow-ups resume from; deleting it
  makes the chat read-only. No expiry exists yet.
- Open decisions, needed before production: how long runtime state is kept
  on AgentCore storage, whether deleting a chat must delete its runtime state,
  and the per-chat disk cost (the Codex plugin sync, fixed with slice 11).

## Deploying and rolling back

1. Run `npm run operator -- ensure-tenant-indexes --operator <you> --all`
   with the new release's CLI whenever `TENANT_INDEX_VERSION` goes up (now 2:
   `active_lease` for the sweep). Extra indexes do not affect the old code.
2. When the runtime adapter changes too, deploy it before platform-next.
3. Deploy platform-next. Draining waits up to 30 s for replies in flight;
   anything left is recovered by the next process.

Rollback is redeploying the previous build. Nothing in v1 is a destructive
migration: indexes are additive, new token fields are ignored by older code,
and older code recovers lapsed replies on access instead of by sweep. Do not
lower `indexVersion` on tenants; leftover indexes are harmless.

## Cutover

Chat v1 runs only on platform-next with the new runtime adapter. The legacy
platform, agent-core and their collections (`truex.sessions`,
`truex.messages`) are untouched and keep working. Moving users from the
legacy chat is a separate product step: legacy conversations are not adopted
or migrated.
