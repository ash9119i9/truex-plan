# runtime-adapter

The chat v1 execution service. It runs next to the pinned Codex binary (a local
process on a developer machine, inside the AgentCore microVM in production) and
gives platform-next four operations. It has no database, no browser
authentication and no agent catalog; the platform resolves all of that and sends
typed values.

```text
platform-next ──HTTP (this contract)──► runtime-adapter ──JSON-RPC stdio──► codex app-server ──► model gateway
```

Plan: [tasks/chat-v1-plan.md](../tasks/chat-v1-plan.md).

## Run it

```sh
npm ci
cp .env.example .env     # set RUNTIME_ADAPTER_TOKEN and RUNTIME_STATE_DIR
npm run dev
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUNTIME_ADAPTER_TOKEN` | required | Shared bearer token, at least 32 characters. The platform sends it on every request. |
| `RUNTIME_STATE_DIR` | required | Absolute path holding every chat's Codex home and workspace. Keep it across restarts. |
| `HOST` / `PORT` | `127.0.0.1` / `4400` | Listen address. Loopback by default. |
| `RUNTIME_CODEX_BINARY` | from `codex.lock.json` | Operator override for packaged images. Callers can never choose a binary. |
| `RUNTIME_MAX_PROCESSES` | `20` | Codex processes loaded at once (~150 MB each). |
| `RUNTIME_IDLE_MS` | `600000` | An idle chat's process is stopped after this long. |
| `RUNTIME_DRAIN_MS` | `30000` | Shutdown waits this long for active runs, then stops them. |

## Storage

Each chat gets `RUNTIME_STATE_DIR/t/<tenantId>/c/<chatId>/{home,workspace}`. IDs
must match `^[A-Za-z0-9_-]{1,64}$`, so they cannot escape the state directory.
A thread created for one chat lives only in that chat's home, so another chat's
request cannot read or resume it.

## Contract

Every request needs `Authorization: Bearer <RUNTIME_ADAPTER_TOKEN>`. Bodies are
JSON, at most 256 KiB, and unknown fields are rejected. Errors have one shape:

```json
{ "error": { "code": "CHAT_BUSY", "message": "…", "retryable": false } }
```

### `POST /v1/runs` — start a turn and stream it

```js
{
  runId, tenantId, chatId,           // ^[A-Za-z0-9_-]{1,64}$
  threadId: null | "…",              // null = first message of the chat
  input: { text, clientMessageId },  // text 1–32000 chars
  agentPrompt: "…",                  // ≤ 40000 chars; used only when threadId is null
  model: {
    modelName, gatewayUrl, gatewayToken,   // gatewayUrl: http(s), no credentials
    contextWindow, autoCompactTokenLimit,  // autoCompactTokenLimit < contextWindow
    reasoningEffort?                       // none|minimal|low|medium|high|xhigh
  },
  limits?: { firstResponseMs, silenceMs }  // capped by the adapter's maxima
}
```

The response is `text/event-stream`. Each event has `id: <seq>` (1, 2, 3… per
run), `event: <type>` and JSON `data`. A `: hb` comment is written every 15 s.

| Event | Data | Meaning |
| --- | --- | --- |
| `run.accepted` | `{threadId, turnId, resumed}` | Codex accepted the turn. Save `threadId`. |
| `text.delta` | `{itemId, delta}` | Streamed assistant text. |
| `item.completed` | `{itemId, text}` | A finished assistant message. `itemId` is unique within the run only. |
| `compaction` | `{itemId}` | Codex summarized older context. |
| `retrying` | `{code}` | The provider stream failed and Codex is retrying. |
| `usage` | `{last, total, contextWindow}` | Token counts (`TokenUsageBreakdown`). |
| `run.snapshot` | `{status, threadId, turnId, items}` | Only on reconnect when the cursor is older than the buffer. |
| `run.completed` | `{status, error, delivery, threadId, turnId, items, usage, timings}` | Always last. `status` is `completed`, `stopped` or `failed`. `items` holds every item's text, including partial text. `delivery` is `none` (nothing ran; safe to resend), `accepted` or `unknown` (a turn request went out and its answer was lost; reconcile with history, never resend). |

Rules:

- **Idempotent on `runId`.** Repeating a `runId` with the same body attaches to
  the existing run and replays from the first event. A different body is
  `409 RUN_CONFLICT`.
- **One turn per chat.** A new `runId` while the chat has an active run is
  `409 CHAT_BUSY`. Codex itself would silently merge the second message into
  the running turn, so the adapter enforces this.
- **`run.completed` is sent only when the chat can accept its next turn.** A
  stop after the model has started answering waits for Codex to confirm (at most
  5 s, then the chat's process is restarted). A stop before any model output
  settles at once and restarts the process: Codex does not act on an interrupt
  while it waits for the provider's response headers, and the gateway sends
  those only with its first output.
- **One thread per chat.** The thread ID is recorded in the chat's storage when
  Codex creates it. A first message retried with `threadId: null` reuses that
  thread; a `threadId` that differs from the record fails with `THREAD_MISMATCH`.
- **Instructions are fixed at creation.** On resume the adapter never sends
  `agentPrompt`; resuming with new instructions would replace the thread's
  original prompt.
- **Text only.** The adapter alone builds the Codex configuration. Shell, files,
  images, goals, user-input requests, web search, hooks, skills, project docs and
  sub-agents are disabled, and any approval or input request from Codex is
  refused.
- **Watchdog.** No model output within `firstResponseMs` (default and maximum
  180 s) or no event for `silenceMs` (default 120 s) mid-reply fails the run with
  `MODEL_TIMEOUT`.

### `GET /v1/runs/:runId/events?tenantId&chatId&after=<seq>` — reconnect

Replays events after `after` and continues live. If `after` is older than the
buffer (last 500 events), a single `run.snapshot` is sent first. A finished run
stays reconnectable for 5 minutes, then `404 RUN_NOT_FOUND`.

### `POST /v1/runs/:runId/stop` — stop a run

Body `{tenantId, chatId}`. Returns `202 {status: "stopping"}` or, for a finished
run, `200 {status}`. Repeating it is safe and never sends a second interrupt.

### `GET /v1/chats/:chatId/history?tenantId` — recovery read

Reads the chat's last 20 Codex turns (newest first) without resuming the
thread or starting a turn. It works even when the platform never learned the
thread ID:

```json
{ "turns": [{ "turnId": "…", "status": "completed", "clientMessageId": "…", "text": "…" }] }
```

`404 THREAD_LOST` means the chat's Codex history is gone; the chat stays readable
in MongoDB but cannot continue. Partial text of a stopped or crashed turn is not
in Codex history; the platform keeps its own copy.

### `GET /health`

No authentication. `{status: "ok" | "draining", activeRuns, processes}`.

## Error codes

| Code | Status | Retryable | Meaning |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | no | Body, query or IDs failed validation. |
| `UNAUTHORIZED` | 401 | no | Missing or wrong token. |
| `RUN_NOT_FOUND` | 404 | no | Unknown or expired run, or one belonging to another chat. |
| `THREAD_LOST` | 404 | no | The chat's Codex history no longer exists. |
| `CHAT_BUSY` | 409 | no | The chat already has an active run. |
| `RUN_CONFLICT` | 409 | no | The `runId` was used with a different request. |
| `PAYLOAD_TOO_LARGE` | 413 | no | Body over 256 KiB. |
| `RUNTIME_BUSY` | 503 | yes | Process capacity reached and no idle process can be stopped. |
| `DRAINING` | 503 | yes | The adapter is shutting down. |
| `RUNTIME_UNAVAILABLE` | 503 | yes | Codex did not start or answer in time. |

`INTERNAL` (500, retryable) covers unexpected faults.

Run failures (inside `run.completed.error`): `MODEL_TIMEOUT`, `CONTEXT_FULL`,
`RATE_LIMITED`, `PROVIDER_ERROR`, `RUNTIME_ERROR`, `RUNTIME_SHUTDOWN`,
`THREAD_LOST`, `THREAD_MISMATCH`. Messages
are fixed, user-safe strings; raw provider text is never returned.

## Verified Codex behavior (pin `1ef30bc`)

Found by probing the pin; `test/codex/` runs the real binary against a local
model fixture and asserts these (the last one through the adapter's fast-stop
path), so a Codex upgrade that changes one fails the suite:

- An overlapping `turn/start` is merged into the active turn (hence `CHAT_BUSY`).
- An interrupt repeated after the first is acknowledged (before the turn completes) never gets a reply.
- Interrupted or killed turns keep the user message but drop partial assistant text.
- A provider that sends nothing fails only through the adapter's watchdog.
- With the adapter's configuration the model is offered zero tools.
- `clientUserMessageId` survives a restart as `userMessage.clientId`.
- History can be read from an unloaded thread; resume without instructions keeps the original prompt.
- Retries multiply: 1 request retry × 2 stream retries means up to 6 provider
  attempts; only stream retries emit `error` with `willRetry` (→ `retrying`).
- Stop before the provider sends headers is not acted on by Codex.

## Checks

```sh
npm run typecheck && npm test && npm run build && npm run format:check
```
