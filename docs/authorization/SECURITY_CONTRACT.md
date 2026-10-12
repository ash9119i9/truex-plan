# Authorization contract, version 1

Implementation status: shared wire types and context validation exist. Production routes still use the existing authorization flow. The route inventory declares required boundaries; it does not install enforcement. Core engine privacy fixtures pass against both prototype schemas. The complete production action model and production integration remain required for M0 and later milestones.

## Actors and authority

`shared/authorization.ts` defines the fixed `Action` catalog, resource references, typed decisions, authorization context and protected-service check/admission protocol. A context carries a named human/service/workload principal, principal generation, tenant generation, membership/service binding generation, authenticated credential identifier, lifetime, fixed action scopes and request ID. Authentication installs it; request JSON never does.

A human may use a verified session or access token. A service uses a verified access token, never a borrowed browser session. A workload uses its own authenticated workload credential. Only runtime, broker and gateway workloads carry an effective human/service principal and execution grant. Ingestion, projection, reconciliation and cleanup cannot supply an effective customer identity. A workload's fixed ceiling intersects credential scopes and live permissions.

Missing context, missing tenant, unknown action, malformed generation, cross-tenant resource, future/expired credential, duplicate/unknown scope and illegal delegation fail validation. Passing `contextFailure` returns `undefined`, which permits a live check; it never returns an allow decision. The `AuthorizationContext` type is not an authentication credential.

Internal IDs/generations are bounded opaque identifiers. Corporate emails are identity attributes, not principal IDs. Existing request IDs retain the `shared/logging.ts` format. Resource references are loaded by the server from the selected tenant; a caller cannot choose an owner, generation, model, policy store or active graph namespace.

## Decision rule

Access requires all applicable gates:

1. Verified credential and trusted routing.
2. Active tenant/principal/binding, matching live generations and credential cohort.
3. Fixed credential/workload scope ceiling.
4. Current, published policy with no deny fence.
5. Engine action permission and the required resource relationship.
6. Valid delegated execution grant and exact approval/assurance where required.
7. Mandatory durable audit before disclosure or sensitive admission.

An organization/workspace role containing `conversation.read` supplies only an action capability. Private content additionally requires ownership, an explicit valid read share, or governed emergency reading. Engine fixtures must prove this conjunction; a test double returning allow is not evidence of privacy. Organization administrators, platform operators and workspace managers have no implicit content relationship.

| Fixture                                                                         | Required result                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Owner with read capability, current generations                                 | Allow read                                                                   |
| Owner without read capability                                                   | Deny                                                                         |
| Administrator with read capability, no content relationship                     | Deny                                                                         |
| Member with valid explicit read share and read capability                       | Allow read                                                                   |
| Shared reader attempting send, approve, upload or settings changes              | Deny                                                                         |
| Workspace member without an explicit content relationship                       | Deny private content                                                         |
| Expired/revoked emergency reader                                                | Deny                                                                         |
| Service account owning a conversation                                           | Apply service binding and owner relationship; no human identity substitution |
| Human removed and reinvited with a new generation, presenting an old credential | Deny                                                                         |

Conversations and personal project folders remain private by default. Existing projects do not become shared workspace IAM boundaries. Initial sharing is read-only and within one tenant. Documents, visualizations, subagent history, traces, goals, streams and caches inherit the conversation's content requirements; separate actions constrain their use.

## Worker ceiling

`WORKLOAD_ACTIONS` is the authoritative fixed catalog, not a configurable role bundle. Ingestion may read, persist and acknowledge records of previously accepted execution; it cannot start turns or receive connector/model credentials. Projection changes policy graphs through publication outbox records. Reconciliation detects drift and controls recovery. Cleanup may stop/delete revoked execution within its recorded scope. Runtime, broker and gateway require explicit delegated grants in addition to their ceilings. An absent user is never an internal superuser.

## Protected service protocol

`AuthorizationCheckRequest` supplies a verifiable credential, fixed action, resource type/ID and request ID. The receiver reloads tenant/resource metadata and live state. `AdmissionRequest` adds a stable operation ID and SHA-256 digest of trusted canonical operation data, including all targets and arguments. Client-provided digests are recomputed at the boundary.

`AdmissionReceipt` records tenant, actor, resource generation, action, exact policy revision/model/namespace, digest and bounded expiry. It is persisted atomically with an individual audit event while writing the same fence document as revocation. A receipt is not a general permission token. Protected dispatch verifies authority and consumes it once; changed-payload retries conflict. A timeout after external dispatch is an unknown outcome, not permission to repeat an irreversible effect.

A revocation ordered before admission denies the admission. An operation admitted earlier may already be in flight; broker idempotency/outcome records and cancellation govern it. No claim of instantaneous cancellation of a downstream operation is made.

## Publication and recovery

Mongo owns desired policy, lifecycle generations, deny fences, operation audit and outbox. Grants remain pending until the exact current revision/model is verified and published. Privilege reduction commits denial first. An old acknowledgment cannot clear a newer fence. The selected real engine must prove that an old in-flight graph write cannot modify the namespace queried by active decisions.

The initial `policy-state.ts` primitives are a transaction/ordering POC, not a replacement for legacy authorization. They intentionally fence at tenant scope during publication. They require replica-set transactions, retain append-only operation evidence and never call the engine inside a retryable Mongo callback. A restored tenant stays fenced; ordinary publication/mutation cannot clear that fence. Recovery requires explicit reconciliation of authoritative revocation history, which is a later implementation gate.

## Error contract

Malformed authenticated requests produce 400; unauthenticated/invalid credentials produce 401; known denied capabilities produce 403. Resource lookup avoids disclosing inaccessible resource existence. Changed idempotency payload produces 409. Unavailable policy/lifecycle/audit dependencies produce 503, with no cached positive fallback. Streams use the existing terminal-error framing and close when authority cannot be refreshed within the required deadline.

## Verification boundary

`authz-contracts.test.ts` verifies shape, delegation and scope ceilings. `authz-route-coverage.test.ts` verifies HTTP/capability inventory. Replica-set tests verify publication and admission ordering separately. Actual engine fixtures must prove relationship semantics; runtime, broker, model mediation, stream revocation and deployment tests must prove enforcement at every downstream boundary. None of these tests substitutes for the others.
