# API access-token contract (Step 06 / A05)

Status: implemented in `platform/src/api-auth.ts` and tested against **synthetic** issuers only. No identity broker has been selected or configured. A real broker must be able to emit the claims below before bearer authentication can be enabled for it. Bearer authentication is off unless `API_AUTH_ISSUERS` is set (Google or OIDC mode); with it off, any `Authorization` header is refused with 401 `BEARER_UNSUPPORTED`.

## Configuration

`API_AUTH_ISSUERS` is a JSON array of trusted issuers: `{ "connectionId", "issuer", "jwksUri", "audience", "algorithms"? }`.

- `connectionId` must be an active `identity_connections` record whose `issuer` equals the configured issuer exactly. Disabling that record denies every token immediately (live fence; not cached).
- `issuer` and `jwksUri` must be plain HTTPS. The JWKS URL is administrator-approved; a URL in a token (`jku`, `jwk`, `x5u`, `x5c`) rejects the token.
- Allowed algorithms: `RS256`, `PS256`, `ES256`, `EdDSA`. `none` and HMAC are never accepted.
- Defaults: clock tolerance 30 s (max 60), maximum `exp - iat` 900 s (target 300 s), JWKS cache freshness 10 min (max 60 min), refresh cooldown 30 s, fetch timeout 5 s.

## Required token shape (RFC 9068 profile)

Header `typ` must be `at+jwt`. Required claims: `iss`, `sub`, `aud` (this API's audience), `exp`, `iat`, `jti`, `client_id`. A token with `nonce`, `at_hash` or `c_hash` is treated as an ID token and refused. `scope` is a space-delimited list; only strings that are fixed actions in `shared/authorization.ts` carry authority, others are ignored. Roles and groups in a token are ignored.

The broker must also add the namespaced claim `https://truex.dev/authz`, an object with exactly these members (anything else rejects the token):

| Member                                                                                                              | Meaning                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`                                                                                                            | Routing hint. Verified against the live binding.                                                                                        |
| `principal_generation`, `binding_generation`, `credential_generation`, `tenant_generation`, `connection_generation` | Must equal the current generations in `identity_*` records. A token issued before a removal/rehire carries stale values and is refused. |
| `client_generation`                                                                                                 | Present only for registered-client (service) tokens.                                                                                    |

Human tokens: `sub` is bound to a human principal through `identity_external_bindings` (connection + issuer + subject, never email). The verifier resolves the external binding ID server-side and rechecks its active state; this ID is not a caller-selected JWT claim. Service tokens: `client_id` must be a registered client for that tenant and `sub` must equal `client_id`. A token's `iat` must not precede the binding's `notBefore`; `iat` has one-second resolution, so a token minted in the same second as a (re)binding is refused and must be reissued.

**Open vendor requirement:** the broker has to learn Truex's internal generations (for example by calling a Truex endpoint from a pre-token hook). If a candidate broker cannot, bearer authentication for it stays disabled; do not weaken the check.

## Request handling order

`/api` runs `bearerGate`, then CSRF, then `authMiddleware`.

1. No `Authorization` header: cookie mechanism, unchanged, CSRF protected.
2. Header present and bearer authentication disabled: 401 `BEARER_UNSUPPORTED`.
3. Header present together with any session cookie: 400 `AMBIGUOUS_CREDENTIALS`, before verification. An invalid bearer never falls back to a cookie.
4. `/api/admin/*` with a bearer: 401. Platform administration keeps its own session.
5. Verify signature, issuer, audience, `typ`, expiry and lifetime; then live principal, connection, binding and generation checks. Every token failure returns the same 401 `BEARER_INVALID`. A JWKS fetch failure with no fresh cached key returns 503 `AUTH_UNAVAILABLE` and never extends key freshness.
6. Route and scope ceiling from `AUTHORIZATION_ROUTES`: only `account`, `resource` and `admission` routes with a non-empty action list are reachable, and the token scopes must include every required action. Streams, per-method capability routes, blocked and unlisted routes return 403 `BEARER_ROUTE_UNSUPPORTED`. Missing scope returns 403 `SCOPE_DENIED`.
7. Only after all that is a verified bearer exempt from the CSRF Origin/JSON check. A bare `Authorization` header is never an exemption.

In Google mode, legacy handlers still apply owner/admin rules using live membership role. Canonical non-Google human profiles and bindings also resolve without fabricated Google rows. OIDC preparation mode permits only account metadata; it cannot expose these legacy resource handlers before enterprise guards exist.

## Known limitations

- Service principals authenticate but get 403 `SERVICE_PRINCIPAL_UNSUPPORTED` on legacy routes. They need explicit actors in the service layer (Steps 07 and 09).
- Scopes are enforced per route here. Resource-level engine checks arrive with Steps 08 and 09.
- A key removed from the broker's JWKS stays accepted until the cached key set expires (default 10 min). Emergency disablement uses the connection record, which is checked on every request.
- Event streams are not available to bearer callers (Step 10 adds read leases; native `EventSource` cannot send `Authorization` anyway).
- Generic browser broker login is implemented; see [browser contract](BROWSER_AUTH_CONTRACT.md). Live broker attestation and federation remain unverified. OIDC mode restricts API routes to account metadata until their enterprise permission guards exist.

## Additive identity migration

The [identity data contract](IDENTITY_DATA_CONTRACT.md) defines canonical records and the backfill procedure. Generationless legacy sessions remain legacy and are not automatically upgraded. The verifier's human fixture uses that actual backfill. During schema overlap, migrated principal/binding checks also read current legacy user/membership status; this is a defensive check, not permission for old lifecycle writers to operate against enforced enterprise tenants. Coupling these lifecycle mutations to the admission fence remains A07/A13.

Receipt/audit credential identity is a SHA-256 fingerprint of the complete verified compact JWT. Reusing `jti` across issuers or token bodies does not conflate credentials. The raw JWT is never persisted or logged.
