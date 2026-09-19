# agent-core — Implementation Plan and Checklist

Status: application implemented and running locally; production acceptance remains open. See [validation evidence](docs/VALIDATION.md) and [setup](README.md).

User updates: Codex is pinned and built inside `vendor/codex`; no global/sibling runtime is used. Configuration is user-managed in `truex.truex_agents`, `truex.truex_models` and `truex.truex_mcp`. Provider keys live only in MongoDB. Production seeding has been removed.

This plan turns the supplied production implementation draft into an executable sequence. Protocol names and runtime behavior inherited from that draft are provisional until Phase 0 verifies them against the pinned Codex checkout. Check a task only when its deliverable and evidence exist.

## 1. Outcome and scope

Deliver the full verified Codex app-server capability surface through a TypeScript application: select an agent, create a session, converse and steer, stream output, answer runtime requests, inspect timings, and recover sessions after a restart.

| Component | Responsibility | Default port |
|---|---|---|
| `frontend/` | Next.js, Tailwind, shadcn/ui; picker, chat, requests, events, timings | 3000 |
| `platform/` | NestJS; MongoDB persistence, session routing, public API, SSE relay | 4000 |
| `agent-core/` | Express; Codex child process, protocol adapter, threads, turn coordination | 4100 |
| `shared/` | Shared TypeScript contracts imported by relative path | — |

Each application installs and builds independently. No workspace tooling or shared package publishing is required. Verify that each application's compiler and deployment build include relative imports from `shared/`.

Keep these decisions: TypeScript adapter; official MongoDB driver; SSE output with POST commands; one Codex child process serving multiple threads; direct routing through the session's `agentCoreHost`; StatefulSet, headless Service and per-pod `CODEX_HOME` storage; lazy same-pod resume.

Out of scope: authentication, multi-tenancy, message brokers, WebSockets, cross-pod migration, an agent administration UI, state-machine frameworks, an ORM, and a metrics/tracing platform. Deployment must reflect the intentionally unauthenticated scope rather than implying a public production service.

## 2. Rules that apply to every phase

- Read the verified protocol inventory; do not guess methods, fields, error shapes, or capabilities.
- Pin the Codex revision and record its protocol generation command. Generated types improve compatibility checks but do not prove runtime behavior.
- Platform owns sessions; agent-core is authoritative for thread and turn state. Platform must not decide start versus steer from a stale state read.
- Serialize state-changing commands per thread, including the period while `turn/start` is awaiting acknowledgment. An enum check alone does not prevent two concurrent starts.
- Accept a message during a running turn as a steer. Define behavior during starting, interrupting and recovery explicitly.
- POST responses acknowledge commands or return identifiers; model output arrives over SSE. Apply finite RPC deadlines and report failures clearly.
- Every domain event has a type, timestamp, cursor and applicable session/thread/turn/item identifiers. Multiple output items must never share a bubble merely because they belong to one turn.
- Use environment configuration with documented defaults; never hardcode deployment URLs in application logic. Disable compression and proxy buffering on SSE routes.
- Keep provider credentials in model profiles as requested, exclude them from browser responses and logs, and verify the per-thread credential configuration path before adopting it.
- Use bounded buffers and explicit cleanup for threads, subscribers, pending RPCs and runtime requests.
- Persist user messages and authoritative final messages, not token deltas. Persistence must continue when no browser is subscribed.
- An in-memory replay buffer provides limited reconnect recovery, not durable event storage. Define a snapshot/resync path for evicted events and process restarts.
- Implementation is authorized; checkboxes track completed deliverables, while phase exit gates require their stated verification.

## 3. Delivery order

`0 → 1 → 2 → 3 → 4a → 4b → 5 → 6 → 7 → release gate`

| Milestone | Phases | Reviewable outcome |
|---|---|---|
| M1: verified foundation | 0–2 | Protocol inventory, working handshake and Mongo-backed agent picker |
| M2: live conversation | 3–4a | Complete basic chat flow, real streaming, steering and interruption |
| M3: runtime interaction | 4b–5 | Runtime requests answered safely; measured per-turn timings |
| M4: recoverable sessions | 6 | Persistent runtime storage, restart recovery and transcript reload |
| M5: full surface | 7 and release gate | Every inventoried capability accounted for and validated |

Do not estimate dates or process capacity until Phase 0 resolves compatibility and Phase 5 measures load. Record an owner, target date, evidence link and open blockers at each milestone review.

## 4. Phase checklist

### Phase 0 — Verify the protocol and assumptions

Deliverables: `docs/protocol.md`, generated protocol types where supported, a capability coverage table, and documented verification evidence. No application implementation.

- [x] Fetch Codex into `vendor/codex`, pin its revision and build the binary within this project.
- [x] Find the supported schema/TypeScript generator; provide a reproducible `npm run protocol:gen` command if available. Clearly label any manual transcription.
- [x] Inventory all client requests, server notifications and server requests, including capabilities outside `thread/*` and `turn/*` if present. Record params, results, errors, experimental flags and basic versus additive status.
- [ ] For every server request, record identifier type, thread attribution, valid response variants, timeout behavior and safe failure response. Do not treat all server requests as Boolean approvals.
- [x] Verify initialization order, framing, omission of `jsonrpc`, and actual handshake response fields. Do not invent a `protocolVersion` field if none exists.
- [x] Verify per-thread provider credentials, MCP configuration and isolation between two simultaneous profiles.
- [ ] Verify persistence files and resume semantics under `CODEX_HOME`, including interrupted turns, filesystem/workspace dependencies and missing-thread errors.
- [ ] Verify whether an active turn can emit notifications before the start response and how steering/interrupt races are reported.
- [x] Create a coverage row for every method and request variant: required handler/API/UI, phase, status and evidence.

Exit gate: the inventory is complete against the pinned source, unresolved assumptions are explicit, and no later phase depends on an unverified protocol shape.

### Phase 1 — Repository and end-to-end health

Deliverables: independently buildable applications, shared contracts, environment examples, root README and local run scripts.

- [x] Create `frontend/`, `platform/`, `agent-core/` and `shared/`; configure TypeScript imports and exclude dependencies, build output and secrets from Git.
- [x] Implement an idempotent, concurrent-safe Codex startup and the verified initialization handshake.
- [x] Parse newline-delimited messages across partial reads; distinguish responses, server requests and notifications; correlate outgoing requests by ID.
- [x] Add RPC timeouts, child-exit cleanup, spawn errors and stderr handling that does not expose credentials.
- [x] Until full runtime-request support lands, report unsupported requests and send a protocol-valid failure response instead of leaving them pending indefinitely.
- [x] Add agent-core health with actual runtime identity, startup timing, storage path and writable status; return readable 503 errors.
- [x] Add MongoDB connectivity and platform chain health; configure frontend CORS and environment-driven addresses.
- [x] Build a diagnostic frontend showing individual dependency status and useful failure messages.
- [x] Use the user-managed `truex_agents`, `truex_models` and `truex_mcp` collections; remove production seeds and provider credentials from `.env`.
- [x] Add a run script that detects occupied ports, lets each service load its own environment, and cleans up its child processes on exit.

Exit gate: independent builds pass, the browser shows the full healthy chain, and a missing binary or unavailable MongoDB produces an attributable error without crashing the other services.

### Phase 2 — Agents API and picker

- [x] Define `Agent`, `ModelProfile` and `AgentSummary` contracts.
- [x] Read agents and model profiles per request; use appropriate projections and joins without boot-time caching.
- [x] Implement `GET /api/agents` returning `{ id, name, description, provider, model, sandbox }`.
- [x] Return visible `unknown` provider/model labels for missing profile references; reject invalid configuration when creating a session.
- [x] Exclude credentials from public queries and responses.
- [x] Build the selector with loading, empty, unavailable and selected-agent description states.

Exit gate: user-managed agents display correctly, missing references remain visible, and API responses contain no provider credentials.

### Phase 3 — Chat against a mock transport

- [ ] Define `shared/events.ts` with session/thread/turn events, message deltas and finals, reasoning, item lifecycle, MCP status, runtime requests, plan, diff and errors.
- [x] Include correlation IDs and a cursor contract that can distinguish process generations; define snapshot and replay-gap behavior before implementing SSE.
- [x] Create a narrow transport interface for sending, subscribing, interrupting and answering requests so the real transport can replace the mock.
- [x] Render messages by turn/item identity; append deltas and replace each message with its authoritative final value without duplication.
- [x] Implement thinking text, streaming cursor, errors, stop control, Enter-to-send, Shift+Enter, and visible mid-turn steering.
- [x] Add autoscroll that stops following when the user scrolls up.
- [ ] Build runtime-request cards with supported inputs, server deadlines and distinct user-denied versus expired outcomes.
- [x] Render plan updates and diffs according to verified snapshot/delta semantics; include an event inspection panel.
- [ ] Build mock scenarios for normal output, multiple assistant items, steering, interruption, errors, request acceptance, denial and expiry.

Exit gate: all mock scenarios behave correctly and switching transport requires no rewrite of the chat components. The server remains authoritative for actual request expiry.

### Phase 4a — Sessions, real turns and SSE

Agent-core:

- [x] Implement verified notification mappings in one method registry; track unexpected methods separately from known unsupported capabilities.
- [x] Route events by thread and correlate turn/item IDs, including events received before RPC acknowledgment.
- [x] Serialize commands per thread; cover Idle, Starting, Running, Interrupting and recovery transitions as needed. Only a completion matching the active turn may clear it.
- [x] Define deterministic behavior for repeated interrupt, messages during interruption, failed starts and stale turn notifications.
- [x] Add thread create, message/start-or-steer, explicit steer, interrupt, events and delete endpoints with validated inputs.
- [x] Apply verified per-thread provider/MCP configuration; keep approval policy `never` for this phase.
- [x] Add configurable admission limits, explicit capacity accounting and release on deletion/failure. Capacity rejection is distinct from runtime unavailability.
- [x] Implement bounded replay and subscriber buffers, SSE event IDs, heartbeats, disconnect cleanup and slow-subscriber eviction.
- [x] For cursors outside retained history or from a prior runtime generation, signal resync instead of silently returning an incomplete stream.

Platform and frontend:

- [x] Define MongoDB document contracts and indexes for truex_agents, truex_models, truex_mcp, sessions and messages.
- [x] Store the owning `agentCoreHost`, thread ID, workspace and session lifecycle status. Validate the stored destination against configured internal hosts.
- [x] Define pod discovery and selection for new sessions. Try a different pod only after an explicit capacity rejection before creation; do not blindly retry ambiguous creates or existing-session commands.
- [x] Add session create/read, message, interrupt and SSE routes, preserving meaningful upstream status codes.
- [x] Persist user-message acceptance status and final assistant messages idempotently using stable identifiers.
- [x] Keep final-message ingestion independent of browser subscriptions; handle repeated delivery and failed writes explicitly.
- [x] Relay SSE without compression/buffering; propagate disconnects, backpressure and reconnect cursors at both service boundaries.
- [x] Use native `Last-Event-ID` for automatic reconnects; explicitly retain/pass a cursor or fetch a snapshot after a page reload. A new EventSource does not inherit the closed tab's cursor.
- [x] Replace the mock transport, show session/thread IDs, and reconcile optimistic user messages with command outcomes.
- [x] Treat temporary owner unavailability as recoverable/orphaned; reserve dead for confirmed unrecoverable sessions, with actual resume implemented in Phase 6.

Exit gate: real streaming, simultaneous-message serialization, steer and interrupt pass; reconnect either replays completely or signals resync; slow clients cannot grow memory without bound; messages contain no deltas; a disconnected browser does not stop final-message persistence.

### Phase 4b — Runtime requests and approval decisions

- [x] Implement a typed handler for every server-request variant in the Phase 0 inventory, including non-approval requests.
- [x] Track pending requests by runtime generation, thread and request ID; attach deadlines and protocol-valid timeout responses.
- [x] Add answer routes in agent-core and platform; validate answers against the request kind and route to the owner.
- [x] Ensure timeout versus user-response races resolve exactly once; define duplicate, stale and already-resolved response behavior.
- [x] Expose pending requests in a current-state snapshot independent of replay-buffer retention.
- [x] Read approval policy from the agent document; wire real UI responses and server-authoritative outcomes.
- [x] Persist user decisions, automatic expiries, resolution outcome and timestamps for audit. Without authentication, do not claim a verified human identity.
- [x] Clean up pending requests when a turn completes, a thread closes or the runtime exits; surface the outcome to clients.

Exit gate: each request variant has a validated handler; acceptance, denial, expiry, reload and duplicate-answer cases do not wedge a turn. Audit history includes automated resolutions.

### Phase 5 — Timings and capacity evidence

- [x] Use monotonic clocks for spans and wall-clock timestamps only for event display.
- [ ] Record process startup, initialization, thread start, turn acceptance, first/last visible output, completion, handler execution, delta count/rate and maximum inter-delta gap.
- [ ] Define no-output, non-streaming, interrupted, failed and steered-turn measurements explicitly. First final output is the output time when there are no deltas.
- [x] Define `ttftMs` from start dispatch to first visible output; it already includes acceptance latency. Display `acceptMs` separately rather than adding it again to TTFT.
- [x] Use non-overlapping chart segments: pre-output + streaming + finalization = total, with absent segments labelled appropriately.
- [ ] Measure platform spans locally; subtract only matching nested durations and label the remainder as platform/transport overhead, not pure platform CPU time.
- [x] Persist completed-turn metrics and expose the timings endpoint, per-turn rows and clearly defined session averages.
- [ ] Load-test concurrent threads while measuring TTFT distribution, parent/child RSS, event-loop delay and slow-client behavior. Use results to set admission limits and pod resources.

Exit gate: streamed and non-streamed timing rows are internally consistent, and capacity recommendations cite measured results rather than assumed latency ranges.

### Phase 6 — Persistent deployment and restart recovery

- [ ] Add container builds and StatefulSet/headless Service manifests with a per-pod PVC for `CODEX_HOME`; deploy platform as a stateless Deployment.
- [ ] Identify and persist any workspace files required in addition to runtime state. Stable DNS alone does not preserve conversation files or in-flight turns.
- [x] Separate liveness from readiness, configure graceful shutdown and stop admission while draining.
- [x] On an unloaded thread, serialize lazy resume before accepting a turn; avoid duplicate resume and restore required configuration.
- [x] Distinguish transient pod/storage errors from a confirmed missing or unrecoverable thread. Apply bounded recovery attempts and clear user-visible status.
- [x] Implement active → orphaned → active recovery and orphaned → dead only on confirmed permanent failure.
- [x] Add the verified runtime history endpoint; serve persisted messages on cold open and reconcile runtime items idempotently.
- [ ] Implement snapshot-plus-stream handoff with a cursor/watermark so loading history neither loses nor duplicates concurrent events.
- [x] Reset or version event cursors across process restarts and reconcile interrupted turns and obsolete runtime requests.
- [ ] Validate recovery on the same stable pod identity with retained storage; validate lost-storage behavior in a disposable test environment.

Exit gate: after an agent-core restart, the next message retains prior context, cold open restores history, and confirmed storage loss produces a clear terminal status. This does not promise continuation of an in-flight turn unless Phase 0 verifies that behavior.

### Phase 7 — Complete the capability surface

Use the Phase 0 coverage table as the source of truth. The following groups are provisional until inventory verification.

- [ ] Plans, diffs, settings changes and moderation signals.
- [ ] Compaction and its progress/completion lifecycle.
- [ ] Forking, including creation of a new platform session, ownership mapping and transcript semantics.
- [ ] Attachments: lifecycle methods are absent from this pinned protocol; choose a supported input/workspace workflow before implementing a new attachment API.
- [x] Goals and their lifecycle.
- [ ] Archive/delete, including runtime behavior, platform metadata, retained transcripts and active-operation handling.
- [x] Background terminal listing and termination.
- [x] Distinct rendering for command execution, file changes, MCP calls, reasoning and all other inventoried item kinds.
- [ ] Every additional method or server request discovered in Phase 0, including any outside the original thread/turn list.
- [ ] For each capability, document its command/API, event mapping, state/persistence effects, UI, error handling and evidence. Split substantial changes into focused implementation tasks.

Exit gate: every supported capability at the pinned revision has a completed coverage row. Experimental or unavailable capabilities have explicit visibility rules; nothing is silently omitted. Forking and lifecycle operations are not assumed to be render-only changes.

## 5. Release acceptance checklist

These checks validate the agreed deployment scope; they do not expand it to authentication or cross-pod failover.

- [ ] Each application installs and builds independently from a clean checkout; setup, configuration, MongoDB document setup and protocol regeneration are documented.
- [ ] A real-runtime scenario covers selection, session creation, output, steering, interruption, approval, history and same-pod recovery.
- [x] Concurrent POSTs cannot start overlapping turns; stale completions cannot reset a newer turn.
- [ ] Browser disconnect/reload, replay overflow and runtime restart produce complete recovery or an explicit resync path.
- [x] Final messages and decisions persist without a connected browser; replay/reconciliation does not duplicate records.
- [ ] Request expiry, response races, child exit and failed persistence do not leave silent indefinite waits.
- [ ] Slow subscribers and admission limits keep memory bounded; measured capacity supports configured resources.
- [x] No provider keys appear in browser payloads, public diagnostics or logs.
- [ ] Session routing stays on the recorded owner; temporary failure does not reroute existing threads to unrelated pods.
- [ ] Actual deployment proxy settings preserve streaming and heartbeat behavior.
- [ ] The pinned protocol coverage table is complete; unexpected-method counters are zero during the full capability exercise.
- [ ] Deployment, graceful shutdown, rollback compatibility and storage backup/restore procedures are documented and exercised where applicable.
- [ ] All milestone evidence links and remaining limitations are recorded before release review.

## 6. Execution and tracking

For each phase, use this task brief:

> Read Sections 1–2, the verified protocol inventory and the selected phase. Implement only that phase's deliverables and any explicit prerequisites. Run the applicable checks, record commands and results, link changed files, and update checkboxes only for completed work. State unresolved blockers and protocol deviations. Do not infer verified runtime support from mocks alone.

| Milestone | Owner | Target | Status | Evidence / blockers |
|---|---|---|---|---|
| M1 | Codex | 2026-09-19 | Implemented; verified locally | Pinned local build, generated protocol, live MongoDB picker |
| M2 | Codex | 2026-09-19 | Implemented; integration tested | Streaming, concurrency, interruption guards and persistence tests |
| M3 | Codex | 2026-09-19 | Implemented; partial runtime coverage | Real command-approval denial verified; full variant/load matrix remains |
| M4 | Codex | 2026-09-19 | Local restart verified | HTTP recovery passes; cluster/PVC validation remains |
| M5 | Codex | TBD | Acceptance incomplete | Full protocol console available; full capability/deployment matrix pending |

Record changes to architecture decisions alongside their evidence. Keep this checklist and the capability coverage table current as implementation proceeds.
