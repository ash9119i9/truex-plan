# Enterprise storage context

Status: A06 structural tenant-storage boundary implemented locally. This does not complete A06, grant a resource permission, or enable enterprise execution.

## Routing rules

`Store` captures `AUTH_MODE` when constructed. In OIDC mode, `db`, tenant collection getters, `indexesReady`, `mcpReady`, and `ensureTenantIndexes` require an unexpired explicit authorization context and a tenant reference minted by that same Store from its server-owned registry. A copied reference, a reference from another Store, a different tenant, or a different tenant generation denies before database selection or index creation. References and their allow-list arrays are copied and frozen before entering the tenant context.

Enterprise startup creates catalog indexes only. It does not create resource indexes in an implicit default database. Index creation for tenant resources requires the selected tenant context and matching privacy/index configuration.

Enterprise resolution always reads the registry; it does not accept a cached active record after a subsequent disablement. Every tenant, including `default`, must have an active registry record and a well-formed authorization generation. Database names are bounded to the supported lowercase ASCII namespace (preventing case aliases), must not name Mongo system databases, and non-default tenants must not route to the default or catalog database. A default registry record must agree with the configured default database. The existing unique database-name index prevents two registered tenants from selecting the same resource database. Missing default records are not synthesized in `resolveTenant` or `activeTenants`.

Legacy modes retain their current default resolution and storage behavior while callers migrate. Changing the process environment after Store construction does not weaken an enterprise Store.

## What still owns authorization

The immutable async context is entered only by a trusted caller after authenticating its credential. Its shape is not proof of authentication. This storage boundary checks credential time and tenant routing; it does not independently reload a principal, membership, policy head, resource, or relationship permission.

A returned Mongo database or collection handle is not an authorization capability. Protected service operations must perform live permission/admission checks immediately before the protected query or effect. Streams need periodic live checks and delivery deadlines; retaining a reference or handle is not a way to extend authority. A registry routing change must follow the generation, fence, and migration protocol rather than mutating a database mapping under an existing generation.

Catalog identity operations before tenant selection remain available for login. The raw Mongo client and catalog are trusted control-plane interfaces, not public resource-query APIs. Shared model/skill metadata, credentials, and every direct client caller still need their planned service, administration, model, and execution guards. Workload authentication, bounded worker scopes, named operator access, secure mixed-version deployment, and the live A07/A08 policy path remain unfinished.

The OIDC preparation gate continues to block resource, runtime, model, and tool routes and legacy background ingestion. Do not remove it based on these structural tests.

## Failure and rollback behavior

Missing authorization context returns `AUTHORIZATION_CONTEXT_REQUIRED`; an expired credential returns `AUTHORIZATION_CREDENTIAL_EXPIRED`. Missing, forged, or mismatched tenant context returns `AUTHORIZATION_TENANT_CONTEXT_DENIED`. Unknown/inactive tenants and malformed registry mappings fail closed. Repair the registry or authenticate again as appropriate; never restore the implicit fallback for an enterprise tenant.

Rollback must preserve explicit tenant routing and the preparation gate. Returning an enforced tenant to legacy mode is not a safe rollback strategy.

## Evidence

`platform/test/authz-storage.test.ts` runs against an actual disposable Mongo replica set. It proves zero database selections for denied storage/index entry points, reference immutability and Store ownership, cross-tenant/generation denial, expiry after an await, concurrent tenant isolation, default refusal, malformed mappings, and fresh disablement reads. `authz-context.test.ts` exercises immutable async request scope; `authz-oidc-startup.test.ts` uses the actual platform process to check the preparation gate. These are local synthetic proofs, not deployment or runtime-isolation evidence.
