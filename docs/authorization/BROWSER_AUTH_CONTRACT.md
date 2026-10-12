# Broker browser login (A05)

Status: generic OIDC code login and canonical opaque sessions implemented; verified with a synthetic broker, the installed `openid-client` 6.8.8 SDK, real HTTP requests and Mongo replica-set transactions. No live broker or customer federation has been configured. Enterprise authorization is still incomplete.

## Deployment configuration

`AUTH_MODE=oidc` selects the enterprise preparation path. `FRONTEND_ORIGIN` must be an exact HTTPS origin in production; local development accepts HTTP loopback. `OIDC_LOGIN_CONFIG` is server-only JSON:

```json
{
  "connectionId": "regional-broker",
  "issuer": "https://broker.example/",
  "authorizationEndpoint": "https://broker.example/authorize",
  "tokenEndpoint": "https://broker.example/token",
  "jwksUri": "https://broker.example/jwks",
  "clientId": "truex-browser",
  "clientSecret": "<secret injected by the deployment secret store>",
  "clientAuth": "basic",
  "signingAlgorithm": "RS256",
  "sessionHours": 8
}
```

`basic`, `RS256` and eight hours are defaults. Client authentication may be `basic` or `post`; approved signature algorithms are RS256, PS256, ES256 and EdDSA. Session duration is an integer from one to 24 hours. Unknown configuration fields, URL credentials/query/fragment, insecure issuer/endpoints, and non-loopback HTTP frontend origins fail configuration validation. The client secret never reaches the descriptor, cookies, stored flows or audit. Replica-set catalog storage is mandatory at startup in this mode.

The connection must already be an active, operator-installed `identity_connections` OIDC record for the exact issuer. Humans, exact issuer/subject links and tenant bindings must be provisioned explicitly. Login creates no principal, membership, default workspace or email link. Email/name/picture come from canonical directory profile or an explicitly migrated Google profile; token email/role/group claims do not create identity or grants.

The callback URI registered at the broker is exactly `FRONTEND_ORIGIN/auth/oidc/callback`. The broker must route the person to an approved customer federation connection. Vendor-specific organization/connection parameters are not yet supported; neither the browser nor a token can select an issuer, endpoint, connection record or OAuth client. Add any required vendor parameters as a reviewed operator-only contract after vendor selection.

## Login and callback

1. `GET /auth/method` exposes only `{kind, href}` with one fixed same-origin Google or OIDC start path. The frontend validates that pair, shows the relevant sign-in button, and retains the Google fallback only for an older platform's 404. An outage does not select another provider.
2. `GET /auth/oidc/start` creates a random flow cookie and a server record containing its hash, state, nonce, PKCE verifier, captured connection generation/client ID, ten-minute expiry and optional tenant routing hint. PKCE uses S256. `prompt=login` and `max_age=0` request fresh authentication. A hint cannot add a tenant to the verified cohort.
3. `GET /auth/oidc/callback` requires one bounded code/state, the corresponding cookie, current connection generation and an unexpired flow. It atomically consumes only the matching flow before exchange. A wrong state/new-tab cookie cannot consume the valid flow. Replay and a lost code-exchange response cannot retry the spent flow.
4. Only exact configured token/JWKS URLs are fetched. Redirects fail, each request has a five-second deadline, and replies are bounded to 256 KiB including chunked bodies. No userinfo/discovery request is needed. Signature checks are enabled explicitly, in addition to SDK issuer/audience/nonce/PKCE and time validation. ID tokens require fresh `auth_time`, integer issuance/expiry and a lifetime of at most ten minutes. Embedded keys/key URLs, unsupported purpose headers and unsupported algorithms fail.
5. The verified subject resolves to one pre-existing canonical human. Signed cohort claims must match live generations. Every captured tenant binding is revalidated in bounded batches inside the issuance transaction. Session insertion, deletion of the replaced main session and mandatory identity audit commit together. The cookie is emitted after commit. Audit/storage failure cannot create a partially authorized session or clear a previously valid cookie.
6. A single approved tenant or a valid routing hint selects the workspace; several approved tenants without a hint lead to `/select-tenant`. Verification failures return to one fixed `/login?error=oidc_failed` notice without provider diagnostics. The spent flow cookie is left to expire; an older callback never clears a newer flow cookie.

The SDK behavior is pinned by the installed dependency and production CommonJS smoke test. See the primary SDK documentation for [code grants](https://github.com/panva/openid-client/blob/main/docs/functions/authorizationCodeGrant.md), [signature verification](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md) and [configuration](https://github.com/panva/openid-client/blob/main/docs/classes/Configuration.md). Installed OAuth JWKS caching expires after five minutes and limits unknown-key refreshes; a failed fetch never extends freshness. Current connection disablement is rechecked independently of cached crypto keys.

## Signed browser cohort contract

The ID token must contain a non-user-writable claim named `https://truex.dev/browser-authz`:

```json
{
  "principal_generation": "principal-generation",
  "connection_generation": "connection-generation",
  "tenants": [
    {
      "tenant": "acme",
      "tenant_generation": "tenant-generation",
      "binding_generation": "binding-generation",
      "credential_generation": "credential-generation"
    }
  ]
}
```

Only those fields are accepted; one to 100 distinct tenants are allowed. Binding IDs and the external identity link are resolved server-side. Browser and access-token attestation claims have separate purposes; the API rejects ID tokens. Optional bounded `amr`/`acr` values are stored as authentication evidence, **not** as proof of an approved MFA level or administrator permission. A06/A12 must validate the broker's evidence contract before using it for step-up.

As with API credentials, whole-second `iat` must not precede the binding's millisecond issuance cutoff. A token minted in the same second as a new binding may require reissuance. A fresh timestamp alone cannot repair an old signed generation. A broker unable to attest these cohorts remains unsupported. The authenticated, constrained provider hook/provisioning integration that supplies them is still required before live rollout.

## Session and tenant lifecycle

Only the hash of a random 32-byte cookie token is persisted as the session ID. Browser cookies use HttpOnly, SameSite=Lax, Path=/ and no Domain; HTTPS uses Secure and the `__Host-` prefix. Raw ID/access/refresh tokens are not persisted or sent to the browser: the unused exchange tokens are discarded after verification. A future downstream OAuth use must add protected server-side storage deliberately.

`AuthSessionDocument.authorization` captures principal/connection/external-link generations, original issuance/authentication time, and the approved tenant cohorts. Rotation captures no new membership generations and preserves the original absolute deadline. Existing Google sessions retain their current lifetimes and legacy behavior; generationless cookies cannot acquire enterprise authority in OIDC mode.

Every account check validates the principal, connection and exact external link. Every selected-tenant request separately validates its captured binding/credential/tenant generations, statuses, expiry and migrated legacy status where applicable. Removal/reinvite never makes the old cohort valid again. Removing access to the selected tenant produces `TENANT_ACCESS_REVOKED` while preserving the account session, so a different still-approved tenant can be selected. Global principal/connection/link disablement invalidates the account.

`/auth/tenants` lists only captured, currently valid cohorts. The batch helper uses five catalog reads at 100 canonical tenants; the full account route adds its separate three-read identity validation. Migrated identities can add bounded legacy-profile/membership batches. Tenant switching validates the captured target, and replaces the old session plus mandatory switch audit in one transaction. Concurrent switches have exactly one winner. Cookie mutations continue to require Origin/JSON CSRF checks. Cookie and API callers produce the same principal/tenant/binding context, with distinct credential kinds and scope ceilings.

## Release boundary and remaining work

OIDC mode currently permits login, tenant selection, logout and `/api/me`. Resource, tool, model, stream and execution requests return `AUTHORIZATION_NOT_READY`; shared-password administration returns `NAMED_OPERATOR_REQUIRED`. Legacy signup/invite/workspace-management routes are not mounted and background legacy ingestion is not started. There is no flag to bypass this preparation gate. The frontend workspace picker and sign-out paths recognize OIDC sessions.

This is an implementation safeguard, not completion of tenant isolation. Direct runtime/model/tool surfaces remain separate A10/A15/A16 work. Authentication transactions are not sensitive-operation admission fences; A07/A13 must couple lifecycle changes to the authoritative policy epoch. Old application writers cannot safely operate against enforced enterprise tenants. Full named administration, provider hook authentication, SCIM, permission guards, operational recovery and live SSO/MFA/rotation/revocation validation remain release requirements.

Tests: `platform/test/authz-oidc.test.ts`, `authz-oidc-startup.test.ts`, `authz-api-auth.test.ts`, `frontend/test/authz-login.test.ts`, existing session/forwarder suites, and `scripts/authz-compiled-smoke.mjs`. Test broker transports use synthetic HTTPS identifiers and controlled responses; they prove local protocol handling, not a vendor's federation guarantees.
