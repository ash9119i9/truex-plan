# Fault Points

Where each failure can be injected in the new stack, with the support code that already does it. Prefer these over new mocks: they run the real code path. Read the named test before writing a new one; most patterns already exist once.

## runtime-adapter (real HTTP, real pinned Codex)

Support: `Harness` in `test/support/harness.ts`. Start with `new Harness(options)`, `before(() => h.start())`, `after(() => h.close())`.

| Fault | How | Existing example |
|---|---|---|
| Model slow, silent, failing, hostile | `h.model.script.push(...)`; see hostile-model.md | `test/codex/failures.test.ts` → `describe("watchdog and provider failures")` |
| Short timeouts so a test does not wait minutes | `new Harness({ limits: { silenceMs, firstResponseMs, stopMs, approvalMs, rpcMs, bufferEvents, finishedRunTtlMs } })` (fields of `RuntimeLimits` in `src/config.ts`) | `new Harness({ limits: { stopMs: 3000 } })` in `failures.test.ts` |
| Codex process crash mid-turn | `process.kill(pid, "SIGKILL")` on Codex children, from inside `readSse(res, onEvent)` at a chosen event; `codexChildren()` helper (uses `pgrep -P`) | `"a Codex crash mid-reply fails the run, and the next message resumes"` |
| Adapter restart (same state, fresh processes) | `await h.restart()` | `"after an adapter restart the chat resumes the same thread with its prompt"` |
| Lost thread storage | `rm(join(h.stateDir, "t", "<tenantId>", "c", "<chatId>"), { recursive: true })` after a restart | `"a thread whose storage is gone is THREAD_LOST and nothing is sent"` |
| Process capacity and eviction | `new Harness({ maxProcesses: 1 })` | `describe("capacity and drain")` |
| Drain / shutdown during a run | `h.manager.drain(ms)` | `"drain refuses new runs and stops active ones as RUNTIME_SHUTDOWN"` |
| Reconnect with a cursor, or one older than the buffer | `h.fetch(\`/v1/runs/${runId}/events?tenantId=…&chatId=…&after=${seq}\`)`, small `bufferEvents` | `"a reconnect replays after the cursor, or sends a snapshot when it is too old"` |
| Stop, steer and approvals racing the turn | `h.stop(runId)`, `h.steer(runId, input)`, `runAnswering(h, body, answer)`; fire inside `onEvent` with `Promise.all` | `describe("stop")` in `failures.test.ts`, `test/codex/steer.test.ts` |
| MCP tool down or hanging | `Harness({ allowLoopbackMcp: true })`, `test/support/mcp-fixture.ts`, `deadMcpUrl()` | `test/codex/mcp.test.ts` |
| Network proxy / outside hosts (coding profile) | `Harness({ coding: true, networkEnv })`, `test/support/network-fixture.ts` | `test/codex/network.test.ts` |
| Request validation and limits | `h.post(path, body)` with bad bodies; the 256 KiB `PAYLOAD_TOO_LARGE` cap | `test/http/http.test.ts` |

What to read in events: `completed(events)` returns the `run.completed` data (`status`, `error.code`, `delivery`, `items`) and throws if the stream did not end with it. `streamedText(events)` joins `text.delta`. `h.logs` holds the adapter's structured log events for asserting what was logged (and what was not).

## platform-next (NestJS + MongoDB)

Support: `startReplicaSet()` and `startApp({ mongodbUri, ... })` in `test/support/test-app.ts` (mongodb-memory-server replica set, so transactions work); `resetOwnedData(database)` in `test/support/reset.ts` between tests; `FakeGateway`, `AdapterProcess`, `readStream()` in `test/support/chat-stack.ts` for end to end.

| Fault | How | Existing example |
|---|---|---|
| Model behaviour end to end | `FakeGateway.script`; `held` + `release()` to hold a reply open; `waitForRequests(n)` to act after the nth request | `test/integration/chats.test.ts` |
| Adapter process crash | `adapter.stop(true)` (SIGKILL; in-memory runs lost), then `adapter.start(adapter.stateDir)` to restart on the same state | `chat-stack.ts` `AdapterProcess` |
| Adapter graceful restart | `adapter.stop()` (SIGTERM), then `start(stateDir)` | same |
| MongoDB unreachable or late | Start the service against a free port with no server, then start `MongoMemoryServer` on that port; or `mongo.stop()` mid-test | `test/integration/database-connect.test.ts` |
| Duplicate or retried requests | Send the same body (same `clientMessageId`) twice, sequentially and with `Promise.all` | `test/integration/chats.test.ts` |
| Randomness the code uses | Replace `Math.random` in a `try/finally` and restore it | `chats.test.ts` (`originalRandom`) |
| Slow follow-up / report work | Bench and golden files | `test/integration/followups-bench.test.ts`, `test/support/followups-golden.json` |

For stored state, assert the documents themselves (count, fields, no duplicates) through the database service, not only the HTTP response. A write that "succeeded after the caller gave up" shows up only there.

## model-gateway (provider translation)

Support: `createGateway({ secret, log, findProfile, ... })` from `src/server.ts`, a local `createServer` as the provider, `signGatewayToken()` from `shared/gateway-token.ts` for the token.

| Fault | How | Existing example |
|---|---|---|
| Provider never sends headers, stalls mid-stream, slow but steady | The local provider handler controls timing; `upstreamFirstByteTimeoutMs`, `upstreamIdleTimeoutMs` | `test/upstream.test.ts` |
| Provider stream cut early, in-stream errors, HTTP errors | The local provider writes error frames or ends early | `test/anthropic.test.ts` ("...stream cut early and in-stream errors fail the stream"), `test/chat.test.ts` ("in-stream context errors...") |
| Profile missing or disabled | `findProfile` returns nothing or `enabled: false` | `test/profiles.test.ts` |

`shared/gateway-token.ts` is also used by the old stack. A test that changes it changes the old stack too: say so in the report.

## frontend (pure logic)

Support: `node --experimental-strip-types --test test/<file>.test.ts`; `test/auth-fixture.ts`. These test state, reducers, batching and the API client, not rendering in a browser.

| Fault | How | Existing example |
|---|---|---|
| Event bursts, reorder, duplicates into the chat state | Feed event sequences to the reducer | `test/chat-batch.test.ts`, `test/ordered-batch.test.ts` |
| Optimised path vs reference path | Seeded differential loop | `test/chat-batch.test.ts` ("seeded randomized batches equal the unoptimized reducer...") |
| Stream cursor, unreadable frames, resync | Feed frames and cursors to the transport | `test/transport.test.ts` ("an unreadable frame resyncs without advancing the cursor") |
| Incremental markdown on partial text | Partial inputs at every cut point | `test/markdown-incremental.test.ts` |

## Running

| Package | Focused run (inside the package) | Full suite |
|---|---|---|
| runtime-adapter | `npx tsx --test --test-name-pattern='<name>' test/<dir>/<file>.test.ts` | `npm test` (serial) |
| platform-next | same form | `npm test` |
| model-gateway | `npx tsx --test --test-name-pattern='<name>' test/<file>.test.ts` | `npm test` |
| frontend | `node --experimental-strip-types --test test/<file>.test.ts` | `npm test` |

Five runs in a row, for the flake check:

```bash
for i in 1 2 3 4 5; do npx tsx --test --test-name-pattern='<name>' test/<dir>/<file>.test.ts || { echo "failed on run $i"; break; }; done
```

Real-Codex tests need the pinned binary; if they fail to start, run `npm run codex:verify` at the repo root before suspecting the change.
