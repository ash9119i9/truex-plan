# Resume approval confirmation review

The existing mode update saves desired configuration before the runtime request,
so a lost or rejected update survives a page reload. The platform previously sent
that desired configuration during resume but accepted any successful response,
allowing a runtime that did not apply it to receive the next turn.

The shared create/resume confirmation helper now requires the exact selected
mode. An older runtime that omits an acknowledgment uses its existing
`/approval-mode` endpoint and must acknowledge the exact mode. A contradictory
resume acknowledgment fails without silently correcting the runtime. Resume
verification occurs before plan persistence, capability changes, session status
or fingerprint updates, message insertion, and turn dispatch. Feature-off keeps
its previous request shape and does not add confirmation calls.

`next-resume-approval-red.txt` records four invalid resumed modes dispatching
before the fix and the missing legacy confirmation. `next-resume-approval-after.txt`
records all 21 focused approval/create/reload tests passing. The new reload test
uses a fresh service instance after a failed live mode change and verifies no
session/message mutation and no turn call on invalid confirmation. It also
verifies exact new/legacy confirmations and feature-off compatibility.

The first-send probe already supplied exact new-runtime resume acknowledgments
in both conditions. Its refreshed raw thirty samples retain 3 client / 4 runtime
requests before and 2 client / 3 runtime requests with configured creation;
confirmation adds no request for current runtimes. Older runtimes require an
additional resume confirmation request to preserve the safety contract.

Independent review also identified that malformed completion markers could
fabricate idle/empty operational state through projection defaults; root owns
strict validation and regressions for that issue. The private runtime thread ID
is intentionally omitted from public streams; the frontend owner has resolved
pair identity through the authenticated subscription's public session ID.

History projection uses the unchanged conversation ordering algorithm and
retains unanchored commands in actual Mongo. Missing selected bodies fail with
`HISTORY_CURSOR_STALE` instead of partial successful pages. Full cold ingestion
and reconciliation remain in recovery. Reads still do not claim database/runtime
atomicity. Concurrent approval changes across separate clients remain an
existing serialization boundary outside this confirmation change; no automatic
retry or queue was added.
