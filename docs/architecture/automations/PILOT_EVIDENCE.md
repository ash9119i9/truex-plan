# Real read-only automation pilot

Executed after the user's explicit live-pilot authorization, 9 October 2026 local time. **Run now, a native scheduled occurrence and a scheduled configured-connector read-only occurrence passed against the configured provider and pinned native agent runtime.** This is live execution evidence, not generated fixture output. The connector run's successful persisted evidence was verified after the live rig's overly broad history assertion rejected harmless built-in discovery; raw verifier flags are preserved below.

## Environment and scope

- Node **24.21.0**, macOS **arm64**.
- Pinned project Codex revision **4a942885c8b4745757a9f86ad2075e16c42483c5**; real `agent-core/src/index.ts` and BusinessRuntime, not a fake runtime. Binary SHA-256 **c6db78556e768ab20def8c28ccaa5de3337ba910655790279e9af80538cf761c** was verified against the recorded build manifest after the pilot; the repeatable rig now enforces that match before inference.
- Real configured **claude-sonnet-5**, **anthropic** wire adapter, through the actual model gateway implementation. The enabled provider profile was read from the configured catalog; credentials stayed in memory/private temporary native configuration and were never printed or placed in the receipts.
- Isolated Mongo replica set, tenant/owner context and catalog; real automation service, current configuration checks, execution adapter, durable event ingestion, Mongo result projection and execution fence.
- Isolated native Temporal **CLI v1.9.1 / server 1.32.0**, SDK **1.24.0**. Native Schedule timing was used for the scheduled pilot.
- The first two occurrences used one minimal read-only agent configuration, owned by the isolated pilot owner, with no skills or connectors. Reviewed prompt: `Return exactly AUTOMATION_PILOT_OK. Do not use any tools or external actions.`
- The connector occurrence copied the existing configured `qlik` profile into the isolated database only, with explicit `user` scope, owner `pilot-owner` and one agent attachment. Native `enabled_tools` exposed only `get_apps`. The source legacy profile was neither migrated nor modified.
- No browser was connected. The first two occurrences invoked no tools. The connector occurrence performed one authorized read-only `get_apps` metadata query (`limit=1`, `offset=0`, `published="true"`) and harmless built-in discovery. No business mutations were requested or observed.

Existing source configuration/data was read only. The temporary recipe was explicitly enabled in the isolated stack, then paused after its single verified occurrence. Isolated services and native credential/workspace directories were removed after safe receipt extraction. Exact harmless output and sanitized correlation metadata remain in the checked-in receipts; the transient Mongo database was intentionally removed.

## Verification receipts

### Run now

[PILOT_RECEIPT.json](PILOT_RECEIPT.json) records the actual Workflow, root turn, session and stored result reference.

- Accepted: **2026-10-08T21:58:43.864Z**.
- Dispatch/start projection: **21:58:44.247Z**, **383 ms** after acceptance.
- Confirmed completion: **21:58:50.409Z**.
- API start through persisted outcome: **6,561 ms**.
- Outcome **succeeded**; stop state **stopped**; audit completeness **true**.
- Exact persisted result: **`AUTOMATION_PILOT_OK`**.

### Native scheduled occurrence

[PILOT_SCHEDULED_RECEIPT.json](PILOT_SCHEDULED_RECEIPT.json) records an actual native interval occurrence, not an application timer or manual native backfill. The product-valid one-minute interval began at an explicit whole-second future anchor. Only its first occurrence was allowed before pausing.

- Nominal scheduled instant: **2026-10-08T22:01:36.000Z**.
- Mongo admission: **22:01:36.068Z**.
- Dispatch/start projection: **22:01:36.335Z**.
- Exact native `turn.started`: **22:01:36.354Z**, **354 ms** after the scheduled instant.
- Confirmed persisted completion: **22:01:40.443Z**.
- Outcome **succeeded**; stop state **stopped**; audit completeness **true**.
- Exact persisted result: **`AUTOMATION_PILOT_OK`**.

The ledger retained admission, dependency check, dispatch intent/claim/receipt, exact root start, final message, root terminal event and outcome. Success was asserted from the correlated completed root, saved result reference, confirmed stopped state and exact persisted output. It was not inferred from submission acceptance or assistant prose.

### Native scheduled configured-connector occurrence

[PILOT_CONNECTOR_VERIFICATION.json](PILOT_CONNECTOR_VERIFICATION.json) records the passing post-run assertions over [the raw live receipt](PILOT_CONNECTOR_RECEIPT.json). The only attached connector was the explicitly owner-scoped isolated copy of configured `qlik` profile `6aaa7db671c8cc9e29e08d93`; only its read-only `get_apps` tool was exposed.

- Nominal scheduled instant: **2026-10-08T22:12:47.000Z**.
- Exact native root start: **22:12:47.308Z**, **308 ms** after the scheduled instant.
- Exactly one correlated `get_apps` start: **22:12:54.558Z**; completion **22:13:00.142Z**, native status **completed**.
- Confirmed persisted root completion: **22:13:03.625Z**.
- Outcome **succeeded**; stop state **stopped**; audit completeness **true**.
- Exact persisted result: **`AUTOMATION_CONNECTOR_PILOT_OK`**, with the exact root result reference and expected tenant/owner.

The model first attempted optional built-in `list_mcp_resources` discovery, which failed, then invoked the configured `get_apps` tool successfully. Two real connector occurrences produced successful tool/root evidence, but the first verifier rejected any discovery and the second counted discovery as a connector invocation. Their raw `passed:false` verifier flags remain intact in [attempt 1](PILOT_CONNECTOR_ATTEMPT1_RECEIPT.json) and [attempt 2](PILOT_CONNECTOR_RECEIPT.json). The corrected post-run checks passed for attempt 2: exact scoped connector identity, one actual `get_apps` start/completion in the same root, accepted harmless sentinel, stopped state and complete audit. The repeatable rig now filters history by connector server/tool. It was not rerun a third time; no response-content hash or application metadata was retained.

## Reproduction

The opt-in rig reads the existing configured catalog and uses isolated execution state. It refuses provider use unless `AUTOMATION_LIVE_PILOT=on`; operators must have authorized real inference before running it. `PILOT_MODEL_PROFILE_ID` optionally chooses a permitted configured profile without exposing its credentials.

```sh
AUTOMATION_LIVE_PILOT=on npm --prefix platform exec -- tsx /absolute/path/to/platform/test/automation-live-pilot.rig.ts
AUTOMATION_LIVE_PILOT=on PILOT_TRIGGER=scheduled npm --prefix platform exec -- tsx /absolute/path/to/platform/test/automation-live-pilot.rig.ts
AUTOMATION_LIVE_PILOT=on PILOT_TRIGGER=scheduled PILOT_CONNECTOR_ID=6aaa7db671c8cc9e29e08d93 npm --prefix platform exec -- tsx /absolute/path/to/platform/test/automation-live-pilot.rig.ts
```

This rig is deliberately outside the automatic unit-test glob so normal checks do not incur provider charges or perform unrequested live execution. Two setup attempts were rejected before agent dispatch because the rig initially omitted required API request fields; those were corrected. Neither rejected setup executed a model run or produced business effects.

## Limits and remaining acceptance evidence

This verifies live browser-independent Run now and one native scheduled read-only root result. The scheduled lag was comfortably under thirty seconds for **one isolated recipe**. It is not a capacity benchmark, a sustained-load result or a production latency guarantee.

The configured read-only connector acceptance pilot passed as documented above. `qlik` initialize and tools/list returned HTTP 200 before selecting the read-only tool. The other configured `btp` endpoint timed out during initialization; it was not attached or invoked. Existing legacy records remain unchanged. This does not establish availability of every connector or authorization for business mutations.

The real Temporal Schedule/workflow tests separately cover control CAS, DST, cancellation/deadlines, replay, restart, resume without backfill and distinct failed occurrences. The pilot did not perform production deployment, image startup, server-persistence outage/restore, backup drills or a multi-tenant rollout. Those remaining gates are documented in [CAPABILITY_REPORT.md](CAPABILITY_REPORT.md) and [the operations runbook](../../../deployment/automations/RUNBOOK.md).
