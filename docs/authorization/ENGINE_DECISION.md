# Engine/publication experiment — implementation decision, release hold

Status: SpiceDB is selected for continued local implementation. A03/M0 release gates remain on HOLD: the measured latency target is unmet and production publication/list/recovery controls remain incomplete. This decision authorizes building one adapter; it does not approve production rollout. Full-copy tenant publication is rejected. Immutable component publication is the implementation direction, subject to the A07 proof obligations below.

## Reproducible local topology

`infra/authz/compose.poc.yml` runs OpenFGA v1.22.0, SpiceDB v1.56.2 and PostgreSQL 17.11-bookworm. Each engine has its own PostgreSQL database in one fixture PostgreSQL process. Only authenticated HTTP endpoints on `127.0.0.1:18088` and `127.0.0.1:18089` are published; database/gRPC/playground ports are not exposed to the host. Credentials are explicitly local fixture values. Existing unrelated containers are untouched.

Versions and APIs were verified against [OpenFGA's release](https://github.com/openfga/openfga/releases/tag/v1.22.0), [Docker setup](https://openfga.dev/docs/getting-started/setup-openfga/docker), [OpenFGA API definitions](https://github.com/openfga/api), [SpiceDB's release](https://github.com/authzed/spicedb/releases/tag/v1.56.2), [schema reference](https://authzed.com/docs/spicedb/concepts/schema) and [Authzed API definitions](https://github.com/authzed/api). These links establish versions/API syntax, not application safety.

```bash
docker compose -f infra/authz/compose.poc.yml up -d
npm --prefix platform run test:authz:integration
npm --prefix platform run authz:benchmark
# Stop only this isolated experiment when finished; retain its fixture volume.
docker compose -f infra/authz/compose.poc.yml down
```

## Evidence so far

The real-engine cases pass on both engines:

- Action capability AND content relationship, including an administrator with read capability but no transcript access.
- Explicit group sharing permits reading and denies sending, approving and settings changes.
- Ownership without a role capability denies; a service owner with a capability can read its own conversation.
- Document read inherits conversation privacy.
- Engine lists exclude another owner's private conversation and return no conversations to the administrator fixture.
- Nested groups contribute only the explicit share.
- A successful late write to grant snapshot N cannot change checks using complete revoke snapshot N+1. Every traversable subject/object is namespaced, including roles/groups/scopes/principals; the compiler rejects cross-snapshot edges and wildcards.

OpenFGA checks/lists explicitly use the pinned authorization model and `HIGHER_CONSISTENCY`. SpiceDB checks/list lookup use `fullyConsistent`. Neither setting alone solves application writer ordering: the isolated snapshot is what prevents the demonstrated late write from resurrecting active permission.

The Mongo ordering tests independently prove pending publication, exact revision/model/namespace acknowledgment, durable revoke, admission serialization, one-use receipts, mandatory audit/outbox rollback, primary election survival and dropped commit response handling. They reuse [Mongo's transaction behavior](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/) and a [driver commit-disconnect test pattern](https://github.com/mongodb/mongo-python-driver/blob/main/test/test_transactions.py). Engine calls occur outside retryable transaction callbacks.

## Cost experiment

The benchmark emits bounded batches and reproducible JSON evidence. Default target: 10,000 principals, 100,000 conversations, exactly 1,000,000 relationships, ten tenants with an 80% hot tenant, two complete graph copies and 1,000 allow/deny checks. OpenFGA uses one store/model per tenant; SpiceDB uses isolated revision namespaces in its fixture datastore. Fixture identifiers include generations. Generated relationship counts are verified; failures are retained in the report and produce nonzero exit status.

The small smoke dataset (100 principals/1,000 resources/10,000 relationships, two tenants, one copy) completed on both engines with 50 expected allows, 50 expected denies and zero mismatches. Its measurements are in `evidence/benchmark-both-10000-2026-10-11T19-58-10-513Z.json`. They are smoke evidence only.

The first million-relationship attempt used 16 concurrent writes with 1,000 relationships per request. OpenFGA returned HTTP 500 `deadline_exceeded` during the hot tenant's first copy. No complete snapshot or check benchmark was produced, and the old runner did not record acknowledged tuple counts. This is a failed experiment, not a scalability pass. The runner now retains partial/failed results and separates write concurrency/batch size from check concurrency; the recorded follow-up used four concurrent 100-tuple writes, preserving 16 concurrent checks and the same dataset.

The follow-up million-relationship report is [retained here](evidence/benchmark-both-1000000-2026-10-11T20-02-31-597Z.json). OpenFGA failed during the first hot-tenant copy: 556,200 tuples sent, 556,100 acknowledged and 100 with unknown/rejected outcome, then HTTP 500 `deadline_exceeded`. SpiceDB completed both full copies in 107,942 ms and 92,133 ms. Its 1,000 checks produced 500 expected allows, 500 expected denies and zero failures; p50 23.27 ms, p95 48.47 ms, p99 67.01 ms at 16 concurrent checks. These are local fixture observations, not production availability guarantees.

**Reject full-tenant graph copies for ordinary policy publication.** A tenant fence lasting roughly 90–108 seconds is unacceptable even when permission reads are fast. The alternative must preserve late-writer isolation while avoiding copying unrelated resources. A worker lease, faster retry or stale-ack rejection cannot replace that proof.

## Immutable component experiment

`poc.components.openfga.json` and `poc.components.spicedb.zed` define versioned group, role, organization and conversation components. Each stable logical alias selects an immutable version through the same fixed condition: `key in active && active[key] == revision`. The version edge persists its exact alias key and version; the server must supply `active` from authoritative published state. This is a fixed publication invariant, not a customer policy language. Conditions/caveats are native [OpenFGA](https://openfga.dev/docs/modeling/conditions) and [SpiceDB](https://authzed.com/docs/spicedb/concepts/caveats) features.

Twelve real-engine component tests pass. Two additional replica-set tests use real engine checks through serialized admission: a revoke committed after a real engine allow prevents admission, and a valid receipt consumes once. Their Mongo root is explicitly a manually assembled fixture; production payload/root atomicity is not inferred from those tests. Group, role and content revocation publish only a new component; delayed grants to the old component then succeed in the actual engine. Old references allow as a positive control, while current references continue to deny. Capability/content intersection, private lists, read-only shares, missing/unknown references and cross-tenant compiler rejection are covered. SpiceDB partially evaluated checks/list results do not grant; OpenFGA missing-context errors remain errors. The compiler emits only an exactly bound selector and edges on its own immutable version; it emits no deletes or arbitrary caller conditions.

The [small component smoke report](evidence/benchmark-components-both-10000-2026-10-11T20-26-08-702Z.json) completed on both engines with 50 expected allows/50 expected denies and no mismatch. This is not a load gate. The [million-relationship component report](evidence/benchmark-components-both-1000000-2026-10-11T20-26-36-158Z.json) uses the same principal/resource/tenant distribution, one initial copy and serialized 1,000-tuple write batches. OpenFGA timed out after 499,000 sent/498,000 acknowledged tuples; 1,000 outcomes remain unknown/rejected. SpiceDB completed the initial graph in 146,360 ms and passed 1,000 checks (500 allows/500 denies, no errors; p95 36.78 ms, p99 62.79 ms).

On that SpiceDB graph, engine publication for an empty replacement group required one relationship and 7.43 ms; the replacement role excluding one of 8,000 assignees required 8,000 relationships and 1,204.44 ms; removing a conversation share required three relationships and 6.22 ms. Read-check contexts contained four relevant references, 554 bytes. Each revoke was verified against actual engine checks. These timings exclude Mongo, durable queues, workload verification, admission, replication topology and concurrent mutation costs. They support testing components further; they do not prove the end-to-end five-second revocation bound.

SpiceDB is selected under the measured fixture configuration. OpenFGA's repeated full-size failures are retained; production tuning may change them. The remaining publication, list, recovery and operational gates still block rollout.

Production work still required:

- Persist component payloads, versions and their digest atomically with desired state/audit/outbox; authenticate projectors and prevent a stale payload from being relabeled as a new version.
- Resolve active references from a consistent published Mongo root, then revalidate that exact root in admission. Caller-selected references must never reach the engine.
- Bound reachable group/role dependencies and reject cycles. A single check needs only its relevant references; do not send every resource head in a tenant as condition context.
- Implement lists through bounded candidates/native bulk checks with consistent roots and safe cursors. A small reference map with `ListObjects` alone can silently omit accessible resources; it is not complete list semantics.
- Measure historical-version traversal/garbage collection, concurrent publications and the whole mutation-to-unfence duration, including Mongo and queue time. The current component benchmark measures engine writes only.
- Prove schema/model overlap, projector restart, dropped write response, restore and drift before production selection.

## Conditions before selecting an engine

Complete the production action model; compare pinned model/schema overlap, real projector crash/restart, graph restore/drift and dropped write response. Capture full-size success/failure, write amplification, publication time, check/list latency, database size and store cardinality under documented resource limits. Resolve namespace construction/garbage collection and tenant fencing costs. Re-estimate later milestones from those results. A passing privacy fixture does not justify skipping these gates.

## Full-catalog and process-fault evidence

The generated `authorization.candidate.v1.zed` covers every fixed action from `shared/authorization.ts`. Real SpiceDB queries verify private administrator denial, read-only sharing/inherited documents, service ownership, mechanical workload role separation, native emergency expiry and coexisting versioned schema types with changed semantics. Direct queries to server-selected immutable resource versions preserve these checks. Invalid consistency tokens fail; they do not select a weaker mode. These are policy fixtures, not broker/authentication or complete business-transaction evidence.

The dedicated fault suite passes three tests: backend writes whose successful responses are deliberately lost; SIGKILL/restart of the named isolated OpenFGA/SpiceDB containers with persisted grants; and a fixture projector child that exits after a real partial write, restarts from a durable Mongo payload, then cannot acknowledge a newer revoke. The fixture stages its payload separately from the outbox; production must bind immutable payload digests and domain/head updates to the transaction in A07. Superseded event completion/lease/retry/retention remain production requirements. Restoring only older graph tuples cannot satisfy the current version head. Full database backup/restore reconciliation remains A18.

[Native bulk evidence](evidence/benchmark-bulk-spicedb-2026-10-11T21-00-06-053Z.json): 1,000 candidates checked in 20 batches of 50 against the retained million-relationship component graph, including its completed revocations. Results: 201 allows, 799 denies, zero mismatch; 1,122 ms total, batch p95 74.31 ms/p99 86.41 ms. Each result is matched to its subject/resource/permission/context; omitted, errored or conditional results never grant. This excludes Mongo candidate queries, root consistency and delivery leases.

[Full-catalog scale evidence](evidence/benchmark-catalog-spicedb-1000000-2026-10-11T21-04-42-306Z.json): ten tenants/10,000 principals/100,000 conversations/exactly one million relationships. SpiceDB completed one graph in 178,108 ms, with 1,000 checks producing 500 allows/500 denies and no mismatch. Check p95 86.48 ms, p99 177.48 ms, 285.5 checks/s at 16 concurrent requests. Group replacement required one tuple/11.51 ms; role replacement required 8,000 tuples/2,099.80 ms; content replacement required three tuples/6.69 ms. The initial publication overlapped the full platform regression; that regression had finished before read/update measurement. The richer model misses the proposed latency/load targets. Do not transfer the minimal-model measurements to this model.

[Resource addressing/consistency experiment](evidence/benchmark-read-addressing-2026-10-11T21-15-38-369Z.json): eight trials on that existing full-catalog graph, 1,000 requests each, with trial order reversed in repetition two. All trials returned 500 expected allows/500 expected denies with no failure. Direct immutable-version queries with `atLeastAsFresh` measured p95 32.52–34.54 ms/p99 51.33–52.52 ms, 875–918 requests/s. Logical-alias `atLeastAsFresh` varied from p99 59.03 ms to 26.43 ms after warming. `fullyConsistent` was slower and variable. These observations still do not meet the p99 ≤25 ms protected-policy target, and contain no application overhead.

SpiceDB's [consistency contract](https://authzed.com/docs/spicedb/concepts/consistency) permits using a stored publication ZedToken as an `atLeastAsFresh` minimum. The benchmark obtains a fully consistent marker after the fixture writes. Production must persist a marker obtained after all component writes, bind it to the exact published root/model, and load it server-side. Missing/invalid markers fail closed. Mongo fences, live generations, read leases, admission serialization and restore quarantine still apply. A token or native cache does not solve late application writes; immutable components provide that protection.

## Step 04 exit status (2026-10-12)

**Exit gate: not met. Step 04 stays on HOLD for the items marked open below.** Re-verified on 2026-10-12 against the running isolated POC containers: `test:authz:integration` 78/78 and `test:authz:faults` 3/3 pass (including additive identity coverage). The benchmarks in `evidence/` were not rerun and are the numbers cited above.

### Implementation decision (production rollout remains blocked)

Carry **SpiceDB v1.56.2 on PostgreSQL** forward as the only implementation engine and stop evaluating OpenFGA. Evidence for: OpenFGA v1.22.0 failed to complete either million-relationship graph (HTTP 500 `deadline_exceeded`, with 100 and 1,000 unknown-outcome tuples), while SpiceDB completed every graph and passed every privacy, revision-isolation, component, bulk-check and process-fault case. Evidence against OpenFGA is specific to this pinned version and the untuned fixture; it is not a general judgement of the product.

Proposed shape, each part still to be proven in A07:

| Aspect         | Proposal                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topology       | One SpiceDB deployment per regional cell on dedicated PostgreSQL; separate from application Mongo. Fixture is a single PostgreSQL process and proves no HA or failover.                                  |
| Tenant routing | Server-owned tenant registry selects cell and published root. Tenant-qualified identifiers; clients never choose store, schema or version.                                                               |
| Publication    | Immutable per-component versions (group, role, content) plus a Mongo published root; compare-and-set activation of the exact revision. Full-tenant graph copies are rejected (90–108 s fence).           |
| Consistency    | Direct immutable-version queries with `atLeastAsFresh` and a server-persisted ZedToken taken after all component writes; `fullyConsistent` only as a measured fallback. Missing or invalid token denies. |
| Fallback       | Engine, token, root or audit unavailable returns an actionable unavailable error and denies protected work. No stale-positive cache, no admin read-all.                                                  |

### Open gates (why this is a HOLD)

1. **Latency target missed.** The full-catalog graph measured check p99 177.48 ms at 16 concurrent requests; best direct-version reads measured p99 51–53 ms. The proposed policy-check target is p99 ≤25 ms. All figures are local single-node Docker without application overhead. Either re-measure on production-like hardware with a tuned datastore, or the owner changes the target. This is a product/risk decision for the responsible owner; it is not made here.
2. Component payload/digest and root are not yet persisted atomically with desired state, audit and outbox (A07).
3. Complete list semantics (bounded candidates plus bulk checks, authorized continuation) exist only as a benchmark; `ListObjects` alone can omit accessible resources.
4. HA/failover, schema-migration overlap under a real rolling deploy, historical-version garbage collection and whole-database restore are not proven. Restore reconciliation is A18.
5. Role replacement writes one tuple per assignee (8,000 tuples, 1.2–2.1 s for 8,000 assignees). Larger groups need a measured bound or a fence strategy.

### Re-estimate (engineering judgement from the above, not a measurement)

| Step        | Previous  | Revised   | Reason                                                                                               |
| ----------- | --------- | --------- | ---------------------------------------------------------------------------------------------------- |
| 08 / A07    | 6–10 days | 9–15 days | Component publication, atomic root, projector and token persistence are production work, not wiring. |
| 09 / A08    | 5–9 days  | 7–12 days | Lists need bounded candidate pages with bulk checks and continuation, as measured above.             |
| Other steps | unchanged | unchanged | No evidence to move them. Re-estimate again after M2 runtime isolation.                              |

Total budget moves from 97–166 to approximately 102–174 engineering days (about 21–35 weeks for one engineer).

## Historical-selector cost

The [obsolete-selector experiment](evidence/benchmark-obsolete-selectors-2026-10-11T21-20-47-409Z.json) adds 0, 10, 100 and 1,000 isolated obsolete role versions, each retaining an assignee revoked by the current role version. Twenty sequential fully consistent checks per stage test both the current allowed actor and revoked actor. All 80 decisions match. At 0 obsolete versions, p50/p95/max were 3.71/14.46/18.05 ms; at 1,000, 8.25/22.39/42.12 ms. Exactly the added fixture tuples were removed afterward.

This supports bounded history and garbage collection work in A07/A18. It is one alias with a small sequential sample, not evidence that arbitrary group depth, historical fan-out, concurrent load or production garbage collection meets the latency target. Published roots, active read leases and in-flight projector permissions must govern retention; deleting obsolete tuples alone does not prevent an old projector from writing them again.
