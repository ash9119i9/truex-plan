# Validation evidence and remaining work

Date: 2026-09-19. Repository: `/Users/ashok/truex-plan`.

## Codex 0.162.0 pin, Visualize upgrades and MCP Apps (2026-10-09)

Moved from revision `4a942885` (`rust-v0.149.0`) to `c1382380de69521303b416720a52f42d51af6248` (`rust-v0.162.0`). The prebuilt Linux binaries are pinned by SHA-256 in `codex.lock.json`; `npm run codex:setup` verified the x86_64 archive against it and the runtime reports `codex-cli 0.162.0`. The aarch64 archive's checksum was taken from GitHub's published digest and has not been downloaded here.

- Protocol regenerated and checked against a fresh generation (the generated files are byte-identical): 171 client requests (21 added; `account/rateLimits/read` and `thread/rollback` removed, neither used by Truex), 11 server requests, 86 notifications (9 added). All four services typecheck against it.
- Tool lockdown holds on the new runtime. With Truex's configuration, a request to the model offers only `request_user_input`, `multi_agent_v1`, the three goal tools and `web_search`; no `exec_command`, `write_stdin`, `view_image` or patch tool. The suites that assert those are absent also pass.
- The classic `shell_command` tool no longer exists (unified `exec_command` replaced it), so the real-runtime approval test now scripts `exec_command`; its purpose is unchanged.
- Suites: agent-core 203 passed, 9 skipped; platform 152; model-gateway 58; frontend 203; no failures. The 9 skipped are the real-Chromium renderer tests, which need `CHROMIUM_PATH`. Run against a local Chrome they pass (8 or 9 of 9); one test fails intermittently (a different one on different runs), also on the revision before this change; these tests count all Chrome processes on the machine, which the Chrome already open here may disturb, but that was not isolated as the cause.
- Not checked: a deployed AgentCore image on the new binary, the aarch64 binary, and the browser UI end to end.

Visualize: visuals follow the app's light/dark theme; `preview_visualization` takes `appearance` and reports `missingImages`; uploaded PNG/JPEG/GIF/WebP images can be shown with `truex-file:<id>` (real-Chromium checks of both themes and missing-image detection; tests for byte checks, isolation between conversations and size bounds). See [VISUALIZE.md](VISUALIZE.md).

MCP Apps: see [MCP_APPS.md](MCP_APPS.md) for what was verified, including the official SDK running against Truex's host in Chrome, and what was not.

## Verified

- Codex source fetched from the official upstream into `vendor/codex`, checked out at `4a942885c8b4745757a9f86ad2075e16c42483c5`, and compiled **in this project** with `cargo build --locked -p codex-cli --bin codex`.
- Protocol regenerated from that binary: 152 client requests, 77 notifications and 11 server-request variants. Full schema/type artifacts are in `shared/`.
- Independent TypeScript service builds and the Next.js production build pass.
- Adapter tests cover concurrent start/steer, stale completion, interruption guards, final persistence without subscribers, spool recovery, approval response validation, exactly-once resolution, deadline expiry, pending requests after replay eviction and slow-subscriber eviction.
- Every automatic denial/failure result validates against the generated schema for its server-request variant.
- Real pinned-runtime integration uses a local Responses API fixture. It checks the handshake, concurrent per-thread credentials, streamed deltas/finals, timing counts, zero unknown notifications, and context retained after runtime restart.
- MongoDB tests use an isolated `mongodb-memory-server` process. Only isolated test fixtures are inserted; summaries omit credentials, final/decision writes deduplicate, and missing profiles remain visible.
- HTTP integration launches both real services and the local pinned runtime with isolated MongoDB. It checks chain health, session creation, message idempotency, final persistence without SSE subscribers, history reload without duplicates, timings and continued context after agent-core restart.
- Chrome UI inspection at `http://localhost:3100`: agent picker, healthy dependencies, session creation, streaming text, stop button during a turn, final text, timing chart and restored transcript after browser reload. Output was explicitly labelled as local fixture output.

Run `npm test` and `npm run build` for current results. The runtime test reports skipped if the project binary is absent; a skipped runtime test is not sufficient for the release gate.

## Findings incorporated into the implementation

1. `thread/items/list` exists in the generated protocol but the default history backend returns -32601. The adapter falls back to `thread/read` with `includeTurns: true`.
2. A newly created thread may not be materialized before its first user message. The history endpoint treats that specific state as an empty transcript. An unmaterialized empty thread cannot be recovered after runtime loss.
3. Reloaded history may contain synthetic item IDs different from live events. Assistant persistence reconciles by turn and message position; user messages reconcile by runtime `clientId`.
4. Native EventSource handles cursors during automatic reconnect. Page reload additionally uses session storage plus persisted history and the adapter snapshot.
5. A one-process memory buffer is not durable event storage. Authoritative final messages/decisions/metrics use a disk handoff and MongoDB; deltas remain transient.

## Not verified / not complete

- Broader provider-specific behavior and live MCP tool operations remain unverified. One live OpenRouter conversation succeeded using the user-managed MongoDB profile. No credentials are taken from the environment.
- A real runtime-generated command approval was surfaced, denied, audited and completed in integration testing. Other approval/tool/elicitation variants have schema/adapter coverage, but not a complete runtime exercise.
- Full method-by-method capability acceptance, including experimental backend-gated operations. The generic schema-driven console is available; focused goal, model settings, terminal and lifecycle controls and distinct command/file/MCP/reasoning item cards are implemented. Attachment lifecycle methods are absent from this pin.
- A production concurrency benchmark, TTFT degradation curve or resource sizing. Local fixture timing must not be used to certify provider capacity.
- Local storage-loss tests and backup/restore rehearsals. Deployment infrastructure is outside the current scope.
- Complete replay/snapshot race and prolonged backpressure stress coverage across the browser, platform and adapter.
- Full latency attribution for platform CPU versus transport, and exhaustive non-streaming/failed/no-output timing tests.
- Operational bounds/retention policies for transcript history, audit/timing arrays, spool disk consumption and idle thread metadata under sustained use.

These limits leave the production release gate open. The implementation is a working, tested application foundation; the unchecked plan items are the remaining acceptance work, not an assertion of production readiness.

## User database integration

Configuration now comes from `truex.truex_agents`, `truex.truex_models` and `truex.truex_mcp`. Existing ObjectId references, `apikey`/`apiKey` and HTTP MCP header/bearer authentication shapes are supported. No production seeding entrypoint remains. Exact seed signatures were checked in the configured `agent_platform` and `truex` databases: zero matches, zero deletions. User-owned documents were preserved. The user is updating the current model profile because it previously declared the unsupported `chat` wire protocol.

## Live truex verification

The running platform returned the user-managed `ashok-agents` summary from `truex`, resolving its ObjectId model reference to OpenRouter `openrouter/free`. A live turn returned exactly **Connection verified.** without tool use. User and assistant messages persisted and reloaded; the recorded turn completed in approximately 2.98 seconds with first output at approximately 2.96 seconds. The application is running at http://localhost:3000 with platform 4000 and project-local agent-core 4100.

The attached Qlik MCP server's initialize request timed out after its configured 30-second timeout. The model conversation still completed. This is an external MCP connectivity issue that remains unresolved; it is not reported as successful MCP validation.

Latest automated run: **10 tests passed** (7 adapter/runtime, 3 MongoDB/HTTP). Independent builds and formatting checks passed after the truex document integration.
