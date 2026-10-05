# Configured first-send creation evidence

T3 reference: `cf3e714b0f58e29c8fa8660db50d2187e3263b65`,
`apps/web/src/components/ChatView.tsx:9446–9480`: a local draft's validated
configuration is carried in `bootstrap.createThread` inside its turn command.
Truex retains its existing create/message contracts and runtime lifecycle; this
increment adopts configured creation without claiming T3's transaction model.

The new optional `approvalMode` field on `POST /api/sessions` is validated against
the existing mode/feature policy before configuration or runtime provisioning.
The runtime gets the selected mode during its existing `/threads` creation.
The platform saves/exposes it only after an exact creation acknowledgment;
an older runtime lacking that field uses its existing `/approval-mode` endpoint
and must return an exact mode acknowledgment. A contradictory acknowledgment
fails and enters the existing cleanup path. Feature-off creation without the
field retains its old shape; an explicit feature-off selection fails closed.

The frontend captures its selected mode before awaiting provisioning. A new
platform returns the verified selected mode and needs no separate UI update.
An older platform ignoring the additive request still receives the usual
follow-up mode confirmation before dispatch. Existing-message and goal paths
retain their configuration guards. Creation and message writes remain separate;
there is no atomic runtime/database transaction or automatic retry of uncertain
creation/acceptance.

## Controlled measurement

`next-first-send-probe.mjs` runs the actual PlatformService, configuration builder,
Store and isolated Mongo. It replaces only runtime responses and injects fixed
20 ms per simulated client request and 8 ms per runtime call. Every run uses the
same flags, agent, selected readOnly mode and exact synthetic text. The fixture
asserts accepted persisted text/turn identity. Runtime binaries must already be
cached (`MONGOMS_RUNTIME_DOWNLOAD=false`). Hardware/runtime: macOS arm64,
Node 24.21.0. Two warmups precede thirty recorded runs in each condition.

| Recorded controlled result        |    Before | Configured creation |
| --------------------------------- | --------: | ------------------: |
| Client requests before acceptance |         3 |                   2 |
| Runtime calls                     |         4 |                   3 |
| Configuration calls               |         2 |                   2 |
| Session inserts                   |         1 |                   1 |
| Session reads                     |         2 |                   1 |
| Session updates (includes title)  |         2 |                   1 |
| Message inserts/updates           |     1 / 1 |               1 / 1 |
| Submit-to-acceptance p50          | 111.08 ms |            78.66 ms |
| Submit-to-acceptance p95          | 114.58 ms |            83.22 ms |

Raw samples, per-phase timings, request paths and operation counts are in
`next-first-send-before.json` and `next-first-send-after.json`. The fixture counts
service operations, not Mongo execution-engine queries. The candidate includes
the accompanying mode-confirmation correctness changes, including resume
acknowledgment verification. Both conditions use the same runtime fixture with
an exact resume mode acknowledgment, so current runtimes add no extra hop.
These thirty-sample results were refreshed after that verification was added;
other repository checks were running on the same workstation. These are synthetic
acceptance measurements; no provider generation, first delta, React paint,
production network or T3 latency was measured.

Run from the repository root:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-first-send-probe.mjs
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-first-send-probe.mjs --configured
node --import ./platform/node_modules/tsx/dist/loader.mjs --test platform/test/session-creation.test.ts
node --experimental-strip-types --test frontend/test/composer-dispatch.test.ts frontend/test/projects.test.ts frontend/test/approval-mode.test.ts
npm --prefix frontend run typecheck
./platform/node_modules/.bin/tsc --project platform/tsconfig.json --noEmit
```

The saved before/after JSON compares the separate create/mode/send sequence
against configured create/send on the final candidate service, including resume
confirmation. It isolates the removed hop; it is not a latency comparison against
the pinned original service. Source revisions for the completed implementation
are listed in the integrated verification manifest.

## Regression and failure checks

Before integration, three real service tests failed: explicit selection was
ignored, invalid mode reached configuration, and older-runtime mode confirmation
was missing. `next-first-send-red-tests.txt` records those failures. Three
frontend body/dispatch tests also failed before the new request field was wired
(`next-first-send-frontend-red.txt`).

Candidate verification: nine service/helper tests pass, covering validation,
feature-off behavior, exact/legacy acknowledgment, owner/project authorization,
contradictory acknowledgment cleanup, database write failure with failed cleanup,
and saved configuration across a fresh service instance before the first turn.
Thirty-nine focused frontend dispatch/project/approval tests pass. Type checks
and scoped Prettier pass. Raw results are `next-first-send-tests-after.txt`,
`next-first-send-frontend-after.txt`, `next-first-send-*-typecheck.txt` and
`next-first-send-format.txt`.

The database-failure test confirms best-effort cleanup preserves the original
error; cleanup failure can still leave an untracked runtime thread. No turn is
dispatched in that case. Existing uncertain provisioning/Recents recovery and
unknown message receipts remain necessary.

## Conditional bootstrap decision

Configured creation removes a measured serial hop and the corresponding runtime
mode update while reusing existing authorization, storage and transport. The
remaining create/message separation is retained. A combined first-send command
would require a durable tenant/owner-scoped creation-identity mapping, same-key
payload conflict handling, stable runtime identity and restart/lost-response
recovery before retries could be safe. No production measurement presently
justifies that additional state machine; this optional plan step is deferred.
No redundant resume was removed, no queue/prewarming was added, and no new
collection/index/migration or dependency was introduced. Rollout remains backend
first; rollback preserves existing sessions and messages.
