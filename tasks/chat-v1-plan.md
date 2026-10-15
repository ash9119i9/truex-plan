# Plan: Chat v1 and the new runtime adapter

Date: 2026-10-16. Status: proposed implementation plan; no chat or adapter implementation is started by this document.
Tasks: [chat-v1-todo.md](chat-v1-todo.md).

## Confirmed product decisions

- One chat/thread belongs to one selected agent for its lifetime. It supports many messages and tasks.
- The user selects the agent when starting the chat. Later messages use the saved selection. Using another agent opens another chat; tags do not switch an existing thread in v1.
- Pin the agent's nonsecret execution configuration at chat creation. Agent edits affect new chats. Current access checks, credential rotation and enforced security policy still apply.
- Agents can be personal or shared within the selected tenant. A shared agent does not make its users' chats shared; chats remain owner-only, including against tenant admins.
- Build a new `runtime-adapter/` package around the project-pinned `vendor/codex`. Do not import implementation from legacy `agent-core/` or `platform/`.
- Extend `platform-next/` and the existing frontend. Reuse the new identity/tenant foundation rather than rebuilding authentication.
- Local execution keeps the full Codex home and workspace on local disk. Production packages the new adapter and pinned Codex together for AWS AgentCore Runtime.
- Recovery after loss of the AWS runtime's ephemeral disk is deferred. Saved MongoDB history remains readable; a lost Codex thread is explicitly unavailable for further execution.

The final one-agent-per-chat decision supersedes the routing and agent-switching ideas explored earlier in the conversation. Those are not tasks for this release.

## Release scope and assumptions

Confirmed release scope: text input, agent purpose/system prompt, platform instructions, selected model configuration, streamed assistant text and MongoDB history. MCP tools and skills are explicitly deferred until after v1.

No attachments, background goals, helper agents, automatic routing, agent switching, collaboration, arbitrary raw Codex RPC, artifact system, provider gateway rewrite or portable runtime checkpoints are included. Do not build placeholders for deferred features. References to future MCP/skill settings do not imply their tools are executable in the first slice.

Model-provider settings remain separate from agents. Start with a deliberately supported provider/model integration against the pin; do not promise compatibility with arbitrary providers. Minimal administration/creation paths for the agent and model configuration are required; a broad management console is not.

## Existing foundation and Codex evidence

`platform-next` already contains users, tenants, memberships, JWT/refresh sessions, Google sign-in and authenticated tenant guards. These are implemented boundaries to consume, with tests to rerun before integration; an older plan's status text is not the current completion record. Tenant requests use exactly one `tenantId` query parameter, validated ObjectId strings, and server-controlled tenant DB resolution.

Codex pin: `1ef30bcbe784f1006548adc1542985be32b05109`. Use generated protocol types/schema from the same pin. Relevant vendor sources:

- `vendor/codex/codex-rs/app-server/README.md`: initialization, threads, turns, streamed events and server requests.
- `vendor/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`: start/resume/read contracts.
- `vendor/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`: message input and turn lifecycle.
- [Upgrade verification](../verification-reports/codex-upgrade-2026-10-16.md): direct real-engine fixture results and instruction/resume caveats.

The direct fixture demonstrated same-disk history continuity and streamed output. It did not validate a real provider's reasoning, production latency, automatic routing, or a production AWS deployment. Switching was experimentally possible but is intentionally excluded from this simpler v1.

## Ownership

| Component           | Owns                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend            | Agent selection, message composer, streaming display, history, stop and recovery states                                                                    |
| Platform-next       | User/tenant/agent authorization, provider resolution, snapshots, chats/messages/runs, runtime transport and MongoDB persistence                            |
| New runtime adapter | Validated internal execution API, per-chat Codex lifecycle, thread mapping, bounded admission, safe event translation and explicit server-request handling |
| Codex               | Model requests, native execution context and canonical thread history on disk                                                                              |
| MongoDB             | Product history and execution receipts; not a replacement for canonical Codex disk state                                                                   |

The adapter has no MongoDB connection, browser authentication, agent catalog lookup, business routing, background ingestion fleet or generic service facade. The platform does not duplicate Codex's model/tool execution loop. Platform and adapter communicate over a small internal contract; the browser never reaches Codex directly.

## First-message lifecycle

1. User chooses an authorized agent and enters text.
2. Platform validates identity/tenant access, resolves the agent and model profile, and creates an owner-only chat with an immutable nonsecret snapshot. The create operation is idempotent. Opening a blank chat need not launch Codex.
3. Platform durably records the user message/execution receipt and reserves the chat's active-turn slot before dispatch. Runtime/network operations occur outside MongoDB transaction callbacks.
4. Adapter binds the operation to the authenticated internal tenant/chat identity, prepares its private home/workspace, starts the pinned `codex app-server --listen stdio://`, and performs `initialize` followed by `initialized` once for the connection.
5. Adapter attaches event capture before execution, calls `thread/start` using the resolved configuration, records the returned thread mapping, then calls `turn/start` with text and `clientUserMessageId`.
6. The immediate turn response is acceptance with a turn ID. It is not the completed answer. Stream the allowlisted item/text/status events through the platform to the frontend.
7. Platform persists completed assistant items and the final turn outcome before reporting that output as saved. `turn/completed` may be completed, failed or interrupted. A turn can contain multiple assistant items.

For follow-ups, verify current access and use `turn/start` on the same live thread. After a local Codex restart, resume the same thread ID from the same private disk state using the saved configuration, then start the turn. Do not reinitialize per message or create a fresh thread for every turn.

## Configuration and runtime isolation

Proposed starting point: one Codex process/private home per loaded chat, with a bounded configurable process capacity. Local homes are keyed by server-validated tenant/chat identifiers. In AWS, bind one runtime session to one product chat. Measure resource usage before choosing production capacity or introducing process sharing.

Pin agent purpose/prompt, model selection, nonsecret provider settings and instruction-version identifiers. Resolve credentials through current authorized secret references; do not store secret-bearing runtime configuration in snapshots or return it to the browser. Agent IDs and provider-profile IDs are application identifiers, not Codex-native lookup keys.

Keep platform developer instructions fixed for the thread and compose the selected agent's instructions through the verified base-instruction path. Apply supported capabilities explicitly and test the resulting tool exposure against the pin. In the text-only slice, disable unneeded shell, connector, delegation and other execution capabilities. Unsupported server requests must receive a valid refusal/unavailable result promptly instead of hanging or granting permission.

Preserve the full private home and workspace needed for resume, including Codex-managed databases/history. Never replay real old conversation storage into upgrade fixtures. Do not modify the vendor engine to implement product features.

## Minimal product persistence and boundaries

Use the selected tenant database for proposed collections `agents`, `model_profiles`, `chats`, `messages` and `runs`. A collection/repository is added only with its implementing slice. Internal record references use ObjectIds; external Codex thread/turn/item IDs remain opaque strings.

- Chat: owner, agent reference, pinned configuration, runtime binding and active-run reference. Runtime availability is separate from saved-history availability.
- Message: chat, role, text, order and stable client/runtime identity. Enforce uniqueness for submitted client IDs and completed runtime items.
- Run: request identity, accepted configuration version, dispatch/turn association, outcome and sanitized error. A timeout after dispatch is an uncertain delivery state, not evidence of rejection.
- Agent/profile: validated metadata, scope and permissions; credential references are separate from the immutable snapshot.

Retries with the same client message ID return the same receipt/status. The same ID with different content is a conflict. Do not assume Codex's message-correlation field guarantees exactly-once execution. Concurrent starts use a database-backed atomic active-run reservation; one runs and the other receives a clear busy response. Multi-replica runtime ownership/takeover is deferred; v1 starts with one platform execution owner and does not fail over an uncertain turn.

The initial internal adapter contract only needs thread preparation/resume, turn execution/events, history/status read and interrupt. Define typed schemas/statuses before implementing these operations. Validate both sides; do not forward arbitrary browser objects or expose a generic raw-RPC proxy.

## Streaming, persistence and failure behavior

- Use authenticated `fetch` streaming for the browser, supporting the existing in-memory bearer-token design. Native `EventSource` cannot attach its Authorization header. Tokens never enter URLs.
- One platform execution reader consumes a runtime turn regardless of browser subscriptions. Closing a browser stream does not cancel generation or stop persistence. Stop is a separate explicit operation.
- Establish snapshot/subscription ordering before dispatch and on reconnect so fast output cannot fall between them. Define the bounded live buffer and history fallback in the contract; do not promise indefinite replay of every token.
- Save completed items and outcomes idempotently. No per-token MongoDB write is required. Reconstruct/reconcile saved runtime items through the adapter's history read when disk/runtime state remains available.
- A MongoDB failure must not produce a false saved/success state. Keep the turn unresolved for reconciliation and refuse further execution when required persistence cannot be established. The initial recovery path uses Codex history, not a new adapter outbox/acknowledgement protocol.
- A lost platform/runtime response may mean work ran. Read/reconcile before any retry; never automatically resend an uncertain operation. Persisted user messages alone are not permission to replay them after a restart.
- Interrupted generation can retain partial text, clearly marked interrupted. Process crashes and unsupported/failed provider requests produce actionable errors and settle or reconcile the active-run slot.
- Expired/revoked sessions and removed memberships close streams after bounded revalidation and prevent future execution. An authorized history read does not restart a runtime as a side effect.
- If the AWS ephemeral disk is gone, preserve saved MongoDB history and show that the conversation cannot continue. Never silently create a different thread or reconstruct canonical engine history from visible messages.

No broker, distributed workflow engine, full event store, all-chat polling loop or automatic owner takeover is needed for this initial deployment. Add a stronger recovery mechanism only when a documented release requirement demands it.

## Build order and checkpoints

1. Freeze the narrow contracts and release boundary; establish isolated native-runtime fixtures.
2. Create the standalone adapter and prove native initialize/start/turn/stream/stop with a local model fixture.
3. Add minimal provider/agent configuration and private chat creation in platform-next; integrate one complete first-message path.
4. Connect the existing frontend to authenticated streaming and saved history. This is the first user-visible checkpoint.
5. Add follow-ups, local restart/resume, explicit interruption, idempotency, reconnect and important failure tests.
6. Package the new adapter plus pinned Codex, verify container parity and then validate an isolated AWS runtime session. Do not switch the old product's traffic as part of packaging.

Detailed tasks and pass/fail criteria live in [chat-v1-todo.md](chat-v1-todo.md). Complete each slice before adding unrelated capabilities. MCP and skill execution are later capabilities layered onto this same foundation, outside the v1 release checklist.

## Verification and operational limits

Use Node built-in tests/tsx, real pinned Codex with loopback model fixtures, isolated MongoDB replica-set tests, actual HTTP handlers and browser checks. Fake model responses prove protocol behavior, not routing intelligence or model quality. Before release, exercise the chosen real provider and the real AWS deployment in an authorized isolated environment.

Existing commands:

```sh
npm run codex:verify
npm --prefix platform-next run typecheck
npm --prefix platform-next test
npm --prefix platform-next run build
npm --prefix platform-next run format:check
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm run check:secrets
```

Planned commands, available only after adapter scaffolding:

```sh
npm --prefix runtime-adapter run typecheck
npm --prefix runtime-adapter test
npm --prefix runtime-adapter run build
npm --prefix runtime-adapter run format:check
```

Record failures/skips separately. Do not treat the old aggregate root commands as verification of the new package until root integration intentionally adds it. The prior Codex upgrade report records baseline legacy platform, frontend and formatting failures; reassess them rather than suppressing checks.

Measure time to accepted request, first text and completion; process startup/resume time; peak memory/process count; persistence lag; and stream cleanup. Set production capacity/latency limits from representative measurements rather than claiming scalability. Logs carry request/chat/run identifiers and sanitized failure categories, never secrets or full prompt content by default.

The old application and storage remain available until a separate reviewed cutover. A new deployment must not automatically adopt old databases, old runtime homes or old provider credentials. Image rollback must account for writes made by a newer engine; never test backward compatibility using a user's only runtime home.

## Decisions to settle before their implementation slice

1. Who can create/edit tenant-shared agents and who maintains model profiles. Personal agents remain owner-managed; shared-agent write authority must be explicit before exposing CRUD.
2. The first production provider/model and its credential-management path. No new live credentials or paid requests are needed for planning or the loopback prototype.
3. Retention/erasure and production resource/timeout limits before public launch. Existing product history remains private irrespective of agent scope.

These are draft implementation decisions, not permission requests to modify the old application. This planning task changes documentation only.
