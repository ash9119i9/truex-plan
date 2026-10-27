# Techniques

How to generate edge cases instead of hoping to think of them. Size each table to the change: a 30-line mapper needs a short inputs table and no state table; a run-lifecycle change needs all three.

## 1. Inputs table: partitions and boundaries

One row per field the change reads, including fields the model produces and fields read back from storage.

| Field | Valid partitions | Boundaries | Invalid | Existing test |
|---|---|---|---|---|
| `plan[]` (from update_plan) | 0 steps, 1, many | max allowed, max + 1 | not an array, null, missing | `plan.test.ts: "two update_plan calls..."` |
| `plan[].step` | ASCII, Unicode, RTL, emoji | empty, at length cap, cap + 1 | number, object, whitespace only | none → candidate |
| `plan[].status` | `pending`, `in_progress`, `completed` | | unknown value, wrong case, missing | none → candidate |

Rules of thumb:

- Every bound in the code (`MAX_*`, `slice`, length checks) gets a test at the bound and one past it.
- Text fields: empty, whitespace only, multi-byte characters at the cut point (a bound that slices a string can split a surrogate pair), and a value large enough to matter for memory.
- Enum fields from the model or a provider: one unknown value. The contract decides whether it is dropped, mapped or rejected; the test pins that.
- Optional fields: absent, `null`, and present-but-wrong-type are three different cases.
- Fields read back from Mongo: documents written by an older version (field missing) must still load.

## 2. States table: transitions, including illegal ones

List states down the side and events across. Every cell is either a defined outcome or a candidate.

Adapter runs, with cells taken from `runtime-adapter/README.md` (`## Contract`, `## Error codes`):

```text
               start          steer                 stop                    approval answer
no run         running        404 RUN_NOT_FOUND     404 RUN_NOT_FOUND       404 APPROVAL_NOT_FOUND
starting       409 CHAT_BUSY  waits, then steers    ?                       —
running        409 CHAT_BUSY  202 queued            202 stopping            404 (no such card)
awaiting card  409 CHAT_BUSY  202, cards declined   202, cards declined     200 {decision}
stopping       409 CHAT_BUSY  409 RUN_ENDED         202, no 2nd interrupt   ?
finished       new run        409 RUN_ENDED         200 {status}            404 APPROVAL_NOT_FOUND
```

The `?` cells are where bugs live. Fill them from the contract or the code, or list them as open questions for the user. Add a column for each event the change introduces (an adapter restart, a capacity eviction, a new tool event), and build a separate table for any other state machine the change touches (platform chat state, the frontend chat reducer).

Also test each transition **twice in a row** (double stop, double approval, duplicate start with the same `runId`) and **out of order** (steer that arrives after the model finished but before `run.completed` was sent).

## 3. Dependencies table: what each call does when it fails

| Call | Fails fast | Hangs | Slow | Returns garbage | Succeeds after our timeout |
|---|---|---|---|---|---|
| model via gateway | `status` 500 → PROVIDER_ERROR | `hangBeforeHeaders` → MODEL_TIMEOUT | `delayMs` | see hostile-model.md | late reply after stop |
| Codex process | SIGKILL → RUNTIME_ERROR | ? | slow start | ? | — |
| Mongo write | server stopped | ? | ? | — | write landed, caller saw error |

The last column is the one most often missed: the caller timed out and retried, but the first attempt did land. That is where duplicates come from.

## 4. Invariants as properties (seeded loops)

No property-testing library is installed. Use a seeded generator and loop; print the seed so a failure can be replayed. The repo already does this in `frontend/test/chat-batch.test.ts` ("seeded randomized batches equal the unoptimized reducer...").

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

test("bounded plan never exceeds the step cap and keeps step order", () => {
  const start = Number(process.env.SEED ?? 0x12345678);
  let seed = start;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 500; i++) {
    const input = randomPlan(next); // sizes around the cap, odd strings, bad statuses
    const out = boundPlan(input);
    assert.ok(out.length <= MAX_STEPS, `seed ${start}, case ${i}`);
    // ...the other invariants for the same input
  }
});
```

Good properties for this stack:

- **Bounded:** output size never exceeds its cap, whatever the input.
- **Total:** the mapper never throws on any JSON value; bad input becomes a defined outcome.
- **Round trip:** what is saved and read back equals what was streamed.
- **Differential:** an optimised path equals a simple reference path on the same input (batching vs one-by-one, incremental markdown vs full parse).
- **Monotonic:** `seq` strictly increases; a reconnect after `seq = n` yields only events with `seq > n`, none missing, none repeated.
- **Idempotent:** applying the same event or request twice equals applying it once.

Generate inputs biased to the boundaries (sizes at cap − 1, cap, cap + 1; empty; one long Unicode string), not only uniform random values.

## 5. Interleavings

For any two operations that can overlap on the same chat or document, test the orderings explicitly. Make the order deterministic by holding one side:

- **Model fixture:** `hangAfterCreated` keeps a turn open until you act; `reply` with `delayMs` gives a window mid-stream; act inside `readSse(res, onEvent)` at a chosen event.
- **FakeGateway (platform-next):** `held` streams `before`, then waits for `release()`; `stall` sends nothing until `release()`; `waitForRequests(n)` waits for the nth model request.
- Fire the two operations with `Promise.all` once both are in the window, and assert the combined outcome (exactly one wins, the other gets a defined error, nothing is stored twice).

Pairs worth checking in this stack: stop vs completion, steer vs completion, two sends with the same `clientMessageId`, approval answer vs stop, reconnect vs completion, restart vs an in-flight write, capacity eviction vs a new run on the evicted chat.

## 6. Mutation catalog

Apply one at a time with the safe procedure in SKILL.md Step 7. Choose mutations on the guards the risk list depends on.

| Mutation | Example | A good test fails because |
|---|---|---|
| Negate a condition | `if (n > MAX)` → `if (n <= MAX)` | bound tests see the wrong side |
| Shift a bound | `>` → `>=`, `MAX` → `MAX + 1` | the at-bound and past-bound tests |
| Delete a guard | remove an early `return` or a `typeof` check | the invalid-input test |
| Return a default | `throw` → `return []`, error code → generic | the exact error-code assertion |
| Drop an `await` | `await store.save(x)` → `store.save(x)` | ordering or round-trip test |
| Swap two writes | persist then emit → emit then persist | crash-between test, reconnect test |
| Skip dedup | remove the `clientMessageId` lookup | duplicate-request test |
| Widen a filter | drop a field from an allowlist | the "never leaked" assertion |
| Off by one in seq | `seq > after` → `seq >= after` | the reconnect property |

Record each as `killed by <test name>` or `survived`, with what was done about survivors. A mutation that cannot change observable behaviour (equivalent) is recorded as such, not counted as a survivor.
