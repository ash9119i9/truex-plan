# Source-paired warm resume

The display cache combines durable users, commands, approvals, paged history, and
live AI rows. Its HTTP snapshot cursor cannot prove that this combined projection
contains every source frame. Warm replay now uses a separate bounded source pair:
`{protocol:1, threadId:publicSessionId, cursor, entries:sourceAIAndReasoningOnly}`.
The subscription stamps its trusted URL session scope because public projection
intentionally omits the private runtime thread ID.

## Eligibility and readiness

- Every open still authenticates and reads recent persisted history. A valid warm
  pair skips the full/items recovery request; persisted users/commands merge into
  display only.
- A cold stream marker during HTTP recovery proves protocol support, but cannot
  qualify a pair. Only successful full recovery followed by a fresh source
  snapshot and same-cursor `sync.completed` marker establishes eligibility.
- `recoveryError` makes recovery unsuccessful. Saved history can paint, but no
  fresh handoff or source pair is qualified, and the next open performs full
  recovery again.
- Replay frames apply to the paired source projection before the marker publishes
  operational state. Zero-gap replay still restores running/pending authority.
  Warm opening controls remain gated until this marker is accepted.
- Markers share their source high-water cursor with the last replay frame or
  snapshot. They bypass ordinary cursor deduplication. Cursor checkpointing occurs
  only after consumer publication succeeds. Cursorless `resync.required` reaches
  the conservative fallback without being misclassified as a malformed SSE ID.
- Source pairing never uses independent sessionStorage cursors or HTTP cursors.
  Explicit `cursor:null` sends no cursor. Legacy subscribers keep their default
  behavior.
- Bounds disqualify the whole pair rather than truncating text: 2,000 source rows
  or 8 MiB estimated source text. Runtime separately bounds replay/bootstrap.
- Missing display-cache data does not cause source-only orphan AI rows to paint
  before the authenticated durable read. Source and display LRUs are independent.
- Authorization revocation clears active source/display ownership immediately,
  cancels the navigation generation and waiter, and prevents an already pending
  HTTP response or synchronous cache-save call from restoring revoked content.

## Conservative compatibility behavior

Malformed/generation/coverage/overflow failures and marker timeout use full
recovery. Readiness deadlines default to five seconds and have deterministic
fake-clock tests. A cold old server that never publishes markers does not incur
an additional mandatory handoff deadline. A newly created session initially uses
ordinary recovery before it can qualify a source baseline.

Automatic native EventSource reconnect uses Last-Event-ID. The frontend retains
its explicit subscription boundary; a marker with a different `fromCursor`
invalidates the pair and performs full recovery. This is intentionally safe and
can cost an extra recovery on reconnect. No unverified reconnect fast path was
introduced.

A runtime manager that cold-loads a thread cannot prove complete restored source
item bodies. It consequently suppresses markers and uses legacy recovery for
that thread. For example, persisted active `prefix` followed by live `suffix`
must never qualify a suffix-only source baseline. Warm eligibility applies only
to continuously source-tracked runtime threads. This restriction is safer than
pairing mixed HTTP content with a stream cursor.

## Executable evidence

`frontend/test/source-resume-page.test.ts` extracts and executes the actual page
callbacks (`open`, `recover`, handoff, cache save, invalidation) in an isolated
state/API harness. It uses the actual SessionHistory/SessionCache/source/chat
reducers and controlled promises. It does not test static source strings or
contact a provider/service. This is callback integration evidence; it does not
claim production React effect scheduling, browser paint latency, or authorization
service behavior.

The exact pre-fix candidate callbacks are archived in
`next-source-resume-before-callbacks.txt`. They already include the source helper
and protocol integration. Running the same five page regressions against that
candidate produces four assertion failures and one pass, captured in
`next-source-resume-before.txt`: unsuccessful recovery qualifies a pair,
authorization clears maps but leaves recacheable refs, deferred authorized
history resurrects revoked data, and source-only initial overlay paints orphan
AI rows. This is a working candidate regression comparison, not a missing-helper
compile failure.

The candidate passes all five actual-page regressions. Together with twelve
source-helper regressions and twenty transport regressions, all 37 focused tests
pass (`next-source-resume-after.txt`). They also cover canonical safe cursors,
wrong scope/generation/mode/coverage, filtered public sequence gaps, duplicate
frames, rejected partial batches, overflow, fallback reasoning identities,
zero-gap running/pending state, implicit reconnect fallback, exact long-history
request/answer order and identity across thirty warm overlays, stale navigation,
timeout, exact transport checkpoint ordering, and actual public wire frames
without thread IDs coalescing 1,000 text deltas into one projection update.

Reproduce from repository root:

```sh
TRUEX_SOURCE_RESUME_PAGE=docs/performance/t3-chat/next-source-resume-before-callbacks.txt node --experimental-strip-types --test frontend/test/source-resume-page.test.ts
node --experimental-strip-types --test frontend/test/source-resume-page.test.ts frontend/test/source-sync.test.ts frontend/test/transport.test.ts
npm --prefix frontend run typecheck
npm --prefix frontend test
```

Final checkpoint: frontend typecheck passes, all 331 frontend tests pass, and
`git diff --check` passes. Native production-page measurements and source-runtime
HTTP integration evidence are recorded separately by the owning agents. No
commits, deployment, or actual user chat/provider requests were performed by this
subtask.
