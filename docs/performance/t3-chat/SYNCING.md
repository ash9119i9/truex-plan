# Chat-switch syncing: measured decision

Measured on 2026-10-05. The top-bar `syncing…` state is controlled by
`openingId` in `frontend/app/page.tsx`. Previously, opening awaited the
authorized persisted history read, installed it, then started and awaited full
runtime recovery. Full recovery includes snapshot, record ingestion, all runtime
item pages, and persisted history reads. Painting a cached chat did not shorten
that sequential network path.

## Measurements

Three real local chats initially returned saved history in 462–465 ms and full
recovery in 1,639–1,673 ms. The existing Server-Timing headers attributed roughly
227 ms to authorization, 938–981 ms to recovery, and 458–462 ms to the final
persisted phase of a recovery response. No chat content or session identifiers
are included in the artifacts.

| Check                                                             |      Before |       After |
| ----------------------------------------------------------------- | ----------: | ----------: |
| Same real local chat, three paired rounds, median total HTTP time | 2,208.60 ms | 1,650.03 ms |
| Production browser, controlled delays, median click-to-ready      | 2,179.40 ms | 1,715.00 ms |
| History requests per browser switch                               |           2 |           2 |
| Recovery request begins after saved request                       |  464–467 ms |      0–1 ms |

The first row directly exercises the sequential/concurrent HTTP patterns against
the running local platform. It is not a real-app browser latency measurement.
The browser row uses the same visible 1280×800 native T3 preview and isolated
synthetic API with saved-read delay 460 ms and recovery delay 1,650 ms. It uses
production webpack builds: pre-change on3102, candidate on3104, with three
alternating A/B switches. These small samples establish this local improvement;
they do not establish production p95 or T3 performance parity.

Raw evidence: [local HTTP](sync-live-http.json), [browser](sync-browser-results.json),
[regression tests before](sync-tests-before.txt), [after](sync-tests-after.txt).

## Smallest safe change

`SessionHistory.loadForOpen` starts both existing, independently authorized reads
concurrently. The page still installs persisted history first, then awaits the
exact recovery promise before clearing `openingId` and action locks. No backend
contracts, authorization, cache freshness rules, or ready-state criteria change.

The page registers the recovery promise's original navigation generation and
live revision immediately. Events received while the saved read is pending
remain newer than that recovery snapshot. Passing the exact promise prevents
an already completed recovery from being requested again after saved paint.
An early rejection is handled while awaiting saved history and still rejects
when the normal recovery consumer awaits it.

T3 reference commit: `cf3e714b0f58e29c8fa8660db50d2187e3263b65`.
Its client-runtime `state/threads.ts` retains synchronized threads, resumes with
`afterSequence`, and uses an explicit synchronized marker. Its server supplies
bounded stored projections (`apps/server/src/ws.ts`, `ProjectionStore.ts`).
T3 does not use Truex's two HTTP reads; concurrent reads are a conservative Truex
adaptation of independently painting saved state and synchronizing live state.
Replacing Truex's full reconciliation with cursor-based recovery needs separate
persistence and ordering work. Stream connection headers alone do not establish
fresh conversation state, so they cannot safely replace this gate.

## Acceptance and failure checks

- Both reads start together; saved history still installs first and ready waits
  for recovery. Exactly two history reads remain per switch.
- Recovery finishing at20 ms before a700 ms saved read stayed locked until saved
  completion, reused its completed promise, and retained all20 streamed `z`
  characters received during the wait.
- Delayed A(saved700/recovery1100 ms) followed by B(saved30/recovery120 ms)
  remained on B with its correct title, latest answer, and ready state after A
  completed.
- Recovery denied early while saved history was delayed produced the expected
  access error and removed all message rows and retained outgoing content.
- Unit tests cover independent pending reads, fast completed recovery, early
  rejection without orphan rejection, and retry after failures. The three new
  tests fail against the old controller lacking concurrent opening and pass
  against the new controller. All261 frontend tests pass, with no skips.
- Type checking, scoped formatting, diff checks, and isolated production
  webpack and default Turbopack builds pass. The user's running dev server was
  not stopped or rebuilt. Turbopack initially rejected dependency symlinks
  escaping the temporary copy's root; copying dependencies inside that root
  resolved the test-environment issue without repository configuration changes.
- The full backend test run passes: agent-core172, platform171, gateway58;
  together with frontend261, all662 tests pass with no skips.

The change adds no writes, migrations, dependencies, or retry policy. Each
request retains backend authorization before runtime access. One tradeoff is
that an opening abandoned before its saved read completes can already have
started authorized recovery; generation guards prevent its results entering a
different selected chat. Backend single-flight sharing remains unchanged.

## Reproduction

Run `node --experimental-strip-types docs/performance/t3-chat/browser-fixture.mjs`.
Build the before/after source copies with
`NEXT_PUBLIC_PLATFORM_URL=http://127.0.0.1:4400 npm run build -- --webpack`
and serve each on a separate port. Configure fixture-a and fixture-b via
`POST /__configure` with `persistedDelay:460,recoveryDelay:1650,error:null`.
Open a visible native T3 preview, wait for the initial chat to finish, open the
sidebar, then run `measureSyncSwitches` from [the browser probe](browser-sync-probe.mjs)
against each build. The probe checks the actual top-bar text and fixture request
start/completion times. Do not run fixture configuration endpoints against the
real platform.

Run controller regressions with:
`node --experimental-strip-types --test frontend/test/session-history.test.ts`.

Remaining delay is backend recovery and database round trips. This change
removes their unnecessary sequential start, not their work. Returning to a warm
thread with T3-style cursor synchronization remains a larger follow-up.
