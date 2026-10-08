# Automation runtime and evidence capability report

Updated 9 October 2026. This reports implementation and local verification; it is not evidence of a production deployment, a healthy-load timing result, or a configured business agent/connector pilot.

## Trusted unattended execution

Agent-core accepts an internal `automationPolicy` containing only `automationId`, `runId`, immutable numeric `revision`, and `promptRef`. It validates and persists that policy independently of the runtime protocol, restores it on cold resume, rejects changes, and confirms the exact stored object with `automationPolicyVersion: 1` on create and full/operational snapshots. The platform must require that confirmation before submitting a recipe; older runtimes silently ignoring these fields are unsupported.

The business profile permits an internal plan within the reviewed recipe without fresh plan approval solely because the work has multiple steps. Native permission requests, MCP elicitation, and required user-input requests are denied in code before business-profile defaults, approval-mode automatic decisions, or timeout recommendations. No pending unattended question is answered Approve/recommended. Interactive conversations retain their existing behavior.

Helpers are disabled in both the enforced profile and generic create/resume configuration. A detected unexpected spawn interrupts the root, requests the helper's shutdown, and denies helper tool/approval/input requests. Such an escape does not establish helper termination; the platform must retain the execution fence until that uncertainty is reconciled. Tracked goals and automatic goal continuation are disabled for automation profiles so the recipe has one finite root turn.

An automation interrupt persists a stop tombstone even when the loaded thread is idle. Later messages, tools, approvals, and input requests are denied, including after a restart. Only a loaded automation thread that has never accepted a root turn confirms `terminationEvidence: not_started` together with its exact trusted policy/version. Running, previously started, or cold/unloaded threads cannot make that claim. Interactive idle interrupts retain their existing conflict response.

## Durable records and ingestion

Automation final messages, exact root lifecycle, plan updates, blockers, and supported tool start/completion metadata are recorded without a subscribed browser. Automation spool files use private permissions, file synchronization, atomic rename, and directory synchronization. Existing acknowledgment removes spool records only after platform persistence. The platform stores restricted result text separately from the sanitized append-only automation ledger.

Automation final output records use insert-only persistence, so conflicting replay cannot replace a saved result's text or reference. Interactive final-message updates retain their existing behavior.

`automation.tool` records contain the item/root identities, phase, trusted tool/server name where supplied, safe status, optional success/error code, and effects marked unknown/unverified. Supported item variants are MCP calls, dynamic tools, commands, file changes, and collaboration calls. Raw arguments, tool results, prompts, and private reasoning are excluded from these tool records. Tool completion is not proof of a confirmed external business effect or compensation.

`automation.blocked` records contain a structural reason, request method, policy denial actor/source, and termination requested/unconfirmed evidence. Casual assistant prose does not classify a blocker. Native exact-root completion is labeled `terminationEvidence: runtime`; manager/watchdog/runtime-disconnect synthesized completions are labeled `unconfirmed` and cannot release the execution fence.

Evidence ingestion rereads and projects the run inside a MongoDB transaction, binds the first accepted root through a compare-and-set condition, and appends its deduplicated ledger event with the projection in the same transaction. Concurrent ingesters cannot replace that root with another early turn. Native terminal evidence is set once; late/synthetic replay cannot replace it. Audit-incomplete evidence remains sticky.

Persistence failure atomically marks the run's transient audit recovery state and blocks further dispatch for its definition. Successful replay repairs that state in a transaction only after rereading the run; permanent runtime evidence loss remains sticky. The definition is unblocked only if no run for that automation has pending recovery or permanent loss. Concurrent permanent-loss ingestion cannot be erased by a recovery retry.

The actual Activities record native Temporal Activity ID, Workflow run ID, operation, attempt number, and a started phase using the pinned SDK's Activity context. Event identity includes the native Activity and attempt; repeated persistence is idempotent. Separate observation Activities retain their own native attempt numbers rather than incrementing a synthetic retry counter. Payloads, task tokens, and credentials are excluded. Failure to persist a started-attempt receipt marks permanent audit loss where storage remains available. Stop still proceeds and then returns the audit error; a later native attempt does not reconstruct the missing earlier receipt.

An automation spool write failure stops admission and records an audit-incomplete control marker where storage remains writable. Restarted agent-core refuses new automation dispatch while such markers remain, while permitting resume/observation. Subsequent available evidence visibly carries `auditIncomplete: true`. A total storage failure cannot guarantee preservation of the failed record; it must remain incomplete/unknown, never be represented as a complete audit. Removing an incomplete marker requires an operator repair/review procedure; there is no automatic claim that missing evidence has been reconstructed.

## Receipt, termination, and business-result limits

There is no supported agent-core lookup by automation run/client operation ID that can recover an unknown thread/turn receipt. Provision/submit acceptance loss must remain unknown and fenced; retrying the native operation blindly is unsafe. Durable run/session identities do not themselves prove that a native turn started or completed. Runtime namespace/host identities should be saved before native provision and retained even when the response is lost.

An ordinary interrupt acknowledgment establishes only a request. The trusted idle-thread absence confirmation described above establishes no start; otherwise exact native root termination is required. A native exact-root completion plus a saved restricted result is necessary for generic success. Unexpected helper activity remains separately unresolved even when the root terminates. Cancellation and audit failure must preserve partial effects and uncertainty.

The implementation does not mechanically prove arbitrary business correctness. Recoverable optional-tool errors are audited without automatically failing a recipe. Distinguishing an unresolved required dependency from a recovered optional failure requires a configured structured recipe/result acceptance contract. Artifact-level completeness, provider-confirmed external effects, actual upstream model/configuration fingerprints, and production recovery drills require additional pilot evidence; the current tool metadata must not be presented as those proofs.

## Verification receipts

- `agent-core/test/automation-policy.test.ts`: 13 focused tests passed after recorded RED/GREEN cycles for denial before timeout/mode defaults, private durable evidence, immutable/resumed policy and version confirmation, prohibited helpers and goals, synthetic-versus-native termination, policy mutation controls, audit failure/restart admission protection, and stop-before-start tombstones and confirmation.
- `npm --prefix agent-core test`: 212 passed, no failures or skipped tests. This includes existing interactive behavior regressions. The runtime suites use controlled providers and test runtimes; they do not execute a real business connector pilot.
- Final isolated full-core rerun: 212 passed in 34.42 seconds, with no cancellations. A prior run concurrent with full-platform checks, native Temporal and the root build exposed two MCP fixture cleanup `ENOTEMPTY` errors and a workspace stress timeout. The MCP fixture now verifies native process exit before removing its temporary home, with a bounded wait; its three scenarios pass without weakening assertions. The unchanged 20,000-file sweeper stress passes in 3.71 seconds under isolated verification.
- `npm --prefix agent-core run build`: passed after the runtime changes.
- `platform/test/automation-ingestion.test.ts`: uses a real local MongoDB replica set and `PlatformService.ingest`, with a controlled owned-records/ACK transport. It exercises result/ledger persistence before ACK, restricted-content redaction, duplicate/conflicting replay, ledger and transaction failures without ACK, helper/synthetic exclusion, delayed exact-root results, immutable terminal evidence and output, audit incompleteness, concurrent root binding, strict reviewed-policy/root correlation, and atomic audit repair races. Combined with `automation-evidence.test.ts` and `automation-activities.test.ts`, 19 tests passed with no skips. The Activity tests inject safe native context metadata into actual Activity wrappers and cover idempotent retry/poll classification and stop behavior on audit failure.
- Existing platform persistence, history, public API, and tenant regression suites: 32 tests passed with no skips after automation-only output immutability; interactive updates remain covered.
- Whole-platform build/test, formatting, and integration receipts are maintained in the parent verification record. The separate [Temporal capability report](CAPABILITY_REPORT.md) records native scheduling and recovery evidence.

No production schedules, actual business-agent executions, connector mutations, or deployments were performed for these runtime tests.
