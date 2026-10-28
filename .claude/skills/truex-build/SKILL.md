---
name: truex-build
description: Builds one task from a Truex task list (tasks/*todo.md) in the new stack, test first, then stops for approval. Use when asked to "build", "start building", "do the next task", "implement task N", or to work through a todo list in this repo. Does one task per run and never commits.
---

# Truex Build

## Overview

Build exactly one task from the task list: prove it with a test that failed first, tick it off, and stop for approval. One task per run keeps every change small enough to review and every checked box backed by a command that ran.

## When to Use

- A task list exists (`tasks/<feature>-todo.md`) and the user says build, start, next task, or names a task
- A bug fix with a reproduction already described in a task

**NOT for:**
- No task list yet: ask for one, or for a one-line task. Do not write a plan here.
- Investigating a failure with an unknown cause: find the root cause first, then build the fix as a task.
- Work in the old stack (`agent-core/`, `platform/`): stop and ask.

## The New Stack

Build only here. Each package is independent: its own `node_modules`, scripts, lockfile and tests. There are no npm workspaces.

```text
frontend (3000, tenant chat in app/t/[tenantId])
   → platform-next (4100, NestJS + MongoDB: auth, tenants, agents, chats)
   → runtime-adapter (4400, one pinned Codex app-server per chat)
   → codex app-server (vendor/codex, never modified)
   → model-gateway (4200, Responses ↔ provider APIs)
```

- `npm run dev:next` at the root runs all four; logs go to `.runtime/dev-next/<service>.log`.
- The platform-next ↔ runtime-adapter HTTP contract is in `runtime-adapter/README.md`.
- Root `npm test` and `npm run build` skip runtime-adapter and platform-next, so they are not evidence for the new stack. model-gateway and frontend have no format check of their own: run `npx prettier --check <changed files>` from the repo root. Root `npm run format:check` already fails on old-stack files and `frontend/app/chat.css`, so it is not evidence either.
- `shared/` is imported by both stacks (for example `shared/gateway-token.ts`). A change there affects the old stack too: say so in the report.

## Process

### Step 1: Find the task

1. Task list: the file the user names, else `tasks/*-todo.md`. If there are several and the user did not name one, list them and ask.
2. Task: the one the user names, else the first `## Task N` whose acceptance boxes are not all checked.
3. Check its **Dependencies**. If a dependency still has unchecked boxes, say so and stop.
4. Read the task, its section of the matching `tasks/<feature>-plan.md`, every file under **Files likely touched**, and the neighbouring tests.
5. Before any edit, state in three lines: what changes, which test proves each acceptance criterion, which files you expect to touch.

### Step 2: Red — write the failing test

- One test per acceptance criterion, placed where the neighbouring tests live (see Test Map).
- Run only the new test and watch it fail on the assertion that names the missing behaviour. A failure from a typo, import error or missing fixture is not red yet: fix the test and run it again.
- A test that passes before the change is not evidence. Either the behaviour already exists (tell the user and confirm the task is still needed) or the test checks the wrong thing.
- Only a change with no observable behaviour (comment, rename, config with no effect) may skip red. Say that you skipped it and why.

### Step 3: Green — smallest change that passes

- Change only what this task needs. Anything else you notice goes in the report under **Noticed, not touched**.
- Follow the surrounding code's patterns. No new dependency, abstraction or config option unless the task names it.
- If a pinned test (tool lists, event shapes, snapshots) must change, change it deliberately and name it in the report.
- If something fails that you did not expect, find the root cause before changing anything.

### Step 4: Verify

Run every command under the task's **Verification**, plus, in each package you touched, `npm run typecheck` and `npm test` (`npm run build` too for `frontend`). Run them inside the package (`npm --prefix <package> ...`). Report the pass/fail counts each command printed. If the task reached a `## Checkpoint`, run that checkpoint too.

### Step 5: Tick and stop

- Check a box only when a command you ran in this session shows it is met. Leave a partly met box unchecked with a short note under it.
- Stop after one task. Do not start the next task, commit, push or open a PR unless the user asks.

```text
Task N: <title>
Tests added: <file>: <test names>, each seen failing, then passing
Changed: <files>
Verification: <command>: <pass>/<total>, ... (or what failed, with the output)
Boxes ticked: <n>/<total>; unchecked: <which, why>
Noticed, not touched: <items or "none">
Next: Task M (needs your OK)
```

## Test Map

| Package | Full suite | Focused run (inside the package) | Format |
|---|---|---|---|
| `runtime-adapter` | `npm test` (serial) | `npx tsx --test --test-name-pattern='<name>' test/<dir>/<file>.test.ts` | `npm run format:check` |
| `platform-next` | `npm test` | same form | `npm run format:check` |
| `model-gateway` | `npm test` | `npx tsx --test --test-name-pattern='<name>' test/<file>.test.ts` | `npx prettier --check <changed files>` (from root) |
| `frontend` | `npm test` | `node --experimental-strip-types --test test/<file>.test.ts` | `npx prettier --check <changed files>` (from root) |

Where a test goes:

| Behaviour | Test kind | Support code |
|---|---|---|
| Pure parsing, bounding, mapping | Unit: `runtime-adapter/test/unit`, `platform-next/test/unit` | none |
| Anything Codex does (tools offered, events, resume, steer, stop) | Real Codex: `runtime-adapter/test/codex` | `Harness` in `test/support/harness.ts`. Script the model with `h.model.script.push({ kind: "call" \| "reply" \| "status" \| "failed" \| "hangAfterCreated" ... })`, or `h.model.router` when a lead and helpers share the fixture. Inspect `h.model.lastRequest().body`, read events with `completed()` / `streamedText()`, restart with `h.restart()` |
| MCP tools | Real Codex + `test/support/mcp-fixture.ts` | `Harness({ allowLoopbackMcp: true })`, `deadMcpUrl()` |
| Coding profile, network proxy | Real Codex | `Harness({ coding: true, networkEnv })`, `network-fixture.ts` |
| Adapter HTTP surface | `runtime-adapter/test/http` | `Harness` |
| Platform API, sessions, tenants, Mongo | `platform-next/test/http`, `platform-next/test/integration` | `startReplicaSet()` / `startApp()` in `test/support/test-app.ts` (mongodb-memory-server), `resetOwnedData()` in `test/support/reset.ts` |
| Platform + adapter streaming end to end | `platform-next/test/integration` | `FakeGateway`, `AdapterProcess`, `readStream()` in `test/support/chat-stack.ts` |
| Provider translation, gateway tokens | `model-gateway/test` | `createGateway()`, `signGatewayToken()` from `shared/gateway-token` |
| Frontend logic (state, API client, batching) | `frontend/test` | `auth-fixture.ts` |

Real-Codex tests need the pinned binary. If they fail to start, run `npm run codex:verify` at the root before suspecting your change.

Real-model tests (`*-real.test.ts`) read `REAL_GATEWAY_URL`, `REAL_GATEWAY_SECRET`, `REAL_MODEL_ID` and related variables, and skip without them. They cost money: run them only when the user asks. They report what the model did; they do not assert on model choices. Build-time tests use the scripted fixture.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll do the next task too, it's small" | Two tasks in one run means two changes in one review. Stop and report. |
| "Root `npm test` passed" | It skips runtime-adapter and platform-next. Run each touched package's own suite. |
| "The test passed first time, good" | A test that never failed proves nothing. Make it fail for the right reason first. |
| "The flaky test passed on the second run" | An intermittent failure is a failure. Find the cause. |
| "Waiting 500 ms is enough for the event" | Wait for the event, SSE frame or state change itself. The model fixture's `delayMs` simulating a slow model is fine. |
| "The box is basically met" | Tick it only when a command you ran shows it. |
| "I'll commit so the work is safe" | Commit only when the user asks. |

## Red Flags

- `test.skip`, `test.only`, `todo` or a commented-out test
- An assertion weakened (`deepEqual` to `ok`, an exact value to "is defined") or an expected value edited to match buggy output
- `try/catch` in a test that hides a failure
- A fixed `sleep` used to wait for an event
- The module under test mocked
- A file in `agent-core/`, `platform/` or `vendor/codex/` changed
- Files changed that are not in the plan and not explained in the report
- `--no-verify`, or a commit the user did not ask for

## Verification

- [ ] Exactly one task was built
- [ ] Every acceptance criterion has a test that was seen failing, then passing
- [ ] Each touched package's `typecheck` and `npm test` ran, with counts reported
- [ ] Every ticked box is backed by a command run in this session
- [ ] No old-stack or `vendor/codex` files changed
- [ ] Nothing committed or pushed
