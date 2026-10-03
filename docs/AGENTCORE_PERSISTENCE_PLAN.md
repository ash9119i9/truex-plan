# Durable Codex state on AgentCore

Superseded for engineering implementation by the consolidated
[development specification](../development-spec.md). This file retains the
initial architecture discussion; keep ongoing requirements in that spec.

Status: proposed architecture; no runtime or AWS configuration changes applied.
Inspected: `deploy` at `a36c820`; vendored Codex matches the pinned revision
`4a942885c8b4745757a9f86ad2075e16c42483c5`. Date: 2026-10-03.

## Decision

Treat AgentCore compute and its ordinary disk as disposable. Keep Codex's
native state on a local filesystem while it runs. Persist coherent checkpoints
of the entire AgentCore runtime session's thread family to S3. Use existing
durable MongoDB for routing, checkpoint manifests, operation delivery state,
and writer ownership. Restore state before starting agent-core or Codex.

Managed AgentCore session storage at `/mnt/state` is an immediate mitigation
and a useful working cache. It is not the permanent conversation store.

Do not reconstruct normal Codex continuation from the MongoDB chat transcript.
Do not put every tenant/session into one shared `CODEX_HOME` on EFS.

## What the repository currently does

The local `main` architecture assumes a stable disk. `deploy` adds an
AgentCore transport and container entrypoint while retaining that persistence
assumption. There is no checkpoint store, restore step, or committed AWS
filesystem provisioning in this branch.

| Component                                     | Current behavior                                                 | Consequence after disk loss                                            |
| --------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `Dockerfile:82`, `agent-core/src/index.ts:28` | Actual business home is `/mnt/state/codex/business-v1`           | Setting a path does not provision durable storage                      |
| `platform/src/service.ts:1112`                | Creates and stores `agentCoreSessionId` for conversation routing | Same ID reaches replacement compute, but does not itself restore files |
| `platform/src/service.ts:1832`                | Fork copies the source's runtime session ID                      | Forks share one state family and must be checkpointed together         |
| `agent-core/src/business-runtime.ts:213`      | Truex thread marker stores workspace, tenant and capabilities    | Missing marker produces `LEGACY_SESSION` before Codex can resume       |
| `agent-core/src/manager.ts:563`               | Cold resume calls Codex `thread/resume` by ID                    | Missing rollout produces `THREAD_LOST`                                 |
| `platform/src/service.ts:1279`                | `THREAD_LOST` marks the session dead                             | Recovery needs to run before this permanent classification             |
| `agent-core/src/manager.ts:1323`              | Adapter records await Mongo ingestion/ack                        | Lost records can lose final messages or state updates                  |
| `agent-core/src/index.ts:67`                  | Health checks filesystem writability                             | Writable image-layer storage can falsely look healthy                  |

MongoDB has user messages and assistant finals, not the complete native Codex
continuation state. Model-visible tool results, compaction state, dynamic tools,
goals, lineage and workspace files need their native persistence too.

## State and identity boundaries

Keep these IDs distinct:

- Application session ID: one UI conversation (`sess_...`).
- Codex thread ID: one native thread, including fork/helper identities.
- AgentCore runtime session ID: one compute/state family, currently shared by
  an original thread and its forks.
- Checkpoint generation: one immutable, verified snapshot of that family.

Use a durable family identity independent of runtime version. Existing
`agentCoreSessionId` can be the initial family ID. Do not introduce a new ID on
each turn or after idle termination. A replacement runtime session, if ever
needed, must be explicitly mapped to that same durable family.

Persist the family record before invoking thread creation. Attach the returned
thread ID afterwards. This also gives recovery a durable handle if the
creation response is lost. Preserve existing `clientId` idempotency for turns;
add operation IDs for create/fork/upload and other mutations where needed.

The initial implementation applies to AgentCore mode. Direct local HTTP mode
currently supports multiple unrelated roots in one home; do not take one
whole-home snapshot per UI conversation there. It would duplicate unrelated
state and allow one restore to overwrite another conversation.

Persist the full owned business home as a family unit, with a documented
allowlist/exclusion policy for credentials and disposable caches:

- Native active and archived rollout files, including all referenced parent,
  fork and helper history. Follow lineage recursively.
- SQLite state that is authoritative, especially goals, queued work and
  history/lineage records. Do not assume every database is just a rebuildable
  index.
- `business-threads/` markers.
- `business-workspaces/` contents, including uploads, generated documents,
  visualizations, workspace files and their metadata.
- Unacknowledged `adapter-records/`.
- Other required state discovered by an inventory of the pinned binary.

`AGENT_WORKSPACE=/mnt/state/workspace` is not the active business workspace
root in the current implementation. Backing up that directory alone misses
the actual workspaces below the business home.

Restore at the same absolute paths: markers and runtime state contain `cwd`.
Rebuild current provider/MCP configuration through the platform; do not rely
on checkpointed short-lived tokens. Protect checkpoint contents as sensitive
conversation data, including credentials that might appear inside historical
tool payloads. Exclude standalone authentication/configuration secrets where
they can be regenerated without losing continuation semantics.

## Storage choices

AWS's [filesystem documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)
describes managed `sessionStorage` as preview storage that survives stop/resume,
but resets after 14 idle days and on runtime version updates. EFS and S3 Files
are customer-managed shared mounts requiring VPC connectivity. Mounts become
available during invocation, which the current lazy service startup already
accommodates. Managed session storage currently has a 1 GB limit; see
[AWS quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html).

Immediate configuration fragment for the deployed runtime, merged with its
existing runtime configuration:

```json
{
  "filesystemConfigurations": [
    { "sessionStorage": { "mountPath": "/mnt/state" } }
  ]
}
```

Check availability and the actual compute type in the target AWS account
before applying. An update can invalidate existing managed session data;
capture available existing state before changing the deployed runtime.

For production, use S3 object APIs for immutable checkpoints. An S3 Files
mount is a different service surface; asynchronous filesystem synchronization
is not the application's checkpoint commit protocol.

The pinned Codex source enables SQLite WAL (`state/src/sqlite.rs:282`).
[SQLite WAL documentation](https://sqlite.org/wal.html) rules out network
filesystems. Therefore mounting the entire unmodified home on EFS is not the
recommended design. Separating local SQLite from durable raw files is possible
but still requires coordinated recovery of authoritative SQLite state.

## Restore and commit protocol

```mermaid
sequenceDiagram
    participant P as Platform + MongoDB
    participant R as AgentCore adapter
    participant S as S3 checkpoints
    participant C as Local Codex + Truex state
    P->>R: Invoke with stable runtime session ID
    R->>P: Acquire fenced family ownership; read committed generation
    R->>S: Fetch manifest and immutable snapshot on cold start
    R->>R: Verify hashes, ownership, version and complete restore
    R->>C: Start services, resume recorded thread
    P->>C: New turn with durable operation ID
    C-->>R: Runtime work finishes
    R->>C: Establish verified snapshot boundary
    R->>S: Upload immutable generation and manifest
    R->>P: CAS committed generation using fencing token
    R-->>P: Work is durably saved; expose terminal completion
```

Implement the metadata API in the existing platform rather than granting
AgentCore arbitrary MongoDB access. Authorize it for one tenant/family and
validate the mapping server-side. AgentCore uses its execution role for
checkpoint object access; define bucket-prefix access, encryption and
retention in infrastructure configuration.

At the first invocation, bind the family to the AWS runtime session header
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`. Validate it and reject attempts to
change it on later invocations. The platform authenticates the tenant/family
mapping; an arbitrary request-body tenant ID is insufficient authority.
See [AWS custom-server guidance](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-troubleshooting.html).

Restore before `AgentCoreServices.initialize()` launches agent-core. Serialize
simultaneous cold-start invocations. If a committed generation exists and
cannot be fetched or verified, return a recoverable storage error. Never
silently create an empty conversation. A retained managed mount is a cache:
validate its generation and ownership before using it. Discard any divergent
uncommitted state during cold recovery; restore the committed generation.

Suggested durable records:

```text
family: tenantId, familyId, runtimeArn, runtimeSessionId, threadIds,
        committedGeneration, writerToken, leaseExpiry, lifecycleStatus
checkpoint: schemaVersion, familyId, generation, parentGeneration,
            codexRevision, createdAt, operationIds, fileManifest, checksum
operation: familyId, operationId, threadId, turnId?,
           accepted | running | checkpointPending | committed | interrupted | unknown
```

Use an atomic MongoDB compare-and-set to acquire/renew ownership and increment
a fencing token. A stale writer may upload orphan objects but must not advance
the committed-generation pointer or acknowledge durable completion. Fence
mutations too; losing ownership must stop execution. Serialize family-level
mutations and snapshots, including work on forks. SSE subscriptions may
continue independently.

Upload generations under a scoped prefix such as
`runtime-state/<tenant>/<family>/<generation>/`. Upload data first, then a
manifest containing lengths and hashes, then advance the metadata pointer.
Restore only a committed generation. Retention cleanup must preserve the
currently referenced generation and backups; deletion needs a family tombstone
so a stale VM cannot recreate deleted conversations.

Commit operation identities alongside the generation pointer atomically, or
include them in the committed manifest and reconcile operation records from it.
A pointer update followed by a failed operation-status update must not cause
the operation to execute twice on recovery.

## Scaling and cost

The correctness baseline may use a full quiesced snapshot for small families.
Do not make full-history uploads on every turn the long-term strategy:
conversation size grows while most older bytes do not change.

Use manifests that reference immutable content objects. Upload only new or
changed workspace files, SQLite backup objects, and append-only rollout
segments. Segment boundaries must come from a coherent writer boundary;
account for truncation/rollback, archives and lineage rather than assuming
every file is forever append-only. Reuse older objects by checksum and
periodically consolidate segments to bound restore requests. Scope content
keys/access per tenant; avoid cross-tenant deduplication as a default.

Parallelize independent families and bound upload/download concurrency within
one family. Use per-family leases, not a global lock. Snapshot a shared family
as one unit even when its forked UI conversations are active independently.
Keep the MongoDB control record small: do not send raw rollouts through the
platform or embed large snapshot manifests in a session document.

Adopt majority-acknowledged durable metadata writes and atomic ownership/pointer
updates. If the current MongoDB deployment cannot supply that durability,
upgrade it or use DynamoDB for this control plane before claiming durable
checkpoints. S3 provides the bulk object store; another database is not required
when existing MongoDB already meets those guarantees.

Track checkpoint bytes, changed bytes, upload time, restore time, oldest
uncommitted operation, lease failures and storage errors. Measure p95 end-turn
commit latency with realistic long histories before choosing snapshot cadence.
Apply object retention to generations only after tracing references from all
retained manifests. The full directory checkpoint baseline prioritizes
correctness; incremental storage and an in-process barrier address its cost
and restart overhead.

## A coherent snapshot is an implementation prerequisite

The pinned source emits terminal completion before its final rollout flush
(`core/src/tasks/mod.rs:816-841`), and some persistence failures are logged
instead of failing the turn (`core/src/session/mod.rs:3717`). The current
`CodexClient.stop()` only sends SIGTERM. Stdio app-server does not use its
graceful SIGTERM handler. Existing shutdown is not a safe snapshot primitive.

Do not implement a naive `turn/completed -> tar live directory -> S3` hook.

The first implementation should establish a quiesced family snapshot:

1. Gate new mutations and automatic goal/queued-turn continuation.
2. Ensure all roots, forks and helpers have reached a supported checkpoint
   boundary; also fence uploads, adapter-record acknowledgements and the
   workspace sweeper.
3. Drain Codex's writers with propagated persistence errors and await process
   shutdown through a verified graceful stdio mechanism. Prove this with the
   pinned binary; if it cannot provide the required guarantees, add an explicit
   checkpoint/barrier operation to a maintained Codex fork and update the pin.
4. Snapshot only once all database and filesystem writers are stopped. Retain
   any required SQLite WAL state consistently. Reopen and verify restored
   databases in an integration test.
5. Publish the checkpoint, restart Codex, and explicitly reset/reload the
   manager's loaded-thread state before releasing the mutation gate.

Expect process restart latency with this baseline. Measure it. A later
in-process checkpoint API can pause writers, flush native state and produce
coherent SQLite backups without restart. A backup of each live SQLite database
alone does not freeze JSONL, workspace files, or other databases; see
[SQLite backup documentation](https://sqlite.org/backup.html).

Approval waits, background goals and active helpers require special handling.
Do not terminate a process merely because the root appears idle. Durable
pending approvals need a tested restart representation and a way to reissue
requests; raw JSON-RPC request IDs from the old process are invalid. Until that
exists, recover an interrupted turn at the last committed boundary and present
its unresolved action clearly rather than pretending execution continued.

## When to checkpoint and what failure means

Checkpoint after creation, completed/interrupted turns, fork/compaction,
goal/settings/lifecycle changes, and document/workspace mutations. Cover
automatic goal turns as well as user turns. Keep completion provisional until
the durable generation is committed. Stream text may appear earlier, but the
saved-state indicator must be truthful.

For long active turns, a complete design needs intermediate safe boundaries
in the harness and tools. The initial quiesced implementation guarantees
recovery of committed boundaries, not zero loss of an in-flight turn. Define
and measure that recovery window; do not claim a timer-driven live tarball is
consistent. Shutdown checkpoints are additional best effort, never the only
backup.

Persist accepted operation intent before execution. On failure after a tool
may have changed an external system, do not automatically replay that write.
Use connector idempotency keys where supported; otherwise reconcile and report
an unknown result. Conversation checkpoints cannot provide exactly-once
external effects by themselves.

On storage failure, pause new mutations and report `checkpointPending` or a
recoverable storage error. Retry with the same operation identity. Attempt
restore before `THREAD_LOST` can mark a session permanently dead. Preserve
unacknowledged adapter records across recovery and ingest them idempotently
before deleting them.

Native Codex resume by recorded thread ID remains the continuation path.
[OpenAI's app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes that path. The pinned experimental `history` input is explicitly
marked unstable and is stripped by Truex's wrapper; replaying visible messages
through it is not a faithful recovery mechanism.

## Implementation slices and acceptance

1. Infrastructure: provision managed storage as mitigation and an S3 checkpoint
   bucket with retention/encryption/access policies. Add a deployment-time
   mount check; writable `/mnt/state` alone must not pass as durability proof.
2. Platform: persist family identity before create, implement fenced checkpoint
   metadata, track operation states, and make lost-state classification wait for
   restore. Keep existing thread ownership and tenant checks.
3. Adapter: add trusted session binding, restore-before-launch, family startup
   serialization, and explicit storage readiness in `/ping`/health.
4. Runtime: implement/test the snapshot barrier and mutation gate; inventory
   and preserve the full native state; gate terminal acknowledgements on commit.
5. Recovery: reinitialize manager state, refresh MCP/provider configuration,
   reconcile adapter records and pending operations, and enforce version
   compatibility. Quiesce/checkpoint old families before a version rollout.

Required integration tests, including a real AWS acceptance run:

- Continue a model conversation after explicit stop/resume and after idle VM
  replacement, using the same thread ID and verified earlier tool context.
- Restore into a completely empty disk and after a runtime version update.
- Preserve uploaded/generated files, workspace edits, compaction, goals,
  fork history and helper lineage.
- Force death after terminal notification but before checkpoint commit;
  recover only committed state and reconcile the pending operation.
- Lose S3/Mongo connectivity or corrupt a snapshot; fail closed without a new
  empty thread or a premature permanent-dead classification.
- Race two writers and expire a lease; prevent stale-generation publication.
- Retry lost create/turn responses; preserve one accepted operation.
- Restart during approval waits or an external write; avoid stale approvals
  and blind side-effect replay.
- Verify tenant isolation, retained-mount divergence, restore compatibility,
  tombstoned deletion, SQLite integrity and bounded checkpoint latency/size.

The existing smoke script checks startup, pin and writability. It does not
establish conversation durability. Unit/mocked storage tests alone also do
not establish AgentCore stop/resume behavior.

## Remaining deployment inputs

The repository cannot establish whether the live runtime already has a mount.
Before implementation/deployment, obtain the actual runtime configuration,
target AWS region/compute type, durable MongoDB availability, checkpoint bucket
policy, required retention, maximum acceptable checkpoint latency, and the
allowed loss window for an in-flight turn. Preserve existing runtime state
before any update that could reset it.
