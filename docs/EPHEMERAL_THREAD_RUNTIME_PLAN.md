# Truex: active-only VMs with durable external conversation state

Planning date: 3 October 2026. This is the current proposed default after the user's clarification: close inactive conversation VMs and keep state outside the runtime provider. It supersedes the seven-day warm-volume default in `THREAD_STATE_DEPLOYMENT_PLAN.md`. No infrastructure or runtime code has been changed.

## Decision

A saved conversation owns durable state, not a permanently allocated VM or disk. A VM is leased to one root conversation during execution and a short idle grace period. When the thread is safely inactive, publish a verified portable checkpoint, then delete its compute and temporary provider disk. On the next input, provision a compatible VM, restore the checkpoint, and resume the same Codex thread ID.

Keep a proposed 30–120 second idle grace, initially 60 seconds, to avoid recreating the VM between closely spaced turns. Do not retain warm state for days by default. A paid fast-resume pool or a provider's included paused storage can be an optional measured optimization, not the correctness boundary.

MongoDB supplies product history, permissions, routing, commands, and manifest pointers. S3-compatible object storage supplies canonical runtime checkpoints and artifacts. Runtime execution uses a local filesystem. The previous large storage totals modeled a reserved disk per retained conversation for the entire month; that is a different retention architecture.

## State layout and responsibilities

| Data | Durable location | During execution |
| --- | --- | --- |
| User-visible chat and plans | Existing tenant MongoDB | Read/write through platform |
| Input journal and runtime ownership | Tenant MongoDB | Controller lease and command dispatch |
| Canonical Codex history, SQLite state, helper history | Immutable checkpoint objects | Restored local runtime home |
| Business thread marker and workspace metadata | Included in checkpoint; indexed manifest | Fixed paths under runtime home |
| Uploaded/generated artifacts | Immutable authorized object keys | Workspace copies or explicit materialization |
| Image, binaries, libraries | Versioned base image | Provisioned from image, not downloaded in each checkpoint |
| RAM, process IDs and sockets | Not required for ordinary next-turn continuity | Ephemeral; reconstruct after boot |

The runtime home remains `/data/codex/business-v1`, preserving absolute workspace paths. Initially checkpoint the complete private home, including SQLite/WAL state and helper dependencies. Do not omit files based only on names. Exclude immutable image contents; identify temporary/rebuildable paths only after the recovery test proves their omission safe.

Visible MongoDB messages are not a replacement for canonical engine history. A provider-neutral checkpoint restores what Codex currently expects on disk. Object storage is not mounted as the live SQLite database.

## Next-turn activation

1. Validate tenant/user access and durably insert the command keyed by session and client ID.
2. Acquire the session's distributed ownership lease and epoch. Reuse a live owner during its grace period if available.
3. If no live owner exists, create a VM from the session's pinned image. Use operation labels and reconcile uncertain provisioning outcomes before creating again.
4. Obtain a short-lived, scoped restore grant. Download the published manifest and required objects into a staging filesystem, validate tenant/session/root, hashes, image/schema compatibility, file permissions, and paths.
5. Install the restored home at its fixed path before launching agent-core/Codex. The supervisor performs this bootstrap; the engine cannot start against an incomplete home.
6. Bind the adapter to the root session and current owner epoch; load fresh model/MCP authorization from the stored conversation owner.
7. Call the existing `thread/resume` path with the saved root thread ID. Reconcile canonical items, pending durable records, and uncertain prior commands.
8. Dispatch the new input exactly once when prior acceptance is known. Stream execution via the platform. Show `provisioning`, `restoring`, and `running` status asynchronously.

The platform session and root thread IDs remain stable; VM identity and endpoint can change on every activation. Never infer permission to run a second owner from lease expiry alone. Stop or fence the previous owner before takeover.

## Completed-turn export and VM removal

1. Complete the turn and persist/ack the adapter records in MongoDB. Browser closure is not an idle criterion.
2. Wait for the short grace period. Cancel the idle transition if another command arrives before the mutation gate closes.
3. Under the ownership lease, block turn admission, uploads, tools, sweepers, and all workspace mutations. Check helpers, pending questions/approvals, tools and automatically continuing goals.
4. Stop Codex and adapter writers; the supervisor must await their confirmed exit and closed files. The current SIGTERM handler is not a verified export transaction.
5. Package the complete consistent private home. Validate its databases and inventory. A per-database SQLite backup alone does not synchronize the entire filesystem.
6. Upload immutable objects and a manifest containing root/helper IDs, fixed paths, image digest, engine/schema versions, epoch, completed-turn boundary, hashes, sizes and encryption reference.
7. Publish the manifest pointer using a MongoDB compare-and-set against the current epoch and predecessor checkpoint. Record `lastCheckpointTurnId` and `lastCheckpointAt`. A completed product message is distinct from this published runtime recovery boundary.
8. Only after publication succeeds, destroy the sandbox and explicitly release/delete any separately billable disk or snapshot. Confirm provider resource state; clear the live endpoint and mark the registry `cold`.

Checkpoint failure keeps the existing VM/state available for retry. A timeout deleting a VM leaves a resource-reconciliation task; it does not authorize a second writer. A new command arriving during export waits for export/delete or is handed to the retained owner after admission is reopened under the same lease.

Initially keep pending approval/question workflows awake because their transient RPC state is not fully represented in a disk checkpoint. Persisting and reconstructing these waits is a separate improvement. Continue actual background/goal work even without an open browser.

## Checkpoint granularity and artifacts

The pilot uses compressed full bundles from a freshly isolated home. That is the simplest way to prove correct same-thread restore. Measure actual bytes, upload/download time, and model/tool latency before selecting an idle grace.

Before broad rollout, separate large artifact payloads from the engine checkpoint. Publish authorized artifact objects and include metadata/checksums in the manifest. The current file tools expect local payloads: add materialization support before omitting those payloads. Preserve full local workspace semantics until the new read/write path is tested.

Next implement manifests over immutable, content-addressed chunks/files. A new checkpoint references unchanged objects and uploads only changed data. SQLite files need consistent backup/checkpoint boundaries before chunking. Keep required parent objects alive while any retained manifest references them. Garbage collection must account for concurrent publication and restores.

Incremental uploads reduce upload traffic; a brand-new VM may still need to download all working state. Reduce restore bytes with a clean shared image and tested artifact materialization. Any cross-activation cache must preserve tenant isolation and is not the durable state authority.

A blanket TTL must not delete unexported runtime data or checkpoint dependencies. Product deletion and retention rules apply across MongoDB, object versions, files, provider resources and backup generations.

## Recovery limits

A committed checkpoint is the reliable disk recovery boundary. If a VM disappears mid-turn, the prior checkpoint remains, while newer canonical context or workspace changes may be lost. MongoDB may contain newer product messages that cannot transparently reconstruct that state.

Record uncertain accepted commands and business-write outcomes. Do not automatically replay external mutations after restoring an older checkpoint. Recover/resume from the known boundary only after outcome reconciliation. If the product requires durable mid-turn context, add canonical journaling/export support rather than claiming completed-turn checkpoints cover it.

The pinned source has a `ThreadStore` trait, with local JSONL/SQLite and in-memory implementations (`vendor/codex/codex-rs/thread-store/README.md`). A future remote store could persist canonical history and metadata incrementally to a database/object journal, but it requires engine integration and testing. Goals/queues/memory, markers and workspace state must also be addressed. This is not implemented and is not equivalent to changing `CODEX_HOME` to an object-store URL.

## Three implementation options

| Option | Benefit | Work/tradeoff |
| --- | --- | --- |
| Portable checkpoint + recreate | Smallest engine change; provider portability; active-only resources | Boot/restore latency and checkpoint traffic |
| Native provider standby for a short window | Fast recent-thread continuation | Snapshot charges, quota consumption and provider coupling; verify reconnects |
| Remote canonical `ThreadStore` plus artifact service | Incremental durable engine state; potentially smaller restore path | Rust/storage integration plus broader runtime state migration; later phase |

Choose the first as default. Use the second only when measured extra cost buys needed latency. Pursue the third if checkpoint transfer or recovery latency dominates at representative load.

## Revised storage economics

Backblaze B2 is an example S3-compatible non-hyperscaler object store: standard published storage is $6.95/TB/30-days, with free download egress up to 3× average stored bytes and $0.01/GB above it. Use actual region and traffic terms when quoting. [B2 pricing](https://www.backblaze.com/cloud-storage/pricing).

Illustrative retained-state assumptions, including two full checkpoint generations but excluding separately published artifacts:

| Scenario | Retained conversations | Compressed checkpoint per conversation | Total stored checkpoints | Monthly storage |
| --- | ---: | ---: | ---: | ---: |
| Best | 1,000 | 100 MB | 200 GB | $1.39 |
| Conservative | 3,000 | 200 MB | 1,200 GB | $8.34 |
| Heavy | 10,000 | 1 GB | 20 TB | $139 |

These are assumptions, not measured Truex sizes. RAM allocation and provisioned disk capacity do not equal compressed checkpoint bytes. Additional generations, artifact payloads, logs and dependencies increase retained bytes. Active provider disks remain billable where applicable, but exist only during activation and export.

### Conservative compute and active-disk example

Assume 1,000 users, 60 activation cycles/user/month, and 10 total execution hours/user/month. This produces 60,000 activation cycles and 10,000 execution VM-hours. Assume 30 seconds boot/restore/export plus 60 seconds grace per activation: 1,500 additional hours, or 11,500 billed hours total. These times are hypothetical, not provider latency promises.

| Provider | Compute | Active-only provider disk | Plan | B2 checkpoint capacity | Subtotal before transfer |
| --- | ---: | ---: | ---: | ---: | ---: |
| Northflank | $766.59 | $9.58 | $0 | $8.34 | $784.51 |
| Daytona | $1,904.40 | $9.94 | $0 | $8.34 | $1,922.68 |
| E2B Pro | $1,904.40 | Included | $150 | $8.34 | $2,062.74 |
| Blaxel | $1,904.40 | $3.83 | $0 | $8.34 | $1,916.57 |
| Runloop Pro | $3,643.20 | $31.50 | $250 | $8.34 | $3,933.04 |

Other providers use 2 vCPU/4 GB or GiB; Blaxel uses 4 GB and automatically assigned CPU, so equal RAM is not equal CPU performance. Active disk assumptions: Northflank 4 GB, Daytona/Runloop 8 GiB/GB, Blaxel 2 GB. Model active-only disk billing using published rates over resource existence; verify rounding/minimum charges and successful disk deletion. Do not deduct free storage allowances until account applicability is established. Brief native snapshot storage, image storage, network traffic, quota packages and support are outside these subtotals.

Rate sources: [Northflank](https://northflank.com/pricing), [Daytona](https://www.daytona.io/pricing), [E2B](https://e2b.dev/pricing), [Blaxel](https://blaxel.ai/pricing), [Runloop](https://runloop.ai/pricing). Higher concurrency packages may be required independently of the user count.

### Transfer can replace the disk bill

If every one of 60,000 activations downloads and uploads a full 200 MB checkpoint, monthly traffic is approximately 12 TB downloaded and 12 TB uploaded. With 1.2 TB stored, B2's modeled free download allowance is 3.6 TB; the remaining 8.4 TB costs approximately $84. Provider upload egress is a separate charge: at Northflank's published $0.06/GB, uploading 12 TB costs approximately $720. The Northflank illustrative subtotal then becomes approximately $1,588.51 before other costs.

At 20 MB per activation with corresponding two-generation retained size, the same model is approximately $857.41 using unrounded component costs: $766.59 compute, $9.58 active disk, $0.834 object capacity, $8.40 object download overage, and $72 provider upload egress. At 1 GB full checkpoints, traffic may dominate. Count bytes and activation cycles rather than assuming external state storage is free.

Checkpoint reuse during a grace period, incremental uploads, separately published artifacts and compatible low-egress network paths can reduce traffic. Do not subtract a transfer saving before a real workflow demonstrates it. E2B/Daytona/Runloop provider egress terms still need confirmation; Blaxel's pricing page lists internet egress as included.

The full model is:

```text
runtime bill = execution + boot/restore/export/grace compute
             + temporary disk while resources exist
             + external checkpoints and artifacts
             + checkpoint download and provider upload traffic
             + plan / quota fees
```

MongoDB, application services, model tokens, taxes and contingency are additional.

## Implementation sequence

1. Prove an offline full private-home checkpoint restores into a different filesystem/VM with the same root thread ID, workspace and helper dependencies. Use a fresh test conversation, not a copy of the shared legacy home.
2. Add registry leases/epochs and durable commands; route through `ensureRuntime` and show asynchronous lifecycle states.
3. Add supervisor restore/export, immutable manifest publication, and explicit provider resource deletion/reconciliation. Test upload failure, crash after publication, lost delete response, and concurrent new messages during export.
4. Replace historical-session polling and idle runtime SSE with MongoDB/object read paths; keep ingestion only for active/dirty owners. Publish files independently.
5. Measure full checkpoint bytes and activation cycles on Northflank, Blaxel and E2B. Select using end-to-end restore correctness, network cost, image compatibility, time-to-first-token and account quotas. Native Blaxel archive is not a required dependency; its documentation currently labels it private preview, so this plan uses our portable export path.
6. Before growing the fleet, add tested incremental uploads and artifact materialization if full transfer costs justify them. Raise capacity by active/waking owners and queue age.

Legacy conversations remain on existing shared owners until selective export/import is proven. Current shared SQLite state must not be duplicated into separate tenant/session VMs.

No runtime code or infrastructure was changed; all lifecycle actions above are proposed implementation behavior.
