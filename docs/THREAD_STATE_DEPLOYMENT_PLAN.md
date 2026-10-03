# Truex deployment: durable conversation state and thread resume

Planning date: 3 October 2026. This extends `AGENT_RUNTIME_DEPLOYMENT_PLAN.md` with the state ownership, wake-up, checkpoint, and recovery design. It is a proposal, not an implemented or benchmarked deployment. Provider documentation and prices were checked again for this plan. Monetary estimates exclude model tokens, shared services, traffic, taxes, support, and additional capacity packages.

**Superseded retention default:** [EPHEMERAL_THREAD_RUNTIME_PLAN.md](EPHEMERAL_THREAD_RUNTIME_PLAN.md) is the current proposal: checkpoint inactive conversations externally, destroy their VM and independently billable disk, and restore the same thread on demand. The retained-volume recommendation, seven-day warm period, provider shortlist and storage estimates below are an earlier comparison baseline. Use the new plan for the current lifecycle, pilot shortlist and active-only cost model; the state ownership and recovery requirements here still apply.

## Recommended decision

Start with one user-visible root conversation per managed CPU microVM, a private filesystem at a fixed path, and explicit controller ownership. Helpers remain inside their parent's VM. A conversation outlives both its running process and the individual VM used to execute it.

Use completed-turn disk recovery as the correctness baseline. Preserve process memory as an optimization when the provider supports it. Initially, do not sleep while a turn, helper, tool, approval, clarification, or automatically continuing goal still requires execution state.

Run the state pilot on **Northflank and E2B**. Northflank tests the cheaper compute plus persistent-volume route. E2B tests memory-preserving pause with provider-managed retained state and favorable published paused billing. Daytona Linux VM remains the explicit VM alternative. This changes the initial pilot shortlist from the earlier plan because retained conversation storage, rather than active compute alone, is now the selection priority.

Choose using measured total cost for the expected retained-to-active conversation ratio, completed-turn resume correctness, wake latency, portable restore correctness, region/network access, and account limits. Do not pick solely from the hourly CPU rate.

## Current implementation to preserve

- `platform/src/store.ts`: tenant MongoDB databases contain `sessions`, `messages`, and `traces`; shared catalog state is separate.
- `platform/src/service.ts`: a session saves `threadId` and `agentCoreHost`; new input resumes the saved owner before submitting `/turns`.
- `agent-core/src/index.ts`: one adapter creates one `BusinessRuntime`, defaulting to 20 admitted root threads. `CODEX_HOME` receives a `business-v1` suffix.
- `agent-core/src/business-runtime.ts`: thread markers hold tenant/workspace metadata, and resume reads the marker before calling Codex `thread/resume`.
- Codex thread storage: JSONL rollouts hold canonical history; SQLite holds queryable metadata and other state. Mongo messages are a product projection, not a complete runtime export.
- `agent-core/src/manager.ts`: durable adapter records are written before broadcast and retained until platform acknowledgement. Per-thread locks exist only inside that adapter process.
- Current signal handling drains for up to 30 seconds by default, then signals the Codex child. It does not provide a verified checkpoint/export transaction or wait-for-child-exit export contract.
- `workspace-sweeper.ts` deletes temporary work by default. Whole-workspace expiration is opt-in through `WORKSPACE_TTL_DAYS`; leave it unset until archive-aware retention exists.

These foundations remain useful. Add a runtime controller and state lifecycle around them instead of replacing the engine or reconstructing conversations from visible messages.

## Deployment options

| Option | What survives inactivity | How the next turn starts | Assessment |
| --- | --- | --- | --- |
| Always-on conversation VM with private disk | Process and disk while healthy | Route directly to the loaded thread | Useful as the pilot baseline; expensive for inactive conversations. |
| Stop compute, retain private disk | Filesystem; processes must restart | Start adapter/Codex, then `thread/resume` | Recommended correctness baseline and Northflank route. |
| Pause a memory-preserving VM | Provider preserves process and filesystem snapshot | Resume VM, reconnect, verify ownership/configuration, then reuse or resume thread | E2B or Daytona Linux VM; optimize latency, still require disk recovery. |
| Destroy compute after portable checkpoint | Published recovery bundle plus artifacts | Create compatible VM, restore bundle, then `thread/resume` | Cold conversations and disaster recovery; implement after same-owner resume passes. |

Provider details checked in official documentation:

- **Northflank:** pause ends processes and terminal sessions. Attached-volume data remains; ephemeral files are lost. The managed CPU sandbox product uses microVM isolation. At 2 vCPU and 4 GB, published active compute is approximately **$0.06666/hour**; disk is **$0.15/GB/month**. Its product page advertises volumes starting at 4 GB; confirm available allocation and attach/restore restrictions in the selected region. [Lifecycle](https://northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes), [isolation](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank-cloud), [volumes](https://northflank.com/product/sandboxes), [pricing](https://northflank.com/pricing).
- **E2B:** pause retains RAM and filesystem indefinitely. Documentation says paused billing stops; the pricing page lists standard 10 GiB Hobby and 20 GiB Pro disk as free. Pro is **$150/month plus usage**, with 2 vCPU/4 GiB compute approximately **$0.1656/hour**. Treat included disk and standard paused persistence separately from optional storage products; verify retained sandbox/account limits. Network clients must reconnect. [Persistence](https://docs.e2b.dev/sandbox/persistence), [billing and limits](https://docs.e2b.dev/billing), [pricing](https://e2b.dev/pricing).
- **Daytona:** select **Linux VM**, not the default container class, for memory pause. VM pause preserves RAM/filesystem; paused billing retains reserved-disk charges. Active 2 vCPU/4 GiB compute is approximately **$0.1656/hour**; already-billable disk is **$0.000108/GiB/hour**. Existing VM snapshots are required for VM creation. [Classes and lifecycle](https://www.daytona.io/docs/en/sandboxes/), [billing](https://www.daytona.io/docs/billing), [pricing](https://www.daytona.io/pricing).
- **Blaxel:** automatic standby preserves process/filesystem state, but external network connections do not survive. Snapshot/volume storage remains billable. Its connection-driven activity model requires special attention to our SSE, poller, and background execution. Keep it as a later candidate after controller-owned sleep is proven. [Lifecycle](https://docs.blaxel.ai/Sandboxes/Overview).

Provider pause is an availability mechanism, not an independent backup guarantee. Validate node-loss behavior, retention terms, and export access. A memory snapshot does not provide exactly-once business operations.

## Storage ownership

| Layer | Authority | Location and lifetime |
| --- | --- | --- |
| Product records | Conversation identity, visible messages, access, commands, routing, checkpoint references | Existing tenant MongoDB; available without waking a VM. |
| Live engine state | Canonical Codex history, metadata, goals/queues/memory state, markers, helper history, workspace and unacknowledged records | One private VM filesystem. Never mounted read/write by two owners. |
| Recovery checkpoints | Immutable recoverable state at a declared boundary | Encrypted object storage independent of an individual sandbox; referenced from MongoDB. |
| Published artifacts | Uploaded/generated files and their user-facing metadata | Object storage with tenant/session authorization; view/download without waking Codex. Working copies stay in the workspace. |

Use a stable runtime layout:

```text
/data/codex/business-v1/
  sessions/
  archived_sessions/
  *.sqlite                 # and consistent WAL state where relevant
  business-threads/
  business-workspaces/
  adapter-records/
```

Mount or restore before starting the adapter. Keep `/data/codex/business-v1` and workspace paths identical across replacement VMs: markers and engine metadata can contain absolute paths. Preserve ownership and permissions.

For new one-conversation homes, retain the complete runtime home initially, including helper histories. Add separately configured writable paths to the inventory. Do not optimize the recovery bundle into just one rollout file until the pinned engine's dependencies have been proven.

Object storage holds checkpoint objects; it is not the live SQLite mount. SQLite WAL requires same-host coordination and does not support a shared network filesystem. SQLite's backup API can produce consistent copies of individual databases, but that alone does not make a whole runtime checkpoint consistent across databases, JSONL, markers, and workspace files. [SQLite WAL](https://www.sqlite.org/wal.html), [backup API](https://www.sqlite.org/backup.html).

Backblaze B2 is a non-hyperscaler object-storage candidate for this layer. Published standard storage starts at **$6.95/TB/month**. Measure region latency and transfer costs; this is an archive/backup proposal, not a benchmarked live state backend. [Pricing](https://www.backblaze.com/cloud-storage/pricing).

## Registry and command records

Keep the product `sessionId` and Codex root `threadId` stable when replacing compute. Provider `sandboxId`, endpoint, and owner generation may change.

Add a tenant-scoped `runtime_instances` collection with one unique current binding per session:

```json
{
  "sessionId": "sess_example",
  "threadId": "codex_thread_example",
  "provider": "northflank",
  "sandboxId": "provider_identifier",
  "state": "sleeping",
  "imageDigest": "sha256:immutable_release",
  "codexRevision": "pinned_revision",
  "storage": {
    "mode": "private-volume",
    "volumeId": "provider_volume_identifier",
    "mountPath": "/data"
  },
  "checkpoint": {
    "id": "checkpoint_example",
    "manifestKey": "tenant/session/checkpoints/id/manifest.json",
    "boundaryTurnId": "last_completed_turn",
    "ownerEpoch": 12
  },
  "ownerEpoch": 12,
  "leaseOwner": null,
  "leaseExpiresAt": null,
  "lastActiveAt": "timestamp"
}
```

Also record desired/observed lifecycle state, operation ID, checkpoint age/size, dirty-record indicator, state schema versions, and errors. The controller resolves authenticated endpoints from provider identity; the browser cannot supply owner URLs. Retain `agentCoreHost` for legacy sessions during migration.

Add durable `runtime_commands` keyed uniquely by `(sessionId, clientId)`, containing input, order, ownership epoch, dispatch state, accepted `turnId`, and timestamps. States: `queued`, `waking`, `dispatching`, `accepted`, `completed`, `unknown`, `failed`.

Durably journal input before provisioning/waking. The existing HTTP timeout is not a wake-up budget. Return an asynchronous accepted/queued operation when necessary, then stream controller lifecycle status and execution events through the platform. Distinguish accepted-by-platform from accepted-by-Codex in the UI and records.

MongoDB-backed commands and compare-and-set ownership are sufficient for the initial controller; a separate queue service is optional. Tenant context must apply to every background read/write, as it does in current ingestion.

## First conversation

1. Validate tenant, user, agent, and project. Reserve `sessionId` and initial command durably.
2. Acquire the session's distributed operation lease and allocate a new owner epoch.
3. Provision the pinned image plus private state filesystem using session/operation labels. Reconcile uncertain create results before trying another create.
4. Start agent-core with `MAX_THREADS=1`, authenticated root/session binding, and fixed storage paths. The limit is root admission, not authorization or a helper-memory limit.
5. Check readiness only while the runtime is intentionally active. Call `thread/start` once and save its `threadId` using compare-and-set.
6. If the creation response is lost, inspect persisted ownership/root metadata before retrying. Provider-create idempotency alone does not prevent duplicate engine threads.
7. Dispatch the journaled message and persist runtime acceptance. Execute and stream normally.
8. On completion, persist/ack adapter records. Begin the idle/checkpoint policy below.

## Next message on an existing conversation

1. Read the session and registry; enforce access; insert or recover the message command by `clientId`.
2. Obtain the operation lease. Concurrent wake requests join the same operation and ordered command stream.
3. Resolve the current owner:
   - Active: reuse the owner and verify generation.
   - Memory-paused: resume the same sandbox and reconnect network clients.
   - Disk-retained: start the same sandbox/volume and fresh adapter/Codex processes.
   - Cold: provision a compatible image, restore the last published bundle into a staging directory, validate it, then install it at the fixed path before startup.
4. Bind the adapter to the registry's current tenant/session/root and owner epoch. Refresh authorized configuration/credentials through the platform.
5. Call existing `/threads/{threadId}/resume`. A memory-restored loaded thread can take the warm path; a fresh process takes Codex `thread/resume` from the restored disk.
6. Reconcile canonical runtime items and outstanding adapter records against MongoDB. Establish whether prior commands were accepted before sending a retry.
7. Send the new command once. Idle threads use `turn/start`; intentional input to a running thread uses current `turn/steer` semantics.
8. Record acceptance and connect the live event stream. A changed SSE generation requires snapshot/history recovery rather than old cursor replay.

Opening a chat or downloading a published artifact should use MongoDB/object storage without waking the runtime. Only operations requiring execution or live engine state acquire/wake it.

## Single-owner guarantee

Existing `serial()` protects one process only. Add distributed leases, monotonically increasing owner epochs, and adapter validation on mutating requests. Lease expiry alone must not permit a second engine to run: the previous owner might still be executing while disconnected from the controller.

Before moving ownership, prove the old VM/process is stopped or fence it from runtime mutation and external writes. Revoke old scoped gateway/MCP credentials where supported, or route business mutations through a proxy that validates the current owner epoch. If the old owner cannot be fenced or stopped, keep the session unavailable rather than start a competing writer.

Persist the new epoch and storage/checkpoint binding atomically through compare-and-set. Heartbeat the lease during work. Serialize sleep, wake, checkpoint, fork, upgrade, and turn admission through the same ownership mechanism. A queued message cancels a pending idle transition or waits for it to finish.

## Sleep and checkpoint protocol

Proposed initial idle grace: **60 seconds after a completed, quiescent turn**. This is a tunable product choice, not a measured optimum. Browser presence alone should not keep execution awake.

Eligibility requires no running/starting/interruption transition, active helper/tool/background write, pending approval/question, automatic goal continuation, queued command, or upload. Durable adapter records must be acknowledged first. A lack of tokens or low CPU is not evidence of idleness.

For the initial disk-first checkpoint implementation:

1. Under the lease, close admission and enter `checkpointing`. Gate uploads and other workspace mutations too.
2. Drain execution; ingest/ack final adapter records. If persistence fails, remain awake and retry rather than release the only state copy.
3. Stop Codex and the adapter through a supervisor that waits for confirmed process exit and closed writers. The current signal handler alone is not the export boundary.
4. Export the complete private home from the stable filesystem using the still-running supervisor or a documented volume export facility. Preserve any required SQLite WAL data; do not copy only `.sqlite` files from live writers. Verify databases, inventory, and file hashes.
5. Write an immutable bundle and manifest to object storage. The manifest records tenant/session/root/helper IDs, image digest, Codex revision, schema versions, absolute paths, last completed turn, checksums, sizes, epoch, and encryption key reference. Redact manifest metadata; protect bundle contents as sensitive runtime state.
6. Publish its pointer in MongoDB only after upload and validation succeed. Keep the previous good checkpoint until the new checkpoint has passed the release's restore validation policy.
7. Pause compute, retaining the private volume, and wait for confirmed provider state. If pause fails, reconcile observed state and billing. The registry must not claim `sleeping` merely because a request was sent.

This baseline stops processes, even on a RAM-preserving provider. It intentionally proves portable disk recovery first. The supervisor/export transport is implementation work, not an existing endpoint.

Later, enable native memory pause for recent conversations while keeping a declared disk-backup schedule. To export without killing the warm engine, prove a whole-runtime freeze/snapshot or explicit storage export contract; per-database backup is insufficient. Record the actual portable-checkpoint age. Do not claim per-turn offsite recovery if backups are less frequent.

A process suspended during an external model/tool request cannot be assumed to resume its TCP connection or repeat a write safely. Keep those cases awake in the first release.

## Hot, warm, and cold retention

- **Hot:** active turn; full runtime retained. Count these for execution capacity.
- **Warm:** recent idle conversation; stopped private volume or provider-paused state, plus declared independent checkpoint coverage.
- **Cold:** portable bundle and published artifacts; no billable runtime volume unless the provider's included paused storage makes retention cheaper/easier.

Initial planning window: retain warm state for seven days. Change it based on reopen frequency and measured cost. Cold transition requires quiescence, a published recoverable checkpoint, artifact publication, and fenced ownership. Never delete state just because MongoDB contains visible messages.

Prefer retaining E2B paused sandboxes if the verified account terms make this cheaper than exporting/recreating them; independent backups still have value. For Northflank/Daytona, minimum reserved disk size can make cold export economically important.

Use independent object keys for artifact payloads and authorized metadata. Preserve workspace copies until the bundle/artifact references guarantee recovery. Apply actual product retention/deletion rules to bundles, snapshots, artifacts, and provider resources together.

## Failure behavior and recovery promises

| Failure | Required behavior |
| --- | --- |
| Browser disconnect | Continue active turn and durable ingestion; later reload/reconnect. |
| Platform/controller restart | Recover commands and leases; inspect owner before dispatching. |
| Wake/create timeout | Reconcile operation/provider labels; do not allocate duplicate owners. |
| Crash after engine acceptance but before Mongo acceptance | Inspect runtime items using `clientId`; retain `unknown` if evidence is insufficient. |
| Runtime process crash, volume intact | Fresh process + same thread resume; preserve uncertain in-flight operation status. |
| Runtime disk/provider state loss | Restore latest published portable checkpoint; disclose checkpoint boundary and potential newer runtime-state loss. |
| Export interrupted | Ignore incomplete/unpublished objects and use last good checkpoint. |
| Old owner unreachable during takeover | Fence/stop it or block takeover. |
| Incompatible engine/schema | Restore the pinned image, or perform tested quiescent migration from a protected backup. |

Promise durable receipt of a user command only after its journal write succeeds. Promise a portable recovery boundary only after checkpoint publication. A retained volume's durability depends on provider guarantees; a local atomic rename is not proof against physical disk loss. Verify fsync/flush behavior for rollouts, databases, and record handoff before claiming zero loss on node failure.

Targets: completed checkpoint restore succeeds with the same root thread ID and workspace; acknowledged product records remain in MongoDB; no known accepted command is dispatched twice. Exactly-once external mutations require connector idempotency or outcome reconciliation. Do not automatically rerun business writes after ambiguous failures, even if restoring an older checkpoint would make them look unfinished.

Replaying later MongoDB messages into a restored old checkpoint is not transparent runtime recovery: it can change context and repeat tools. If necessary, offer an explicit recovered/forked conversation after outcome reconciliation rather than silently claiming exact continuity.

## Changes mapped to the repository

| Area | Work |
| --- | --- |
| `platform/src/store.ts` | Add runtime registry, commands, checkpoint/artifact metadata and tenant-scoped unique indexes. |
| New platform runtime-controller/provider modules | Implement capabilities-aware create/inspect/start/pause/stop/export/delete, leases, reconciliation and admission. |
| `platform/src/service.ts` | Route through `ensureRuntime(session)` instead of static hosts for new sessions; journal before wake; preserve legacy routing. |
| Platform events route | Stream controller lifecycle status, attach runtime SSE only during active execution, and recover snapshots after wake. |
| `startIngestion()` | Ingest active/dirty owners only; never application-poll every historical sleeping session every two seconds. |
| `agent-core/src/index.ts` / `manager.ts` | Root binding, epoch authentication, lifecycle eligibility, durable flush/export handshake, and explicit readiness identity. |
| `agent-core/src/client.ts` | Confirm child exit and manage restart without relying only on fire-and-forget SIGTERM. |
| Runtime image / supervisor | Pinned release, fixed filesystem, restore before boot, coordinated checkpoint/export, signal handling. |
| `file-tools.ts` / platform artifact routes | Durable object publication and read paths that do not wake the VM. |
| Fork path | Codex fork at a safe boundary and restore that fork into an independently owned VM; never clone a running writer. |
| Workspace sweeper | Make permanent-state deletion depend on verified lifecycle/retention metadata. |

Do not give conversation VMs MongoDB administrative credentials or provider-control keys. Scope model/MCP credentials to authorized owner and session, handle refresh after wake, and keep provisioning credentials in the controller. Retain the existing script execution boundary; leave `run_script` disabled for the pilot unless its separate sandbox path is validated.

## Legacy conversation migration

Current `business-v1` homes are shared across root conversations. Copying a whole legacy home into each new conversation VM would duplicate other conversations' state, metadata, workspaces, and potentially secrets.

Phase one provisions isolated homes for **new sessions only**. Existing sessions continue using static legacy owners and their retained disks. Do not decrease old adapter capacity to one while it owns multiple sessions.

Later build a supported selective export/import for the pinned engine, including root/helper dependencies, metadata/state tables, markers, paths, queues/goals/memory, workspace and pending records. Prove that another tenant's records cannot appear in the export or restored APIs. Replaying visible messages is not equivalent. If supported selective export is unavailable, retain legacy owners rather than hand-editing production SQLite into an unproven bundle.

## Cost and scaling model

Use:

```text
monthly runtime cost = active VM hours × active rate
                     + retained billable disk/snapshot capacity × storage rate
                     + plan/concurrency fees
                     + portable checkpoints and artifacts
                     + provisioning/restore/transfer overhead
```

Illustration: 10,000 retained conversations and 10,000 total active minutes/month, at 2 vCPU/4 GB or GiB. No credits or discounts:

| Scenario | Approximate monthly runtime subtotal |
| --- | ---: |
| Northflank compute only | $11.11 |
| Northflank plus an assumed 10 GB reserved volume for every retained conversation | $15,011.11 |
| E2B Pro compute plus base plan, within included standard disk and baseline active limits | $177.60 |
| Northflank with 100 warm 10 GB volumes and 9,900 cold bundles averaging 200 MB | $174.87 |

The last row is our calculation: $11.11 compute + $150 warm disks + approximately $13.76 for 1.98 TB of B2 checkpoint data. It excludes additional backup generations, artifacts, restored runtime hours, provider egress, and transfer overhead. Neither 10 GB minimum volumes nor 200 MB bundle sizes are measured assumptions. E2B included-disk/retained-count eligibility must be verified for this account. These examples explain why active compute price alone can give the wrong answer; they are not deployment quotes.

If active usage instead totals 100,000 minutes/month, compute becomes approximately $111.10 Northflank or $276 E2B/Daytona; E2B Pro adds $150. The retained-storage component does not shrink just because users send fewer messages.

Scale controller admission by active/waking conversations and queue age, not total saved sessions. Measure p95 wake and restore duration, bytes transferred per reopen, retained bytes versus provisioned capacity, active time including model/tool waiting, and pause transition billing. Provider create/start limits and model/MCP limits can bottleneck before CPU.

## Implementation sequence and acceptance

1. **Local recovery proof:** use a fresh isolated runtime home and the pinned release. Run multiple turns, tools, compaction where feasible, helpers, and file generation; stop writers, checkpoint, restore into a fresh filesystem at the fixed path, resume the same thread ID, and verify prior state through canonical items and actual files. Do not point the experiment at existing user runtime data.
2. **Provider state pilot:** run the same image/workload on Northflank CPU sandboxes and E2B. Measure start, disk resume, native pause/resume, export/restore, billing while idle, image constraints, artifact access, and account capacity. Use Daytona Linux VM if E2B requirements or deployment fit fail.
3. **Controller release:** implement registry/commands/leases/fencing, dynamic authenticated routing, single-root binding, active-only ingestion/SSE, and explicit wake UI. Test concurrent wakes and lost responses.
4. **Checkpoint release:** implement supervisor export and verified publication, replacement-VM restore, artifact publication and retention. Preserve a last good bundle and prove recovery after deleting only an isolated test sandbox.
5. **Cohort rollout:** 10 active isolated conversations, then 100 after reliability evidence. Enable new sessions by cohort; legacy sessions retain owners. Approvals/questions keep their VM awake initially.
6. **Optimization:** tune warm retention, enable proven memory-preserving pause, evaluate incremental backups and selective legacy migration, then raise capacity with provider approval.

Required evidence before production: same-thread context and files survive repeated sleep/wake; portable restore works into a different VM; two concurrent requests do not create two owners; sleeping conversations are not awakened by idle polling/SSE; ambiguous external writes are not repeated; tenant isolation holds after export/restore; acknowledged records and commands survive controller restarts; actual billable storage and active time match the model.

Estimated engineering allowance: 2–3 days for local/provider recovery proof, 1–2 weeks for controller and disk lifecycle, and about one further week for failure/load validation and cohort rollout. Cold export and legacy migration can extend this if the provider lacks suitable export APIs or the pinned engine needs a new selective storage interface.

No provider was provisioned, no runtime code was changed, and no deployment or restore benchmark was executed while writing this plan.
