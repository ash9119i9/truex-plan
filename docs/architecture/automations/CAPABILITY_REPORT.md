# Automation capability evidence

Updated 9 October 2026. This records development evidence and limits; it does not certify a production rollout or a real agent/connector pilot.

## Temporal environment and pinned versions

- TypeScript SDK client/common/proto/workflow/worker/testing: **1.24.0**, exact dependencies in `platform/package.json` and lockfile.
- Isolated native Temporal CLI: **v1.9.1**, server **1.32.0**. The integration harness downloads the pinned CLI through `@temporalio/testing.createLocal`; it uses the real Temporal server, not the Java time-skipping test server.
- Tested locally on macOS arm64, Node **26.7.0**. Docker daemon was unavailable; no production infrastructure or business agent execution was used.
- Integration command: `npm --prefix platform run test:automation:temporal`. Pure adapter checks: `npm --prefix platform exec -- tsx --test test/automation-temporal.test.ts`. Platform TypeScript build: `npm --prefix platform run build`.

## Verification receipts

- Final isolated Temporal integration run: **10/10 passed**, final repeat 20.80 seconds; no skipped tests. This includes the disk-backed native server restart drill below.
- Final focused adapter tests: **3/3 passed**.
- Platform TypeScript build passed, including worker packaging and reconciliation integration. The root verification record owns the final whole-platform build result.
- `npm --prefix platform audit --json` reports two high-severity advisories in the existing Nest platform-express → multer chain. No Temporal dependency advisory was reported; this audit is not a full security assessment.

## Proven native capabilities

The checked-in isolated integration suite verifies:

1. `ListScheduleMatchingTimes` previews an anchored fixed-rate interval using Temporal's own engine. Previewing creates a temporary paused Schedule and removes it afterward; no application recurrence timer is used.
2. A New York Sunday 02:30 calendar skips the spring DST gap. A Sunday 01:30 calendar returns both instants during the fall repeated hour. Preview and execution therefore share native timezone semantics.
3. Native Schedule actions start the finite automation Workflow. `TemporalScheduledStartTime` supplies the exact nominal action instant independently of Workflow start time, and the emitted Workflow history replays successfully.
4. Worker shutdown/restart resumes observation of the same Workflow and does not repeat completed admission or dispatch Activities. This synthetic test proves Temporal coordination, not runtime/provider exactly-once mutations.
5. The Workflow performs bounded Activity retries for idempotent admission/observation/stop; native submission is attempted once. Dispatch ambiguity invokes the stop/reconciliation boundary. Whole-Workflow retries are disabled.
6. A configured deadline and cancellation invoke safe stop. Deadline expiry races in-flight dispatch/observation instead of waiting for them to finish. A late native Activity completion may produce the SDK's expected “workflow execution already completed” warning; the business execution fence and stop evidence remain the domain's responsibility.
7. Repeated manual start after completion uses `REJECT_DUPLICATE`, retaining the original Workflow execution rather than silently creating a second execution with the same ID.
8. Native policies explicitly use `ALLOW_ALL`, a ten-minute catch-up window, and `pauseOnFailure: false`. Separate failed synthetic business occurrences retain distinct identities while recurrence stays enabled. Mongo admission owns the cross-source agent execution fence and records skips.
9. Native pause/resume skips the slots that elapsed while paused. It does not silently backfill them. The probe uses a one-second synthetic cadence solely to keep the real-time test bounded; product contracts require at least one minute.
10. Control synchronization uses the public `UpdateSchedule` conflict token, with bounded retries and a monotonically increasing control version. Two independent clients converge on the newer version, and a delayed older edit cannot overwrite it. Native action arguments carry the control version so admission/dispatch can also reject old queued actions.

## Spike findings that changed implementation

- Native Schedule interval phases have whole-second resolution on the tested server. A `12.345` second anchor was observed at `12.000`, so product validation rejects sub-second anchors and interval lengths rather than silently changing the saved cadence.
- `ScheduleHandle.update` in SDK 1.24.0 describes then updates **without transmitting the conflict token**. Local serialization alone would not protect against multiple workers. The adapter uses the supported raw service API's conflict token and preserves unrelated native action fields.
- Native calendar year range is limited to the server's supported range. An omitted year list means all supported years; the raw update must not invent an unsupported 1970–9999 range.
- Temporal timer wake-up is subject to server/task-queue latency. In the isolated test, an 80 ms timer was delivered around a second later. Execution deadlines are durable coordination bounds, not a promise of millisecond real-time termination.
- Schedule matching-times is available on the tested real server and supports historical/future ranges for a **known specification**. This does not prove that the platform can reconstruct exact historical slots across arbitrary recipe edits and outages without retaining the applicable configuration.

## Disk-backed recovery drill

A further isolated native server test used `TestWorkflowEnvironment.createLocal({server:{dbFilename}})` to write a real SQLite database. After a synthetic Workflow had completed admission/dispatch and entered observation, the first worker and server were shut down. A new server process loaded the same file on a new port. The paused native Schedule and its control-version note survived; the Workflow retained the exact Temporal run ID and RUNNING status; a replacement worker completed observation without another admission or dispatch (**one each**). The recovered history also replayed successfully. The focused drill passed in 3.8 seconds on Node24.21.0/arm64. This proves graceful disk-backed server restart; it does not claim unclean kill, PostgreSQL production restore or database-loss recovery.

A subsequent full-suite run concurrent with unrelated build/platform/core stress checks passed 9/10: the first disk-backed server failed the SDK's fixed five-second ephemeral startup readiness limit before emitting a native startup banner or reaching any Workflow assertion. No cached-download corruption or surviving Temporal process was found. The unchanged focused drill then passed **1/1**, no skips, in 3.84 seconds after the CPU-heavy checks settled. Resource contention is consistent with this observation but is not proven; the failing ephemeral process retained no diagnostic log. The final isolated full-suite rerun passed **10/10**, no skips, in **20.80 seconds** (`/tmp/truex-automation-final-temporal-isolated.log`), including the same persisted recovery assertions. No assertion, timeout or implementation was weakened.

## Audit and recovery limits

`ScheduleDescription.info` provides action count, exact recent action metadata, overlap-skipped count, and missed-catch-up-window count. Exact metadata exists for emitted actions; a missed-window counter is not an invented started run. The platform must persist counter deltas with known bounds and identify them as summaries. Control CAS, worker restart and graceful disk-backed native server restart are tested. An unclean persistence-server kill, a long outage exceeding the ten-minute product catch-up window, and PostgreSQL production backup/restore remain unproven by these isolated checks.

Runtime acceptance reconciliation, root-terminal/result evidence, audit-before-ack, current owner permissions, and unresolved execution fences are covered by the separate automation execution/evidence/store suites. The authorized [real agent pilot](PILOT_EVIDENCE.md) passed Run now, a native scheduled occurrence and a real owner-scoped configured `qlik` read-only connector occurrence: exact root results were persisted without a browser; scheduled nominal-to-root-start lag was 354 ms without a connector and 308 ms with the connector. The connector's native `get_apps` completion and accepted exact sentinel passed post-run assertions; raw live-rig verifier flags and optional failed discovery are documented separately. Sustained healthy-load measurement and production recovery remain pending for full acceptance.

No production image build, authenticated production Temporal endpoint, backup/restore, deployment, schedule activation for business mutations, or rollout occurred. The separately authorized live pilot performed harmless real model inference and a read-only metadata lookup in an isolated stack.

## Sources

- [Temporal ScheduleSpec](https://typescript.temporal.io/api/interfaces/client.ScheduleSpec): native interval/calendar and DST semantics.
- [Temporal ScheduleOptions](https://typescript.temporal.io/api/interfaces/client.ScheduleOptions): overlap, catch-up and failure-pause controls.
- [Temporal TestWorkflowEnvironment](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment): native isolated dev-server environment and its difference from time skipping.
- Installed pinned SDK declarations/source and the real native server tests supply version-specific evidence for conflict tokens, payloads, action metadata and replay.

## Packaging validation

The PostgreSQL-backed local Compose definition and standalone worker Dockerfile are under `deployment/automations/`, with a private-access/recovery runbook. Registry inspection confirmed digest-pinned Temporal server/admin-tools 1.32.0, PostgreSQL 16.13 and Node 24.21.0 image manifests, including arm64 and amd64. Compose configuration and shell syntax checks passed. The target-arm64 worker image build was attempted and failed because the Docker daemon socket was unavailable; container startup, PostgreSQL restore, production authentication and load measurement remain pending. Worker startup/configuration checks: **5/5 passed** on Node 24.21.0, including real standalone Mongo refusal. Targeted formatting and final platform compilation passed.
