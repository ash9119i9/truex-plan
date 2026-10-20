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
| `ADAPTER_ALLOW_LOOPBACK_MCP` | `0` | Test only. `1` lets an MCP spec use an `http` loopback URL; otherwise MCP is https-only. Any other value is off. |

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
  mcp?: [{ name, url, headers, enabledTools?, toolTimeoutSec, startupTimeoutSec }]
                                           // ≤ 3 directory connectors; see "MCP" below
}
```

The response is `text/event-stream`. Each event has `id: <seq>` (1, 2, 3… per
run), `event: <type>` and JSON `data`. A `: hb` comment is written every 15 s.

| Event | Data | Meaning |
| --- | --- | --- |
| `run.accepted` | `{threadId, turnId, resumed}` | Codex accepted the turn. Save `threadId`. |
| `text.delta` | `{itemId, delta}` | Streamed assistant text. |
| `item.completed` | `{itemId, text}` | A finished assistant message. `itemId` is unique within the run only. A reply cut off by a steer never gets this. |
| `input.accepted` | `{clientMessageId}` | A steer entered the running turn (Codex's `userMessage` item for it completed). Once per steer, in stream order; it marks where the steer landed. |
| `compaction` | `{itemId}` | Codex summarized older context. |
| `retrying` | `{code}` | The provider stream failed and Codex is retrying. |
| `usage` | `{last, total, contextWindow}` | Token counts (`TokenUsageBreakdown`). |
| `tool.started` | `{itemId, connector, tool}` | An MCP tool call started (see "MCP"). |
| `tool.completed` | `{itemId, connector, tool, status, durationMs, errorCode?}` | An MCP tool call finished. `status` is `completed` or `failed`; `errorCode` is `REFUSED`, `TOOL_ERROR`, `TIMEOUT` or `UNKNOWN`. |
| `connector.status` | `{connector, status, reason?}` | A connector's startup state changed. `status` is `starting`, `ready` or `failed`; `reason` is `auth`, `unreachable` or `unknown`. |
| `run.snapshot` | `{status, threadId, turnId, items}` | Only on reconnect when the cursor is older than the buffer. |
| `run.completed` | `{status, error, delivery, threadId, turnId, items, usage, timings}` | Always last. `status` is `completed`, `stopped` or `failed`. `delivery` is `none` (nothing ran; safe to resend), `accepted` or `unknown` (a turn request went out and its answer was lost; reconcile with history, never resend). |

Both `run.snapshot.items` and `run.completed.items` are an **ordered** list, in
the order Codex produced them — a reply `{type: "reply", itemId, text,
completed}`, a steer input `{type: "input", clientMessageId}`, or an MCP tool
call `{type: "tool", itemId, connector, tool, status, durationMs?, errorCode?}`.
A reply appears once it has any text (empty replies never appear), and `text`
includes partial text Codex drops after a stop. A tool call appears when it
starts and shows `status: "inProgress"` until it completes. The run's own first
input is **not** in the list.

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

### `POST /v1/runs/:runId/steer` — add a message to the running turn

Body `{tenantId, chatId, input: {text, clientMessageId}}`, validated exactly
like a run's start input. The message joins the turn that is already answering
(`instant_interrupt` is pinned on, so the reply being written is cut off and the
model answers again with the steer in context); `input.accepted` marks where it
entered and the cut reply never completes.

| Answer | Meaning |
| --- | --- |
| `202 {status: "queued"}` | Codex took the message into the running turn. |
| `404 RUN_NOT_FOUND` | Unknown or expired run, or one belonging to another chat. |
| `409 RUN_ENDED` | The run finished, is stopping, or Codex reports no active turn / a newer turn. Nothing was delivered; send it as a new run after `run.completed`. |
| `409 RUN_CONFLICT` | Same `clientMessageId` with a different text, or equal to the run's own input. |
| `409 STEER_LIMIT` | More than 20 steers on one run (a safety cap; the platform caps far lower). |
| `503 STEER_UNKNOWN` | `turn/steer` went out and its answer was lost (RPC timeout, process exit). Never resend; `run.completed.items` shows whether it was used. |

- **Idempotent per run on `clientMessageId`.** A repeat with the same text gets
  the same answer, waiting on the first if it is still in flight.
- **Before acceptance.** A steer that arrives while the run is `starting` waits
  for acceptance, then steers; if the run finishes first it is `RUN_ENDED`.
- Steers on one run are sent to Codex one at a time, in arrival order.

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

## MCP (directory connectors)

A run may attach up to three MCP directory connectors through `StartRunRequest.mcp`.
The platform resolves each one into a typed spec; the adapter forwards it to
Codex, which connects to the server and runs the tools itself. The adapter never
runs a tool and never holds provider state.

```js
mcp?: [{
  name,              // ^[a-z][a-z0-9_]{1,30}$, unique in the list — Codex's server name
  url,               // https only; no credentials, query or fragment
  headers,           // ≤ 16; names ^[A-Za-z0-9-]{1,64}$; values 1–8192 chars, no CR/LF/NUL
  enabledTools?,     // ≤ 200; ^[A-Za-z0-9_.-]{1,64}$ → Codex enabled_tools
  toolTimeoutSec,    // 1–300
  startupTimeoutSec  // 1–60
}]
```

- **Absent or `[]` is byte-for-byte today's text-only behaviour.**
- **No approval field exists.** The adapter always writes
  `default_tools_approval_mode = "auto"` per server and nothing per tool, so a
  read-only tool runs and an unannotated or write tool is refused
  (`errorCode: "REFUSED"`) rather than run. There is no way to switch write
  tools on.
- **The config is sent on every `thread/start` and `thread/resume`.** A resume
  without it gives the model no MCP tools (the pin does not keep the config with
  the thread). If a loaded thread's MCP spec changes (a rotated token, a
  different connector set), the adapter resumes it fresh so the new spec applies;
  only an sha256 fingerprint of the spec — never the headers — is held in memory.
- **Events:** `tool.started` / `tool.completed` from Codex's `mcpToolCall`
  items, and `connector.status` from `mcpServer/startupStatus/updated`. Tool
  calls also appear as `{type: "tool", …}` items in `run.completed`/`run.snapshot`.
- **While a tool call is in flight the watchdog uses that call's limit**
  (`toolTimeoutSec` + 15 s grace) instead of `silenceMs`, because Codex sends no
  notification while a tool runs; it reverts to `silenceMs` when the last call
  completes.
- **Never logged or emitted:** header values, tool arguments, tool results and
  provider error text. Events and logs carry only ids, connector/tool names,
  status, duration and a coarse `errorCode`/`reason`. Verified against the pin:
  the header token appears in no adapter log and in no file under the state dir.
- **`ADAPTER_ALLOW_LOOPBACK_MCP=1`** is a test-only flag that lets a spec use an
  `http` URL whose host is loopback (the local fixture MCP server). Off by
  default, so every real connector is https-only. Any value other than `1` is
  off.

> **Pin findings (kiro/Codex pin).** A refused connection and a bearer-header
> `401` both surface as `connector.status` `failed` with no `failureReason` or
> error text, so the adapter reports `reason: "unknown"` for them; the
> `reauthenticationRequired → reason: "auth"` mapping is reserved for
> OAuth-configured servers. A down server emits `starting` during
> `thread/start`, then `failed` a short time later — the chat still answers.

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
