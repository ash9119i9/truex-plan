# Additive identity expansion (A04)

Status: canonical catalog records, cohort validation and Google backfill implemented with real Mongo replica-set tests. Existing login/session behavior is preserved. This is identity storage and liveness validation, not enterprise authorization enforcement. A05 browser issuance is now implemented against synthetic brokers; A06 explicit actors and A07/A13 atomic policy-fence integration are still required.

`platform/src/identity.ts` follows the existing catalog-store pattern. Every identity mutation requires replica-set transactions and mandatory audit. Connection registration, subject linking, principal creation and binding/client management are trusted control-plane primitives; their callers must authenticate and authorize named administrators before calling them. Type/shape checks do not grant administrator authority.

| Collection                   | Meaning                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity_principals`        | Immutable internal human/service IDs, lifecycle generation and active/disabled state. Existing human IDs survive migration. IDs cannot be reused; services need neither email nor Google subject.                 |
| `identity_connections`       | Operator-approved, exact HTTPS issuer and connection generation. Google migration accepts only the global `https://accounts.google.com` connection. Optional tenant restriction applies to federated connections. |
| `identity_external_bindings` | Unique connection + issuer + subject mapping to one human generation. No email matching or domain auto-linking.                                                                                                   |
| `identity_tenant_bindings`   | Unique tenant + principal binding, principal/tenant/binding/credential generations, issuance cutoff and active/removed state. Roles are separate permission bundles.                                              |
| `identity_clients`           | Registered exact issuer/client/tenant mapping to a service principal and binding. No unregistered client fallback.                                                                                                |
| `identity_tombstones`        | Removed binding and credential generations retained after rehire. No TTL deletes these records.                                                                                                                   |
| `identity_audit`             | Attributable mutations without credentials, email, subject or confidential content. Failure to write audit rolls back the mutation. Retention/export controls remain A18.                                         |

`users`, `memberships`, `tenants` receive additive `authorizationGeneration` fields during backfill. Google/email uniqueness indexes remain intact for their legacy readers. Non-Google humans and services live in the canonical catalog without fake Google identities. Legacy profile/session readers must migrate before those indexes or assumptions can be retired. An implicit default database is not silently promoted to an enterprise tenant.

## Credential and lifecycle invariant

Credentials carry the generations captured at issuance. Validation never fills missing/stale generations with current database values. Exact principal, tenant, binding, credential and connection generations, issuance cutoff, current status and expiry all have to match. Service tokens also require the registered client generation. Browser issuance stores these fields in `AuthSessionDocument.authorization`; old sessions are deliberately left untouched and do not become enterprise credentials.

API crypto and token-purpose verification remain in `api-auth.ts`. Its verifier resolves the human's external binding ID from the verified issuer/subject on the server and rechecks that active link during credential validation. A JWT cannot choose this binding ID. The broker must attest the generation claims from a trusted, non-user-writable source; a newer `iat` alone cannot upgrade an old binding generation. A provider unable to satisfy this contract stays disabled.

Removal is idempotent for the exact generation, writes a tombstone/audit transactionally, and leaves other tenant bindings intact. Explicit rehire replaces the removed binding with fresh binding and credential generations. A stale removal cannot affect that new generation. Migrated Google bindings also update their legacy membership status/generation atomically. Current legacy disabled-user/removed-membership state denies canonical credentials during the schema overlap.

These identity transactions are not yet coupled to the same policy epoch used for sensitive admission. A07/A13 must make that coupling atomic before enterprise enforcement. Old application versions that can rewrite legacy lifecycle status without rotating generations must not write to an enforced enterprise tenant. Fresh identity reads and migration drift reports alone are insufficient to make such writers safe.

## Backfill procedure

The CLI does not read dotenv or infer a database URI. Install the trusted Google connection through the authenticated control plane first. Dry run:

```bash
AUTHZ_MIGRATION_MONGO_URI='<explicit URI>' \
  npm --prefix platform run authz:identity:backfill -- <catalog-db> <google-connection-id>
```

Review the bounded ID/code report. Duplicate subjects, conflicting principal/binding generations, partial migrations, missing tenant registry records and legacy lifecycle drift require repair; they are not automatically linked or reopened. Reports contain no URI, email, subject or credentials. CLI connection errors are sanitized.

Apply requires an explicit named operator:

```bash
AUTHZ_MIGRATION_MONGO_URI='<explicit URI>' \
AUTHZ_MIGRATION_ACTOR_ID='<operator-id>' \
AUTHZ_MIGRATION_ACTOR_GENERATION='<operator-generation>' \
  npm --prefix platform run authz:identity:backfill -- <catalog-db> <google-connection-id> --apply
```

The CLI is an operator-only maintenance tool relying on the operator's database credential and explicit attribution; it is not a public authentication endpoint. Application callers must enforce the administrator permission separately.

Each user is reread in a short snapshot/majority transaction, together with memberships, tenant generation, identity binding and required audit. A failure cannot leave that user's stamps partially migrated. The whole run is resumable rather than one unbounded transaction; already committed users survive a later failure. Repeat apply verifies stable generations without minting replacements. No sessions, resource permissions, role assignments or service credentials are manufactured by backfill. It has been run only on synthetic databases.

## Verification

`authz-identities.test.ts`, `authz-integration/identities.test.ts` and `identity-standalone.test.ts` cover input/operator injection, exact issuer/subject resolution, corporate dot/tag preservation, service-client binding, concurrent binding creation, stale generation/expiry, tenant-specific trust, removal/reinvite, unrelated-tenant survival, mandatory audit rollback, mixed schema reads, repeatable dry runs, the real CLI and standalone transaction refusal. The API tests use an actual backfilled human fixture so crypto verification is checked against this schema rather than an invented identity.
