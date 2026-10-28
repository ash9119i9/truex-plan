# Hostile Model

The model is the least trustworthy input in the stack. It is not malicious on purpose, but in production it sends wrong-shaped tool arguments, repeats calls, invents tool names, stops mid-stream and keeps going after it was told to stop. Every feature that reads model output (tool calls, plans, text, reasoning, helper output) gets tested against these behaviours with the scripted fixture, never with a real model.

Real-model tests (`*-real.test.ts`) measure what a model tends to do. They cost money, run only when the user asks, and report results rather than assert them. They are not hardening tests.

## The fixtures

| Fixture | Package | Use for |
|---|---|---|
| `ModelFixture` (`runtime-adapter/test/support/model-fixture.ts`), reached as `h.model` from `Harness` | runtime-adapter | Anything Codex does with model output |
| `FakeGateway` (`platform-next/test/support/chat-stack.ts`) | platform-next | The same, end to end through platform-next and a real adapter process |

`ModelFixture` behaviours, consumed one per model request from `h.model.script` (else `h.model.defaultBehavior`):

| `kind` | Sends |
|---|---|
| `reply` | Text in `chunk`-sized deltas (default 8), `delayMs` apart, then `response.completed` |
| `call` | One `function_call` with `name`, optional `namespace`, `arguments: JSON.stringify(args)` |
| `custom` | One `custom_tool_call` (the form `apply_patch` uses), optionally streamed in pieces |
| `failed` | `response.failed` with `code` (`context_length_exceeded` → `CONTEXT_FULL`) |
| `status` | An HTTP error status (500 → `PROVIDER_ERROR`, 429 → `RATE_LIMITED` when repeated) |
| `hangAfterCreated` | `response.created`, then silence (watchdog → `MODEL_TIMEOUT`) |
| `hangBeforeHeaders` | Nothing at all (→ `MODEL_TIMEOUT`) |

`h.model.router = (body) => Behavior | undefined` answers by request content instead of order; use it when a lead and helpers share the fixture, or to answer "every request that contains the tool result" with the same behaviour. `h.model.requests` and `h.model.lastRequest().body` show exactly what Codex sent, including which tools were offered.

`FakeGateway` has the same `reply`, `call`, `custom` and `failed`, plus `held` (streams `before`, waits for `release()`), `stall` (sends nothing until `release()`), and `waitForRequests(n)`.

## Hostile behaviours to test

For each feature that reads model output, go down this list and keep the rows that apply.

| # | Behaviour | How to script it today | What to assert |
|---|---|---|---|
| 1 | Tool arguments of the wrong shape: missing field, wrong type, extra field, `null`, huge array | `call` with those `args` | The turn does not fail unless the contract says so; the mapped event is bounded or absent; the error code is the documented one |
| 2 | Tool arguments that are not valid JSON | **Not possible today**: `call` always stringifies. Extend the fixture (below) | Same as 1 |
| 3 | A tool name that was not offered, or the right name in the wrong namespace | `call` with that `name` / `namespace` | Codex's answer reaches the model; nothing is executed; no event leaks the unknown name as if it ran |
| 4 | The same call repeated many times | Push N `call` items, or a `router` that always returns the call | The run still ends (by stop, watchdog or a cap); events and stored items stay bounded |
| 5 | A call or reply after stop | `reply` with `delayMs`, or `hangAfterCreated`; stop inside `readSse(res, onEvent)`; leave a `call` next in the script | Run ends `stopped`; the late call is not executed; exactly one `run.completed` |
| 6 | Silence mid-turn | `hangAfterCreated` | `MODEL_TIMEOUT`, partial text kept per contract |
| 7 | The connection cut mid-stream (no `response.completed`) | **Not possible today**: `reply` stops writing only if the client disconnects. Extend the fixture (below) | A defined failure code, partial text handling as specified, the next message resumes |
| 8 | Empty output: `reply` with `text: ""`, a plan with no steps | `reply` / `call` | No empty bubble or empty saved item unless intended |
| 9 | Very large output | `reply` with a long `text`; `chunk: 1` for many tiny deltas | Bounded memory and stored size; the stream does not stall; caps apply |
| 10 | Unicode split across deltas | `reply` with emoji or CJK text and `chunk: 1` (the fixture slices UTF-16 code units, so surrogate pairs are split across deltas) | Joined text equals the original exactly, in the stream and in storage |
| 11 | A status or enum value the code does not know (e.g. a plan step status) | `call` with that value in `args` | Mapped, dropped or rejected exactly as the contract says; never crashes the mapper |
| 12 | Provider failure after partial output | `reply` then a `failed` on the next request, or `status` 500 repeated | The documented error code; what was already streamed is handled as specified |
| 13 | Helpers (sub-agents) misbehaving while the lead is fine | `router` keyed on the helper's request content | The lead's run ends correctly; the helper's failure is reported, not swallowed |

Tool output and model text that **looks like instructions** (prompt injection), or that tries to reach another tenant, a secret or an internal host, is a security case. Record it in the report for a security review; do not test it here.

## Extending the fixture

When a row says "not possible today", add a `Behavior` kind to the fixture instead of mocking the adapter or Codex. Keep the change small, commented like the existing kinds, and name it in the report. For example:

```ts
// Emits a function call whose arguments are the raw string given, so a
// test can send arguments that are not valid JSON.
| { kind: "rawCall"; name: string; namespace?: string; arguments: string }
// Streams the first `afterChars` of `text`, then destroys the socket without
// response.completed, as a dropped provider connection does.
| { kind: "cut"; text: string; afterChars: number; chunk?: number }
```

Mirror the kind in `FakeGateway` only if a platform-next test needs it. Run the fixture's own existing tests (the package's full `npm test`) after the change, because every real-Codex test depends on it.

## Known Codex behaviour

`runtime-adapter/README.md` → `## Verified Codex behavior (pin ...)` and `runtime-adapter/test/codex/pin-behavior.test.ts` record what the pinned Codex does with model output (for example, a steer mid-stream cuts the reply and it never completes). Check there before deciding a result is a bug in the adapter: it may be pinned Codex behaviour the adapter must work around, and `vendor/codex` is never modified.
