---
name: truex-harden
description: Attacks a built change in the Truex new stack to find the edge cases and failure modes its tests miss, writes the tests you approve, and proves those tests catch bugs by mutating the code. Use after a feature or task is built, or when asked to "harden", "find edge cases", "what can break", "attack this", "stress-test", or "are these tests strong enough". Lists risks and proposed tests first and waits for approval before writing any. Not for trust-boundary abuse (tenant isolation, tokens, prompt injection).
---

# Truex Harden

## Overview

Tests written by the author of the code check what the author thought of. Hardening finds what they did not: the inputs, orderings, failures and model behaviours that break the change. It works from rules the change must obey, written before reading the implementation, so the tests check intended behaviour rather than whatever the code happens to do. It then breaks the code on purpose to prove each test would notice.

The output is a coverage report where every risk is tested, accepted with a reason, or out of scope. "Every edge case" is not a checkable goal; "every risk class considered and accounted for" is.

## When to Use

- A task or feature in the new stack is built and its own tests pass
- Before review, for any change that touches a run, a stream, stored state, a retry, a process or model output
- When asked whether existing tests are strong enough

**NOT for:**
- Building the feature or fixing a known bug: do that first, test first.
- Trust-boundary abuse: cross-tenant IDs, forged or reused tokens, prompt injection, SSRF, leaks through events. Note such suspicions in the report and stop there.
- Speed and capacity numbers: harden checks behaviour under load and failure, not latency.
- The old stack (`agent-core/`, `platform/`): stop and ask.

## Truex New Stack

```text
frontend (3000, tenant chat in app/t/[tenantId])
   → platform-next (4100, NestJS + MongoDB: auth, tenants, agents, chats)
   → runtime-adapter (4400, one pinned Codex app-server per chat)
   → codex app-server (vendor/codex, never modified)
   → model-gateway (4200, Responses ↔ provider APIs)
```

Each package is independent (own `node_modules`, scripts, tests; no npm workspaces). Root `npm test` and `npm run build` skip runtime-adapter and platform-next, so they are not evidence for the new stack.

Where this stack breaks, in order of how often it matters:

| Surface | Why it is hostile | Reference |
|---|---|---|
| Model output | The model is untrusted input: bad tool arguments, loops, unknown items, cut streams, calls after stop | [hostile-model.md](references/hostile-model.md) |
| Run lifecycle | start, steer, stop, approval, complete, restart and resume interleave; exactly one `run.completed` must end every stream | [techniques.md](references/techniques.md) (state tables) |
| Processes and storage | Codex crashes, slow starts, capacity eviction, adapter restart, lost thread storage | [fault-points.md](references/fault-points.md) |
| Stored state | Mongo writes, retries by `clientMessageId`, partial writes, two writers | [fault-points.md](references/fault-points.md) |
| Event streams | SSE `seq` and reconnect `after=<seq>`, snapshot fallback, slow readers, client batching | [techniques.md](references/techniques.md) (invariants) |
| Provider translation | Upstream returns malformed, partial or slow responses through model-gateway | [fault-points.md](references/fault-points.md) |

The adapter contract and its error codes are in `runtime-adapter/README.md` (`## Contract`, `## Error codes`). Read them; they are the expected behaviour for most risks.

## Process

### Step 1: Scope

1. Name the change: a task from `tasks/<feature>-todo.md`, a diff (`git diff main...HEAD` plus uncommitted files), or files the user names.
2. List the packages it touches and every entry point into the changed code (HTTP route, event mapper, reducer, CLI).
3. Read the intent sources only: `docs/ideas/<idea>.md`, `tasks/<feature>-plan.md`, the task's acceptance criteria, the contract sections above. Do not read the implementation yet.

### Step 2: Write the invariants first

From the intent sources, write 5–15 rules as **must always** / **must never**, each checkable by a test:

```text
MUST ALWAYS  every run stream ends with exactly one run.completed
MUST ALWAYS  plan.updated carries the full plan, never a diff
MUST NEVER   a malformed update_plan call fails the turn
MUST NEVER   a retried message with the same clientMessageId is stored twice
```

If the sources do not say, mark the rule `(inferred)`. Show the list to the user with the Step 5 proposal; inferred rules are the ones most worth their correction.

### Step 3: Model the change

Now read the implementation and its tests. Produce the three tables in [techniques.md](references/techniques.md), sized to the change:

- **Inputs:** partitions and boundaries for every field the change reads, including model-produced fields.
- **States:** every state, every legal transition, and the illegal ones (stop after complete, steer after stop, approval twice).
- **Dependencies:** every call the change makes, and what it does when that call fails, hangs, is slow or returns garbage.

For each row, find the existing test that covers it, by name. Rows with no test are candidates.

### Step 4: Attack in a fresh context

Start a sub-agent that did not write the code. Give it only: the invariants, the list of changed files, and the four reference files. Ask it to find concrete inputs or event orderings that break an invariant, each with the code path (`file:line`) that lets it happen. Tell it not to edit files.

If no sub-agent is available, do the attack yourself and label it **self-attack (weaker)** in the report.

Merge its findings into the tables. Discard any it cannot back with a code path.

### Step 5: Rank and propose, then stop

Score each uncovered row: **probability × impact × difficulty of detection**, each 1–3. Take every row scoring 12 or more, plus anything that can lose data, double a side effect or hang a run. Everything else is listed as accepted with a one-line reason.

Present the proposal in the format in [coverage-template.md](references/coverage-template.md): invariants, then the ranked risk list, each with its proposed test (kind, file, support code). **Stop and wait for the user to approve, cut or add.** Write nothing before that.

### Step 6: Write the approved tests

- Put each test where the neighbouring tests live, using the existing support code ([fault-points.md](references/fault-points.md) lists it). Match the file's style.
- One risk per test; the test name states the rule (`"a stop after run.completed is RUN_ENDED and changes nothing"`).
- Assert the exact outcome: status, error code, event sequence, stored document. Never only "did not throw".
- If the fixture cannot produce the hostile behaviour, extend the fixture (a new `Behavior` kind) rather than mocking the code under test. Name the fixture change in the report.
- Seeded loops for invariants over many inputs; print the seed on failure ([techniques.md](references/techniques.md)).

Run each new test. Then:

- **It fails** → you may have found a bug. Check the test is right (expected value from the invariant, not a guess). If it is, record a **confirmed finding** with the failing output. Do not fix it unless the user says so; the test stays as the regression test, marked with the finding in its name or a comment, and is not skipped.
- **It passes** → the behaviour holds today. Step 7 proves the test would notice if it stopped holding.

### Step 7: Prove the tests bite (hand mutation)

For each guard the new and existing tests rely on in high-risk code, make one small mutation from the catalog in [techniques.md](references/techniques.md) and run the tests that should catch it.

**Safe procedure, every time:**

```bash
cp <file> /tmp/harden-orig-<name>      # 1. copy first
# 2. apply ONE mutation with an edit
npx tsx --test --test-name-pattern='<pattern>' test/<...>.test.ts   # 3. run the tests that should catch it
cp /tmp/harden-orig-<name> <file>      # 4. restore from the copy
cmp /tmp/harden-orig-<name> <file>     # 5. must print nothing
```

Never restore with `git checkout`, `git restore` or `git stash`: the working tree usually holds the user's uncommitted work. Never leave a mutation in place between steps. After the last mutation, run `git diff --stat` and confirm only the intended test files changed.

A mutation no test catches is a **survivor**. Strengthen or add a test until it is caught, or record it as accepted (equivalent mutation, or not worth testing) with the reason.

### Step 8: Flake check

Run every new test that involves time, concurrency, a child process or a stream **5 times in a row** (a shell loop around the focused command). One failure in five means the test is flaky: fix its synchronisation (wait for the event, request count or state change), never by adding a delay or a retry.

### Step 9: Full checks and report

In each package touched: `npm run typecheck`, `npm test`, and the format check (`npm run format:check` in runtime-adapter and platform-next; `npx prettier --check <changed files>` from the repo root for model-gateway and frontend; root `npm run format:check` already fails on files unrelated to any change). Write the report in the [coverage-template.md](references/coverage-template.md) format, with the counts each command printed. Do not commit.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll read the code first to see what to test" | Then the tests check what the code does. Write the invariants from the intent first. |
| "The model would never send that" | Models send malformed arguments, repeat calls and stop mid-stream in production. The fixture can send it, so test it. |
| "The new test passed, so it's covered" | A test that never failed may not check anything. Mutate the code and watch it fail. |
| "`git checkout` the file to undo the mutation" | That also erases the user's uncommitted changes in that file. Restore from your copy. |
| "It passed 4 times out of 5, good enough" | That is a flaky test. Users will hit the fifth. |
| "A short sleep makes the race reproducible" | It makes it timing-dependent. Hold the fixture (`held`, `hangAfterCreated`) or wait on a signal. |
| "I'll fix the bug I found while I'm here" | Report it with the failing test. The fix is a separate, approved change. |
| "Testing every row is thorough" | Unranked testing spends the effort on trivia. Rank, go deep on the top, record the rest. |

## Red Flags

- Tests written before the user approved the risk list
- Invariants written after reading the implementation, or none written
- An assertion that only checks "is defined", "did not throw" or a status without the error code
- The module under test mocked, or a hostile case faked by mocking instead of using the fixture
- `test.skip`, `test.only`, `todo`, or a found-bug test disabled to get green
- A fixed `sleep` used to wait for an event (a `delayMs` simulating a slow model is fine)
- `git checkout`, `git restore` or `git stash` used during mutation
- A mutation left in a source file, or `git diff` showing source changes after Step 7
- A suspected security issue tested here instead of reported for a security review
- A file in `agent-core/`, `platform/` or `vendor/codex/` changed

## Verification

- [ ] Invariants were written from intent sources before the implementation was read
- [ ] Inputs, states and dependencies tables exist, each row mapped to a test, a proposal, or an accepted reason
- [ ] The attack ran in a fresh context, or the report says it was a self-attack
- [ ] The user approved the test list before any test was written
- [ ] Every new test asserts an exact outcome and was run
- [ ] Every confirmed finding has its failing test output in the report
- [ ] Every high-risk guard was mutated; each mutation was caught or recorded as accepted
- [ ] Every mutated file was restored from its copy and `cmp` showed no difference
- [ ] Timing and concurrency tests passed 5 runs in a row
- [ ] `typecheck`, `npm test` and the format check passed in every touched package, with counts reported
- [ ] Nothing committed; no old-stack or `vendor/codex` files changed
