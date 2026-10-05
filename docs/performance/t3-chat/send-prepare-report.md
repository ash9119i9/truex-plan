# Operational send preparation evidence

Measured the existing working tree before production edits on 2026-10-06. The
actual manager source was frozen in `send-prepare-manager-baseline.txt`, SHA-256
`ead5e5cb4d5725c0c7d3ec71b02244b10db3b2e34b581dabc393870089f7464e`.
`send-prepare-before.json` records an unchanged source on both sides before the
candidate existed. `send-prepare-after.json` pairs that frozen manager with the
candidate, SHA-256
`8a881bfc64d80fa19fae2c151b5a4e4cdcb5e3a5d6ffc8e918002b84e1744bcd`.

## Change and compatibility

POST `/threads/:id/resume` accepts the explicitly validated body field
`response: "operational"`. It returns the existing operational snapshot and the
existing explicit approval-mode acknowledgment. The field is stripped from
runtime configuration, including deferred configuration. It does not enter
`thread/resume`. Absent the option, the existing full snapshot response stays
unchanged.

The same load, ownership check, approval reevaluation, thread serialization,
fingerprint comparison, deferred reload, goal recovery, and source-coverage
rules still execute. Cold opt-in resumes choose the lean return inside `load()`
to avoid constructing a full snapshot that would immediately be discarded.
`applyPending()` remains unchanged. AgentCore's invocation envelope validates
the resume body option before service startup and forwards the body unchanged.
The platform transport validates and forwards resume bodies for both direct HTTP and AgentCore invocations.

The response deliberately has empty `messages`, `thinking`, and `diff`, while
operational state, visible pending approvals, plans, goals, helpers, rate limits,
and capped recent timing/trace diagnostics remain available. It cannot prove
that saved model settings were applied; the platform must retain that separate
operation. Older runtimes that ignore this additive field safely return the old
full snapshot; the platform must continue accepting it.

## Paired actual manager workload

`send-prepare-benchmark.mjs` uses synthetic completed notifications through the
real manager and serializes the returned resume response. Five warmups precede
30 measured calls per scenario. No model, live database, credentials, or network
calls are involved. The manager's existing message cap is 1000; 10,000 inputs do
not create a 10,000-message retained transcript.

| Message inputs | Retained messages | Before opt-in bytes | After opt-in bytes | Full snapshot calls before/after (35 calls) |
| -------------- | ----------------- | ------------------- | ------------------ | ------------------------------------------- |
| 100            | 100               | 213,850             | 181                | 35 / 0                                      |
| 1000           | 1000              | 2,139,851           | 182                | 35 / 0                                      |
| 10,000         | 1000              | 2,143,182           | 183                | 35 / 0                                      |

For 10,000 inputs, the paired median resume-plus-serialization CPU duration was
0.781 ms before and 0.00129 ms after. The candidate's default full response still
used 2,143,182 bytes and 35 full snapshot calls. These fixture timings measure
local CPU work, not live send acceptance or provider response latency. Byte
savings are the stronger transport evidence; diagnostics/approvals can make
real operational responses larger than this idle fixture.

Reproduction from the repository root:

```sh
node --import ./agent-core/node_modules/tsx/dist/loader.mjs \
  docs/performance/t3-chat/send-prepare-benchmark.mjs .
```

## Validation and failure review

- `send-prepare-final-red-tests.txt`: the final new tests run against the frozen
  original manager and AgentCore. Nine operational regressions fail; default
  response compatibility passes.
- `send-prepare-tests.txt`: initial 55 affected manager, response, AgentCore,
  snapshot and synchronization tests pass.
- `send-prepare-core-all-tests.txt`: all 199 agent-core tests pass after the
  additional failure tests.
- `send-prepare-build.txt` and `send-prepare-format.txt`: core build and scoped
  formatting pass; final scoped `git diff --check` also passes.

Adversarial coverage includes null/boolean/array/object/unknown response modes,
validation before side effects, cross-tenant denial, running approvals,
deferred configuration, fingerprint cancellation, draining runtimes, cold
source coverage, runtime reload failure and safe retry. The operational option
creates no new retry, cache, persistence write, lock, or settings authority.
Default behavior supports mixed versions and rollback without a migration.

## Related t3code implementation

`/Users/ashok/t3code/apps/server/src/orchestration-v2/ProviderSessionManager.ts`
lines 1433–1477 checks the loaded provider/configuration key and returns the
existing provider binding directly when current. Its `startTurn` path at lines
1502–1514 remains separate. This provides a concrete comparison for confirming
runtime configuration without carrying transcript bodies through dispatch;
Truex retains its existing synchronization and approval semantics.

## Adversarial mixed-version cold resume check

The original manager forwards unknown body fields into its `Runtime` adapter.
That alone does not establish whether an old production cold resume is safe.
The original production index constructs `BusinessRuntime`, whose
`configuration()` explicitly selects allowed fields before its
`thread/resume` call (frozen `business-runtime.ts` lines 322–341 and 393–413).

`send-prepare-compatibility-probe.mjs` executes the frozen original manager and
frozen original BusinessRuntime with an operational cold resume and captures
the underlying CodexClient boundary. The option is absent from the forwarded
runtime parameters, while the requested `ask` acknowledgment is retained.
`send-prepare-compatibility.json` contains parameter names and outcomes only.

A second independent check invokes the installed pinned binary with the same
synthetic missing thread UUID, once without and once with the unknown response
field. Both requests reach the identical missing-history error (`-32600`), with
no unknown-field rejection. No model turns are started. The pinned Rust
`ThreadResumeParams` at
`vendor/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:312` has no
`deny_unknown_fields` annotation. The stderr artifact records the expected
SIGTERM shutdown of the isolated binary client.

These checks support keeping the existing additive body option for the actual
old production path. They do not promise compatibility with arbitrary custom
Runtime implementations or unrelated historical builds. No extra preference
header, protocol negotiation, fallback retry, or production edit was needed.
