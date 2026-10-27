# AgentCore runtime tasks

Plan: [agentcore-runtime-plan.md](agentcore-runtime-plan.md). Sequential unless noted. Tasks 6 and 7 can run in parallel with Phase 2 once Task 2 fixes the envelope. No task deploys or calls a paid provider.

Commands: adapter `cd runtime-adapter && npm test && npm run typecheck && npm run build && npm run format:check`; platform-next same scripts in `platform-next/`.

## Task 1: Session ID and route allowlist

**Description:** Pure module in the adapter: `agentCoreSessionId(tenantId, chatId)` and a parser that matches an invocation `{method, path}` against exactly the adapter's 10 routes (runs, events, stop, steer, approvals, history, files, file, uploads, skills) and extracts `tenantId`/`chatId`.

**Acceptance criteria:**
- [ ] Session ID is `chat-` + sha256 hex, 69 chars, fixed test vector.
- [ ] Every adapter route is accepted with its method; unknown paths, wrong methods, `..`, encoded slashes and extra segments are rejected.

**Verification:** adapter tests, typecheck.
**Dependencies:** None.
**Files:** `runtime-adapter/src/agentcore/session.ts`, `runtime-adapter/src/agentcore/routes.ts`, `runtime-adapter/test/unit/agentcore-routes.test.ts`.
**Scope:** S.

## Task 2: Invocation forwarding and response envelope

**Description:** `POST /invocations` handler that validates the envelope, forwards to the loopback adapter with the per-boot token, decodes `bodyBase64` (uploads ≤ 20 MiB, skills ≤ 5 MB), and shapes responses: SSE and successful file reads raw, everything else `{status, body}` with HTTP 200.

**Acceptance criteria:**
- [ ] Adapter error codes (`CHAT_BUSY`, `SKILLS_MISSING`) arrive intact inside the envelope.
- [ ] Binary upload round-trips byte-exact; oversized or malformed base64 is rejected before forwarding.
- [ ] Client disconnect aborts the forwarded request; token never appears in responses or logs.

**Verification:** adapter tests against a real `createAdapterServer` with fixture Codex.
**Dependencies:** 1.
**Files:** `runtime-adapter/src/agentcore/invocations.ts`, `runtime-adapter/test/http/agentcore-invocations.test.ts`.
**Scope:** M.

## Task 3: Lifecycle, ping and session binding

**Description:** Entrypoint `src/agentcore.ts` on `0.0.0.0:8080`: lazy adapter start on first invocation (concurrent first calls start it once), `/ping` busy/idle from `/health` `activeRuns`, session-header check (fail closed), one chat per session, SIGTERM → `manager.drain()`.

**Acceptance criteria:**
- [ ] `/ping` returns `Healthy` before start and when idle, `HealthyBusy` during a run, without setting `time_of_last_update` each time.
- [ ] Request for a chat whose derived ID ≠ session header, missing header, or a second chat in the session → 403 envelope, nothing forwarded.
- [ ] SIGTERM drains active runs and exits; two simultaneous first invocations start one adapter.

**Verification:** adapter tests; manual `node dist/agentcore.js` with curl.
**Dependencies:** 2. Confirm the session header name in AWS docs first.
**Files:** `runtime-adapter/src/agentcore.ts`, `runtime-adapter/src/agentcore/lifecycle.ts`, `runtime-adapter/test/http/agentcore-lifecycle.test.ts`, `runtime-adapter/package.json` (start script).
**Scope:** M.

## Checkpoint A: bridge

- [ ] Adapter test, typecheck, build, format pass.
- [ ] Review with human.

## Task 4: ARM64 adapter image

**Description:** `runtime-adapter/Dockerfile` (linux/arm64) reusing the pinned Codex artifact from root `Dockerfile --target codex-artifact`, with checksum/version/architecture checks. Env: `RUNTIME_STATE_DIR=/mnt/state`, `RUNTIME_CODEX_BINARY=<path>`, `RUNTIME_CODING_ENABLED` unset. Non-root user, entrypoint `dist/agentcore.js`.

**Acceptance criteria:**
- [ ] Clean build fails if the Codex binary doesn't match `codex.lock.json` or isn't arm64.
- [ ] Image contains no secrets, dev dependencies or test fixtures; root `Dockerfile` unchanged.

**Verification:** `docker buildx build --platform linux/arm64 -f runtime-adapter/Dockerfile .`; inspect image file list and size.
**Dependencies:** 3.
**Files:** `runtime-adapter/Dockerfile`, `.dockerignore` (if needed).
**Scope:** S.

## Task 5: Local container smoke test and runbook

**Description:** Script that runs the image locally with a mounted state dir and fixture model, then drives start, stream, stop and shutdown through `/invocations` with a fake session header.

**Acceptance criteria:**
- [ ] Run streams to completion; stop interrupts; SIGTERM exits cleanly within the drain timeout.
- [ ] State lands only under `/mnt/state`; foreign-session request is rejected.

**Verification:** run the script; record output in the runbook.
**Dependencies:** 4.
**Files:** `runtime-adapter/scripts/agentcore-smoke.mjs`, `runtime-adapter/docs/AGENTCORE.md`.
**Scope:** S.

## Checkpoint B: container

- [ ] Image builds clean, pin verified, smoke test passes.
- [ ] Review with human.

## Task 6: AgentCore config

**Description:** `platform-next/src/config/chat-config.ts`: accept `AGENTCORE_RUNTIME_ARN` (legacy ARN pattern) as an alternative to `RUNTIME_ADAPTER_URL` + `RUNTIME_ADAPTER_TOKEN`; reject a loopback `MODEL_GATEWAY_URL` when the ARN is set.

**Acceptance criteria:**
- [ ] Exactly one transport configured; both or neither → startup error naming the variables.
- [ ] Invalid ARN and loopback gateway with ARN → clear startup error.

**Verification:** platform-next tests, typecheck.
**Dependencies:** None (parallel with Phase 2).
**Files:** `platform-next/src/config/chat-config.ts`, its test.
**Scope:** S.

## Task 7: AgentCore transport

**Description:** Split `RuntimeClient.send()` (`runtime-client.ts:299`) into HTTP and AgentCore transports. AgentCore uses `InvokeAgentRuntimeCommand` with the derived session ID, `maxAttempts: 1`, no socket timeout, unwraps the envelope. Add `@aws-sdk/client-bedrock-agentcore@3.1141.0` and a copy of the session-ID function with the same test vector.

**Acceptance criteria:**
- [ ] Throttling, `RetryableConflictException` and network errors → `AdapterUnreachable`; access-denied/validation → configuration error.
- [ ] Envelope `{status, body}` maps to the same errors the HTTP transport produces; SSE and file bytes stream unchanged.
- [ ] Session ID test vector matches Task 1.

**Verification:** platform-next tests with an injected fake `send`; typecheck; build.
**Dependencies:** 2 (envelope), 6.
**Files:** `platform-next/src/modules/chats/runtime-client.ts`, `platform-next/src/modules/chats/agentcore-transport.ts`, `platform-next/package.json`, `package-lock.json`, test.
**Scope:** M.

## Task 8: Wiring and dev script

**Description:** Choose the transport in `chats.module.ts:43` from config. In `scripts/dev-next.mjs`, skip starting the local adapter and the token-match check when the ARN is set.

**Acceptance criteria:**
- [ ] Without ARN, local dev behaves exactly as today.
- [ ] With ARN, no local adapter process starts.

**Verification:** platform-next tests; run `dev-next.mjs` both ways.
**Dependencies:** 7.
**Files:** `platform-next/src/modules/chats/chats.module.ts`, `scripts/dev-next.mjs`.
**Scope:** S.

## Task 9: Transport ↔ bridge contract test

**Description:** In-process test wiring the platform-next AgentCore transport (fake `send` that calls the Task 3 bridge with the session header) through a full chat run.

**Acceptance criteria:**
- [ ] Run, stream, stop, steer, history, file read and upload work end to end.
- [ ] Stream cut mid-run reconnects with `after=<seq>` without duplicating events; adapter errors surface with original codes.

**Verification:** platform-next and adapter suites; frontend suite unchanged.
**Dependencies:** 3, 8.
**Files:** `platform-next/test/agentcore-contract.test.ts`, test support.
**Scope:** M.

## Checkpoint C: slice 11 done

- [ ] platform-next, runtime-adapter and frontend suites pass.
- [ ] Security, performance and final diff review.
- [ ] Tick slice 11 in `chat-v1-todo.md`; human go before slice 12.
