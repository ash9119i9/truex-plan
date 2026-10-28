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

| Variable                     | Default                | Meaning                                                                                                          |
| ---------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `RUNTIME_ADAPTER_TOKEN`      | required               | Shared bearer token, at least 32 characters. The platform sends it on every request.                             |
| `RUNTIME_STATE_DIR`          | required               | Absolute path holding every chat's Codex home and workspace. Keep it across restarts.                            |
| `HOST` / `PORT`              | `127.0.0.1` / `4400`   | Listen address. Loopback by default.                                                                             |
| `RUNTIME_CODEX_BINARY`       | from `codex.lock.json` | Operator override for packaged images. Callers can never choose a binary.                                        |
| `RUNTIME_MAX_PROCESSES`      | `20`                   | Codex processes loaded at once (~150 MB each).                                                                   |
| `RUNTIME_IDLE_MS`            | `600000`               | An idle chat's process is stopped after this long.                                                               |
| `RUNTIME_DRAIN_MS`           | `30000`                | Shutdown waits this long for active runs, then stops them.                                                       |
| `ADAPTER_ALLOW_LOOPBACK_MCP` | `0`                    | Test only. `1` lets an MCP spec use an `http` loopback URL; otherwise MCP is https-only. Any other value is off. |

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
  input: { text, clientMessageId },  // text 1–40000 chars
  agentPrompt: "…",                  // ≤ 40000 chars; used only when threadId is null
  model: {
    modelName, gatewayUrl, gatewayToken,   // gatewayUrl: http(s), no credentials
    contextWindow, autoCompactTokenLimit,  // autoCompactTokenLimit < contextWindow
    reasoningEffort?                       // none|minimal|low|medium|high|xhigh
  },
  limits?: { firstResponseMs, silenceMs }  // capped by the adapter's maxima
  mcp?: [{ name, url, headers, enabledTools?, approvedTools?, toolTimeoutSec, startupTimeoutSec }]
                                           // ≤ 3 directory connectors; see "MCP" below
  codingApprovals?: { commands: [sha256…] }
                                           // coding only; see "Coding profile" below
  skills?: [{ sha256, slug }]              // ≤ 10, pushed first; see "Skills" below
}
```

The response is `text/event-stream`. Each event has `id: <seq>` (1, 2, 3… per
run), `event: <type>` and JSON `data`. A `: hb` comment is written every 15 s.

| Event                                           | Data                                                                                                          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.accepted`                                  | `{threadId, turnId, resumed}`                                                                                 | Codex accepted the turn. Save `threadId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `text.delta`                                    | `{itemId, delta}`                                                                                             | Streamed assistant text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `item.completed`                                | `{itemId, text}`                                                                                              | A finished assistant message. `itemId` is unique within the run only. A reply cut off by a steer never gets this.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `input.accepted`                                | `{clientMessageId}`                                                                                           | A steer entered the running turn (Codex's `userMessage` item for it completed). Once per steer, in stream order; it marks where the steer landed.                                                                                                                                                                                                                                                                                                                                                                   |
| `compaction`                                    | `{itemId}`                                                                                                    | Codex summarized older context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `retrying`                                      | `{code}`                                                                                                      | The provider stream failed and Codex is retrying.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `usage`                                         | `{last, total, contextWindow}`                                                                                | Token counts (`TokenUsageBreakdown`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tool.started`                                  | `{itemId, connector, tool}`                                                                                   | An MCP tool call started (see "MCP").                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tool.completed`                                | `{itemId, connector, tool, status, durationMs, errorCode?}`                                                   | An MCP tool call finished. `status` is `completed` or `failed`; `errorCode` is `REFUSED`, `TOOL_ERROR`, `TIMEOUT` or `UNKNOWN`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `approval.requested`                            | `{approvalId, itemId, kind, connector, tool, params, allowForChat, scope?, diff?, diffTruncated?, expiresAt}` | A tool call, command or file change waits for the member (see "Approvals").                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `approval.resolved`                             | `{approvalId, itemId, kind, connector, tool, params, scope?, decision, auto}`                                 | How it ended. `decision`: `allow`, `allow_for_chat`, `deny`, `expired`, `cancelled`; `auto` when a standing Allow for this chat answered it without a card.                                                                                                                                                                                                                                                                                                                                                         |
| `command.started`                               | `{itemId, command}`                                                                                           | Coding: a command started (or is about to ask).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `command.output`                                | `{itemId, delta, truncated?}`                                                                                 | Coding: live output, up to 16 000 chars per command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `command.completed`                             | `{itemId, command, status, exitCode?, durationMs?, approval?}`                                                | Coding: `status` is `completed`, `failed` or `declined` (never ran).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `file_change.started` / `file_change.completed` | `{itemId, files, status?, approval?}`                                                                         | Coding: an apply_patch; `files` are `{path, kind, movePath?}` relative to the workspace, `kind` `add`/`update`/`delete`/`move`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `file_change.progress`                          | `{itemId, files, lines, preview?}` or `{itemId, ended: true}`                                                 | Coding: a patch the model is still writing (Codex `apply_patch_streaming_events`), about every 500 ms. `preview` `{path, offset, text, truncated}` is the next piece (at most 64 Ki characters) of the first new file's text: `offset` is where `text` starts, always the end of the previous piece; at most 256 Ki characters in all, then `truncated: true`. Edits carry no text. Not an item: never in snapshots or `run.completed.items`. It stops at `file_change.started` for the same `itemId`, or with `ended` when Codex rejected the patch. |
| `skill.used`                                    | `{slug}`                                                                                                      | The model opened one of the run's skills (`skills.read`). Once per skill per run.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `plan.updated`                                  | `{explanation, steps}`                                                                                        | The model called `update_plan`. Always the whole plan: replace the last one. `steps` are `{step, status}` (`pending`, `inProgress`, `completed`), at most 50 of 500 chars; `explanation` is at most 2 000 chars or `null`. Malformed steps are dropped; helpers' plans never appear. Not an item.                                                                                                                                                                                                                   |
| `connector.status`                              | `{connector, status, reason?}`                                                                                | A connector's startup state changed. `status` is `starting`, `ready` or `failed`; `reason` is `auth`, `unreachable` or `unknown`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `run.snapshot`                                  | `{status, threadId, turnId, items, approvals, plan?}`                                                         | Only on reconnect when the cursor is older than the buffer.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `run.completed`                                 | `{status, error, delivery, threadId, turnId, items, usage, timings, plan?}`                                   | Always last. `status` is `completed`, `stopped` or `failed`. `delivery` is `none` (nothing ran; safe to resend), `accepted` or `unknown` (a turn request went out and its answer was lost; reconcile with history, never resend).                                                                                                                                                                                                                                                                                   |

Both `run.snapshot.items` and `run.completed.items` are an **ordered** list, in
the order Codex produced them — a reply `{type: "reply", itemId, text,
completed}`, a steer input `{type: "input", clientMessageId}`, an MCP tool
call `{type: "tool", itemId, connector, tool, status, durationMs?, errorCode?,
approval?}`, a command `{type: "command", itemId, command, status, exitCode?,
durationMs?, output, outputTruncated, approval?}` or a file change `{type:
"file_change", itemId, files, status, approval?}`, or a skill the model
opened `{type: "skill", slug}`.
A reply appears once it has any text (empty replies never appear), and `text`
includes partial text Codex drops after a stop. A tool call appears when it
starts and shows `status: "inProgress"` until it completes. The run's own first
input is **not** in the list.

`plan` on both is the last `plan.updated`, exactly as the model sent it, also
when the run is `stopped` or `failed` (steps may then still be `pending` or
`inProgress`). It is absent when the run never planned.

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
  original prompt. The adapter's own planning guidance (developer
  instructions) is sent on start and every resume; the model receives one copy
  per request, not one per resume.
- **Text only by default.** The adapter alone builds the Codex configuration.
  Shell, files, images, goals, user-input requests, web search, hooks, host
  skills, project docs and sub-agents are disabled; only Codex's `update_plan`
  checklist tool and the run's own skills are offered. Only MCP approvals are
  relayed;
  every other request from Codex is refused. `RUNTIME_CODING_ENABLED=1` turns
  on the coding profile for every run (see below).
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

| Answer                   | Meaning                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `202 {status: "queued"}` | Codex took the message into the running turn.                                                                                                     |
| `404 RUN_NOT_FOUND`      | Unknown or expired run, or one belonging to another chat.                                                                                         |
| `409 RUN_ENDED`          | The run finished, is stopping, or Codex reports no active turn / a newer turn. Nothing was delivered; send it as a new run after `run.completed`. |
| `409 RUN_CONFLICT`       | Same `clientMessageId` with a different text, or equal to the run's own input.                                                                    |
| `409 STEER_LIMIT`        | More than 20 steers on one run (a safety cap; the platform caps far lower).                                                                       |
| `503 STEER_UNKNOWN`      | `turn/steer` went out and its answer was lost (RPC timeout, process exit). Never resend; `run.completed.items` shows whether it was used.         |

- **Idempotent per run on `clientMessageId`.** A repeat with the same text gets
  the same answer, waiting on the first if it is still in flight.
- **Before acceptance.** A steer that arrives while the run is `starting` waits
  for acceptance, then steers; if the run finishes first it is `RUN_ENDED`.
- Steers on one run are sent to Codex one at a time, in arrival order.

### `POST /v1/runs/:runId/approvals/:approvalId` — answer an approval

Body `{tenantId, chatId, decision}` with `decision` `allow`, `allow_for_chat`
or `deny`. `200 {decision}` returns the decision applied: `allow_for_chat` on a
card with `allowForChat: false` (a push) is applied as `allow`. A repeat is
`409 APPROVAL_RESOLVED`; an unknown, expired or finished one `404
APPROVAL_NOT_FOUND`. A stop, a steer or the run ending declines every open
card. "Allow for this chat" is held by the adapter for the run and by the
platform across runs (`approvedTools`, `codingApprovals`); Codex's own session
approvals are never used, so every call is still audited.

### `GET /v1/chats/:chatId/history?tenantId` — recovery read

Reads the chat's last 20 Codex turns (newest first) without resuming the
thread or starting a turn. It works even when the platform never learned the
thread ID:

```json
{
  "turns": [
    {
      "turnId": "…",
      "status": "completed",
      "clientMessageId": "…",
      "text": "…"
    }
  ]
}
```

`404 THREAD_LOST` means the chat's Codex history is gone; the chat stays readable
in MongoDB but cannot continue. Partial text of a stopped or crashed turn is not
in Codex history; the platform keeps its own copy.

### `GET /v1/chats/:chatId/files?tenantId` — list the chat's files

The chat's visible regular files, for the platform to copy into chat storage
after a run: `{files: [{path, size, modifiedAt}], truncated}`. `path` is
workspace-relative with `/`. Dot entries, symlinks and `node_modules`,
`__pycache__` and `venv` are skipped; at most 500 files and 5,000 examined
entries, then `truncated: true`. A chat that never ran lists nothing.

### `GET /v1/chats/:chatId/file?tenantId&path` — read one file

The file's bytes (`application/octet-stream`). `path` must be a listed path:
no `..`, `.`-prefixed or empty segments, absolute paths or backslashes
(`400 INVALID_REQUEST`). A symlinked file or folder, a missing file, or a file
that resolves outside the workspace is `404 FILE_NOT_FOUND`; over 20 MiB is
`413 PAYLOAD_TOO_LARGE`.

### `PUT /v1/chats/:chatId/uploads/:name?tenantId&sha256` — write an attached file

A file the member attached to a message, written before the run that reads it
starts. Body: the raw bytes (`application/octet-stream`, at most 20 MiB, else
`413`). It lands at `uploads/<name>` in the workspace, replacing a file of that
name, and returns `{path, size, modifiedAt}`. `name` (URL-encoded) is one NFC
path segment of at most 255 bytes, not starting with `.`, with no `/`, `\` or
control characters; `sha256` is the hex digest of the bytes. A bad name or a
digest mismatch is `400` and leaves nothing behind: bytes go to a hidden
temporary file, are checked, then renamed into place. `409 UPLOAD_CONFLICT`: a
folder is in the way, or `uploads` is not a real folder (a symlink is never
followed). `409 CHAT_BUSY`: a run of the chat is in progress here. `409
UPLOADS_DISABLED`: coding is off, so the model could not read the file.

### `PUT /v1/chats/:chatId/skills/:sha256?tenantId` — push a skill bundle

Body: the `application/gzip` archive (at most 5 MB) of one skill folder,
`<slug>/SKILL.md` plus optional `references/`, `scripts/` and `assets/`. The
adapter checks the digest, refuses symlinks, `..`, duplicate paths and
oversize or deep trees, and unpacks it once into `<state>/skills/<sha256>/`,
outside every workspace. Repeating it is a no-op (`{slug, created: false}`);
the directory is shared by every chat on this runtime that uses the version.
Works with coding off.

## Skills

A run's `skills` become Codex capability roots on `thread/start`, so the
model sees each skill's name and description and reads it on demand with
Codex's `skills.list` / `skills.read` tools. A run naming a skill this runtime
does not hold is `409 SKILLS_MISSING` with `details.missing` (the digests to
push), before any process starts. Send the same list on every run: Codex
fixes a thread's skills at creation. With coding on, the sandbox may read the
run's skill directories (never write them) so their scripts can run; other
chats' skills on the runtime stay unreadable.

Codex emits no thread item for a skill read. The adapter reads the thread's
rollout file from where the turn began and reports each `skills.read` of one
of the run's slugs as `skill.used`.

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
- **Write tools ask.** The adapter always writes
  `default_tools_approval_mode = "auto"` per server and nothing per tool, so a
  read-only tool runs and an unannotated or write tool raises
  `approval.requested` (`kind: "mcp"`). `approvedTools` lists the tools the
  member allowed for this chat; their approvals are answered without a card.
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

## Coding profile

`RUNTIME_CODING_ENABLED=1` (only `1`; default off) gives every run the same
Codex tools: `exec_command`, `write_stdin` and `apply_patch`. It is an
operator switch, not a per-agent setting, and it stays off in AgentCore until
the Linux sandbox there is verified. With it off, runs are byte-for-byte the
text-only ones. The profile lives in `src/codex/coding.ts`.

- **Sandbox.** Each thread starts with the `truex` permissions profile:
  reads limited to the system minimum, the toolchains and the chat's
  workspace; writes to the workspace and a per-chat scratch directory (HOME
  and TMPDIR for commands); no network. The adapter's state directory and
  `/tmp` are denied, which keeps every command sandboxed, including allowed,
  approved and escalated ones (verified: without a denied path Codex runs an
  allowed command unsandboxed).
- **Approvals.** A granular policy (`sandbox_approval: false`, `rules: true`,
  `mcp_elicitations: true`). Commands and file changes inside the chat run
  without a card; the platform keeps file versions instead. The rules file
  (`home/rules/default.rules`, rewritten every run) has prompt rules for
  `git push`, `git reset --hard` and `git clean`, which ask. Codex refuses,
  without a card, what would leave the sandbox (an escalation request, a
  patch outside the workspace) and commands it flags as dangerous (`rm -f`,
  `sudo`); the model is told why. Prompt rules are best effort: a command
  inside a script or `python -c` is not parsed.
- **Cards.** `kind: "command"` (`connector: "@workspace"`, `tool: "command"` or
  `"push"`, params `command` and `cwd`). Paths are relative to the workspace.
  A command longer than 4000 chars, one with control or bidi characters, a
  network or extra-permission request, a file-change request, or a request
  that matches no started item is declined without a card.
- **Allow for this chat.** `scope` is the sha256 of the exact command and
  re-allows only that command. The platform sends scopes back as
  `codingApprovals`. A push never offers it.
- **Model catalog.** The adapter writes `home/model-catalog.json` for the run's
  model and starts Codex with it, so the model gets `apply_patch` and its own
  context window (Codex's fallback clamps to 272k × 95%). A changed catalog
  restarts the chat's process. The gateway offers `apply_patch` (a Responses
  custom tool) to other providers as a function.
- **Toolchains.** Node from the adapter's own prefix; extra read-only prefixes
  in `RUNTIME_TOOLCHAIN_DIRS` (colon-separated absolute paths), whose `bin`
  directories come first on the commands' PATH. Python 3 (3.11 or later) with
  the pinned document libraries in `toolchain/requirements.in` (python-docx,
  openpyxl, python-pptx, pypdf, reportlab; transitive pins and hashes in
  `requirements.txt`). The image has them at `/opt/truex/python` and sets
  `RUNTIME_TOOLCHAIN_DIRS` to it. Locally, `npm run toolchain:setup` (repo
  root) builds `.runtime/toolchain/python` from hash-checked wheels and prints
  the line to add; `npm run toolchain:check` reports what is missing, and
  `npm run dev:next` warns when coding is on and the toolchain is incomplete.
  `test/codex/toolchain.test.ts` runs Node and Python tests and the libraries
  inside the sandbox; it needs the toolchain (`RUNTIME_TEST_TOOLCHAIN_DIRS`
  selects another one).
- **Watchdog.** While a command runs the silence limit is at least 10 minutes.

## Error codes

| Code                  | Status | Retryable | Meaning                                                      |
| --------------------- | ------ | --------- | ------------------------------------------------------------ |
| `INVALID_REQUEST`     | 400    | no        | Body, query or IDs failed validation.                        |
| `UNAUTHORIZED`        | 401    | no        | Missing or wrong token.                                      |
| `RUN_NOT_FOUND`       | 404    | no        | Unknown or expired run, or one belonging to another chat.    |
| `THREAD_LOST`         | 404    | no        | The chat's Codex history no longer exists.                   |
| `CHAT_BUSY`           | 409    | no        | The chat already has an active run.                          |
| `RUN_CONFLICT`        | 409    | no        | The `runId` was used with a different request.               |
| `FILE_NOT_FOUND`      | 404    | no        | The path is not a regular file inside the chat's workspace.  |
| `PAYLOAD_TOO_LARGE`   | 413    | no        | Body over 256 KiB.                                           |
| `RUNTIME_BUSY`        | 503    | yes       | Process capacity reached and no idle process can be stopped. |
| `DRAINING`            | 503    | yes       | The adapter is shutting down.                                |
| `RUNTIME_UNAVAILABLE` | 503    | yes       | Codex did not start or answer in time.                       |

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
- With the adapter's configuration the model is offered only `update_plan`.
- A malformed `update_plan` call fails only that tool call: the model gets a
  parse error and the turn continues.
- A resumed thread's requests carry one copy of the developer instructions,
  however often it was resumed.
- `clientUserMessageId` survives a restart as `userMessage.clientId`.
- History can be read from an unloaded thread; resume without instructions keeps the original prompt.
- Retries multiply: 1 request retry × 2 stream retries means up to 6 provider
  attempts; only stream retries emit `error` with `willRetry` (→ `retrying`).
- Stop before the provider sends headers is not acted on by Codex.

## Checks

```sh
npm run typecheck && npm test && npm run build && npm run format:check
```
