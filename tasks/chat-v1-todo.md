# Chat v1 implementation tasks

Plan: [chat-v1-plan.md](chat-v1-plan.md). Status: in progress (slices 1–3 first).
Implement in small batches, normally 3–5 files. Split a task further if its actual diff spans unrelated responsibilities. These tasks build the new path; they do not refactor legacy platform/agent-core.

## 1. Freeze the first-message contract

- [x] Record the confirmed text-only release boundary; settle shared-agent write permissions and initial provider support.
- [x] Define the internal adapter operations, events, errors and timeouts: [runtime-adapter/README.md](../runtime-adapter/README.md). Chat/send/stream contracts are specified with slices 6–7.
- [x] Record input limits, duplicate/conflicting IDs, one active turn, event attribution and reconnect ordering as adapter acceptance tests (`runtime-adapter/test`).

**Dependencies:** none. **Likely files:** this plan, a new chat contract document, proposed `shared/chat-runtime.ts` only when implementing. **Scope:** S/M.
**Verify:** walk first send, duplicate send, foreign chat access, stream disconnect and timeout-after-dispatch using examples. No runtime/business implementation in this slice.

## 2. Scaffold the independent runtime adapter

- [x] Create `runtime-adapter/` with its own strict TypeScript configuration, package scripts, recursive tests and documented local storage/configuration.
- [x] Validate the Codex pin/binary, internal authentication/binding, private filesystem paths and startup configuration; imports have no child-process/listener side effects.
- [x] Add bounded HTTP parsing, health, sanitized errors and graceful shutdown; no legacy runtime or platform imports.

**Dependencies:** 1. **Likely files:** package/config files, then `src/main.ts`, configuration and HTTP app in separate batches. **Scope:** M per batch.
**Verify:** startup/invalid-config/oversize-input/authentication/shutdown tests; package typecheck/build/format. Refuse caller-selected binaries, arbitrary RPC methods and workspace paths.

## 3. Prove the native Codex lifecycle

- [x] Implement the child process and newline JSON-RPC client: initialize once, correlate responses, collect notifications before dispatch, and explicitly settle unsupported server requests.
- [x] Implement one chat's start/turn/read/interrupt lifecycle with private disk state and bounded process capacity; reject overlapping turns rather than steering them implicitly.
- [x] Exercise streaming/final status and same-home resume against real pinned Codex and a loopback model fixture. No real keys or old runtime homes.

**Dependencies:** 2. **Likely files:** `runtime-adapter/src/codex/client.ts`, thread lifecycle module and native fixture/tests, in separate batches. **Scope:** M per batch.
**Verify:** same thread survives a local process restart, final output can precede the RPC response without being lost, malformed frames/exits/timeouts fail clearly, stop interrupts and child processes are cleaned up.

### Checkpoint A — engine boundary (passed 2026-10-17: 49/49 tests against the real pin)

- [x] A clean local adapter can execute and resume text turns without platform or frontend dependencies.
- [x] Native event behavior and denied capability exposure are verified, not inferred from schema presence.

## 4–5. Agents and models (decided and built 2026-10-17, ahead of the runtime slices)

Models and built-in agents are product-team data in the catalog DB; users only pick them. User agents live in the tenant DB.

| Data | Where | Written by |
| --- | --- | --- |
| `truex_models` | catalog | operator CLI `model-put/-enable/-disable` (soft delete only) |
| `builtin_agents` | catalog | operator CLI `builtin-agent-put/-enable/-disable` |
| `agents` (scope `personal` / `tenant`) | tenant DB | members through the API |

Acceptance criteria (each is a test):

- [x] Model put validates every field, refuses unknown fields, requires `contextWindow` > `autoCompactTokenLimit`, accepts only gateway `wireApi` values (`anthropic`, `gemini`, `chat`) and a Secrets Manager ARN (plaintext `apiKey` only with an explicit dev flag). Changing `wireApi`, `baseUrl` or `modelName` of an existing slug is refused. Re-running an identical put changes nothing. Every operator command is audited.
- [x] Built-in put references its model by slug, refuses a missing model, and never returns `instructions` to the browser.
- [x] `GET /models` returns only enabled models with `id, displayName, shortLabel, family`; never URLs, ARNs, keys or limits.
- [x] `GET /agents` returns enabled built-ins, the caller's personal agents and the tenant's agents, each with `source`, `available` (model enabled) and the caller's `canEdit/canArchive/canPromote`. Another member's personal agents never appear. Built-ins and models come from a 60 s in-memory cache; tenant agents are one indexed query.
- [x] `POST /agents` needs `clientRequestId`, `scope`, `name` (1–60), `description` (1–280), `modelId` (enabled, else 422 `MODEL_UNAVAILABLE`), `look` (0–11), `tint`. Replaying the same `clientRequestId` returns the same agent; a different body is 409.
- [x] Limits: 50 active agents per creator, 200 active tenant agents per tenant (409 `LIMIT_REACHED`), race-safe under concurrent creates.
- [x] `PATCH /agents/:id` needs the current `revision` (409 otherwise); only the creator edits. `POST /agents/:id/promote` turns personal into tenant (creator only, counts against the tenant limit). `POST /agents/:id/archive`: creator, or a tenant admin for tenant agents; repeating it is safe.
- [x] Another member's personal agent, another tenant's agent and malformed IDs all get the same 404.
- [x] Create, edit, promote and archive are audited in the same transaction as the change.
- [x] Frontend: the tenant chat page lists agents grouped Built-in / Personal / Workspace, marks unavailable ones, and opens a create/edit dialog with a Personal/Workspace choice (Personal default, with a warning on Workspace), share and archive actions. Verified in a browser with a mocked API.

Deferred: instructions on user agents, handles/@mentions, per-tenant model allow-lists, sharing back to personal, rate limiting.

## 6. Create a private chat with a pinned configuration

- [x] Implement idempotent chat creation with selected agent, owner and nonsecret configuration snapshot in the authorized tenant database.
- [x] Add bounded owner-only list/history reads; do not contact the runtime merely to list or view saved history.
- [x] Refuse a different agent ID on later sends and keep the first snapshot after agent edits. Store external engine IDs as opaque strings.

**Dependencies:** 4–5. **Likely files:** `platform-next/src/modules/chats/` documents, repository/service/controller and tests in separate batches. **Scope:** M per batch.
**Verify:** repeat create, conflicting identifiers, private chat access, snapshot stability and pagination; actual HTTP/Mongo integration tests.

## 7. Deliver the platform's first-message execution

- [x] Durably record one submitted message/run and atomically reserve the active-turn slot before invoking the new adapter; external execution stays outside database transaction callbacks.
- [x] Consume the runtime stream through one platform execution reader, save completed items/outcome idempotently, and release admission only at a resolved safe boundary.
- [x] Preserve unknown-delivery state after ambiguous dispatch failure; repeated IDs return their receipt and never automatically start another model turn.

**Dependencies:** 3, 6. **Likely files:** platform chat send operation, runtime transport, event persistence and focused integration tests. **Scope:** M per batch.
**Verify:** real platform/new-adapter/pinned-Codex loopback integration, fast completion, duplicate requests, concurrent sends, provider failure and Mongo outage. No legacy adapter is used as the proof.

Done 2026-10-17 (`platform-next/src/modules/chats`, `test/integration/chats.test.ts`, 17 end-to-end tests). Stop, browser disconnect, platform restart recovery, save failure and adapter shutdown from slices 9–10 were built with it, because the send path is not safe without them. Still open from 9–10: revocation tests on a live stream, an all-chats recovery sweep (recovery is on access only), and AgentCore transport (slice 11).

## 8. Connect the first user-visible chat

- [ ] Extend the existing tenant chat shell with agent selection, text composer, response items and saved conversation history.
- [ ] Use authenticated fetch streaming and the route's tenant; handle acceptance, streaming, saved, failed and interrupted states distinctly.
- [ ] Prevent double submission, isolate state by tenant/user/chat and support keyboard/mobile behavior and meaningful loading/error/empty states.

**Dependencies:** 7 and the current frontend auth integration. **Likely files:** frontend tenant chat route/components, API/stream helper and tests; separate UI and transport batches. **Scope:** M per batch.
**Verify:** browser first send and refresh against the new backend, cross-tenant/stale-response probes, frontend unit/typecheck/build checks. No tokens in URLs/localStorage or global tenant state.

### Checkpoint B — complete first-message path

- [ ] Select an agent, send text, see streamed output and reload the saved result through the actual new stack.
- [ ] Configuration stays pinned and the displayed saved state agrees with MongoDB.

## 9. Add continuation and stop

- [ ] Follow-up messages use the same live thread, agent and snapshot; local restart resumes from the complete retained home before the next turn.
- [ ] Explicit stop calls native interrupt and preserves a clear terminal outcome/partial output; it is separate from browser disconnect.
- [ ] Agent/profile disablement and current access revocation prevent new execution without exposing or erasing private saved history.

**Dependencies:** 8. **Likely files:** adapter resume/interrupt operations, platform continuation and frontend stop control with focused tests, in separate batches. **Scope:** M per batch.
**Verify:** multi-turn context in actual model requests, restart/resume, stop races, repeated stop and unreadable/missing state. Missing AWS disk must not create a silent replacement thread.

## 10. Verify disconnect and failure recovery

- [ ] Browser closure leaves the platform execution reader/persistence running; reconnect uses a consistent snapshot/live handoff or explicit history fallback without duplicate text.
- [ ] Reconcile unresolved receipts and completed items from retained runtime history after platform interruption; never blindly replay uncertain messages.
- [ ] Enforce bounded buffers/capacity, stream expiry/revocation checks, dependency timeouts and safe shutdown; report persistence failure honestly.

**Dependencies:** 9. **Likely files:** stream/reconciliation lifecycle and focused fault fixtures, split by browser and process failure. **Scope:** M per batch.
**Verify:** disconnect before first text/during text/after completion, platform crash after dispatch, lost completion response, Mongo write failure and parallel submissions. Document any unsupported recovery window instead of claiming exactly-once execution.

### Checkpoint C — usable local v1

- [ ] All included functional, authorization, concurrency and recovery criteria pass with isolated data.
- [ ] Record startup/first-text/completion timings, process memory and cleanup behavior at representative local concurrency; set capacity from evidence.
- [ ] Confirm the text-only policy exposes no MCP, skill, shell or delegation execution; deferred capabilities do not enter the release checklist.

## 11. Package the new runtime for AWS

- [ ] Add a new adapter/Codex container build with exact source/artifact checks; keep existing runtime Dockerfiles/entrypoints unchanged until intentional integration.
- [ ] Implement/verify the required AWS AgentCore health/invocation bridge and one-chat session binding; local and AWS paths call the same execution operations.
- [ ] Build the correct production architecture and test startup, streaming, interruption and shutdown in a local container with fixtures before AWS validation.

**Dependencies:** C. **Likely files:** `runtime-adapter/Dockerfile`, new AWS entrypoint, container fixtures/runbook, in separate batches. **Scope:** M per batch.
**Verify:** clean image build, binary pin/checksum/architecture, private paths, correct session affinity and rejection of foreign chat/session bindings. No deployment or paid calls implied by writing packaging code.

## 12. Validate the release and document cutover

- [ ] Validate an isolated AWS runtime and chosen real provider with authorized test credentials, including streamed output and loss-of-disk behavior.
- [ ] Run checks for the new adapter, platform-next and frontend; retain failures/skips as explicit blockers and perform final security/performance/diff review.
- [ ] Record observability, operational limits, history retention decisions, rollback and the separate product cutover procedure. No old-data adoption or destructive migration.

**Dependencies:** 11. **Likely files:** validation report and release/runbook docs. **Scope:** S/M.
**Verify:** actual staging evidence for first message/follow-up/stop/read-after-runtime-loss, healthy error/latency/resource observations, and reversible deployment rehearsal. Local fixtures alone do not certify production readiness.
