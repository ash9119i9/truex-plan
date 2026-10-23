# Security Audit — Truex AI Platform

**Date:** 2026-10-23
**Scope:** `platform-next/`, `runtime-adapter/`, `model-gateway/`, `frontend/`, `shared/`, repository/deployment hygiene
**Out of scope (per request):** `platform/` and `agent-core/` (legacy, being migrated), `Millions/`, `browser-companion/`
**Mode:** Source-only, read-only, partial coverage
**Auditor:** Automated review using the Cloudflare `security-audit` skill (`.claude/skills/security-audit`)
**Changes made:** None to application source. This document is the only artifact.

---

## 1. Executive summary

The new stack's core security design is substantially better than typical
multi-tenant AI products. I found **no authentication bypass, no cross-tenant
object reference, and no tenant-isolation break** in the reviewed source.

What did surface falls into five buckets:

1. **A vulnerable public-facing frontend build.** Next.js 16.3.5 carries eleven
   advisories, including unauthenticated RCE class issues. The specific RCE
   prerequisites (image optimizer with SVG, `next/og`, `use cache`) do not
   appear reachable in this app today, but this is the internet-facing entry
   point and must be patched before any customer sees it.
2. **An authorization-revocation window.** Tenant routes verify the access
   token's signature only, so a removed member, downgraded admin, disabled
   tenant, or logged-out stolen token remains usable for up to five minutes.
3. **Credential concentration.** The model gateway issues non-expiring bearer
   tokens, and the runtime adapter authenticates every tenant with one static
   bearer token. Neither is exploitable without a secret disclosure, but both
   turn a single disclosure into an unbounded, all-tenant event.
4. **A trust-boundary mistake in MCP approvals.** Tools that an MCP server
   annotates as read-only run without asking the user. A malicious or
   compromised connector can therefore execute writes silently.
5. **Thin abuse and cost controls.** The only limiter is an in-memory,
   per-process, per-member message rate limit. No per-tenant token or currency
   budget was found, and no in-application limit exists on the auth endpoints.

Separately, several **enterprise-readiness gaps** (SSO/SCIM, customer-managed
keys, retention/export, SIEM audit, CI security gates) are not vulnerabilities
but will block procurement at the scale this product targets.

### Findings at a glance

| ID | Finding | Verdict | Severity |
|----|---------|---------|----------|
| F-1 | Next.js 16.3.5 with 11 advisories including RCE class | confirmed | **High** |
| F-2 | Tenant authorization revocation lags up to 5 minutes | confirmed | **Medium** |
| F-3 | MCP approval policy trusts server-supplied read-only annotations | confirmed | **Medium** |
| F-4 | Model-gateway bearer tokens never expire; `exp` is ignored | confirmed | **Medium** |
| F-5 | One static bearer token grants every tenant's runtime data | confirmed | **Medium** |
| F-6 | Abuse limits are per-member, in-memory, per-process; no spend quota | confirmed | **Medium** |
| F-7 | `deploy/websearch.env` contains a token and is not gitignored | confirmed | **Low** |
| F-8 | CSP and security headers are effectively absent | confirmed | **Informational** |
| F-9 | Unauthenticated adapter `/health` exposes operational counts | confirmed | **Informational** |

Severity uses the skill's anchors. "Confirmed" means the code establishes the
property; "needs_validation" (Section 4) means a required deployment fact is not
in the repository, so no severity is assigned.

---

## 2. Trust boundaries

```
Browser
  │  refresh cookie (HttpOnly, SameSite=Strict, __Host-)
  │  access token in memory, Authorization: Bearer
  ▼
frontend (Next.js, public)  ── /api/* ──►  platform-next (NestJS)
                                              │  Mongo: catalog + one DB per tenant
                                              │  S3: chat file versions
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
                     runtime-adapter                  model-gateway
                     (Codex per chat)                 (provider keys)
                              │
                              ▼
                     tenant MCP servers / OAuth providers
```

Lower-trust inputs: the browser, chat text, files produced inside a chat
workspace, MCP tool outputs and annotations, tenant-supplied connector choices,
and any content the model reads. Higher-value assets: other tenants' data,
connector OAuth tokens, provider API keys, the model budget, and the runtime
host.

---

## 3. Confirmed findings

### F-1 — Public frontend runs a vulnerable Next.js

**Verdict:** confirmed (dependency present; exploitability of the RCE class not
demonstrated)
**Severity:** High
**Location:** `frontend/package.json:21` (`"next": "^16.0.0"`, lockfile resolves
**16.3.5**)

`npm audit --omit=dev` reports **1 critical and 2 high** in `frontend` (the three
backend packages report zero). The advisories include:

- Unauthenticated RCE in the Image Optimization API when SVG is used
  (GHSA-2464-fhr4-w9xw)
- RCE in `next/og` `ImageResponse` (GHSA-vcvr-r3jv-pc5j)
- RCE in `use cache` functions returning typed arrays (GHSA-673q-mjm6-r5xr)
- SSRF in Image Optimization (GHSA-cjq9-62q9-8jv4)
- SSG/ISR cache poisoning and cache leak advisories
  (GHSA-4jqv-mc3x-m676, GHSA-mcj8-r9mp-w47p, GHSA-h694-7cp9-m8p3)
- Dev-server MCP information disclosure (GHSA-39w2-rjm5-chcv)

**Reachability:** I found no `next/image`, no `ImageResponse`, no `"use cache"`,
and no `images.remotePatterns` or `dangerouslyAllowSVG` in the app, which makes
the RCE advisories unlikely to be reachable today. Cache-poisoning and metadata
route information disclosure may still apply to any statically rendered route.

**Fix:** upgrade to the latest patched release that `npm audit` reports as
fixed, rebuild, then re-run
`npm audit --omit=dev` and assert zero critical/high. Add the audit as a CI gate
so the next vulnerable bump is caught before merge, not by a customer scanner.

**Verification:** `node -p "require('next/package.json').version"` and
`npm audit --omit=dev` in `frontend/` must both be clean.

---

### F-2 — Tenant authorization revocation lags up to five minutes

**Verdict:** confirmed
**Severity:** Medium
**Location:** `platform-next/src/common/access/tenant.guard.ts:91`,
`platform-next/src/modules/sessions/session-policy.ts:11`

Account routes (`/api/v1/me`, auth) call `sessions.authenticate()`, which reads
the session and account on every request, so logout and disabling take effect
immediately. Every tenant route (`chats`, `agents`, `connectors`, `models`,
`tenant`) goes through `TenantGuard`, which calls `verifyRequestToken()` —
signature and claims only, **no database read**. Access tokens live 300 seconds.

**Impact:** after a member is removed, an admin is downgraded, a tenant is
disabled, or a session is revoked, that token still reads and writes tenant data
for up to five minutes. The same window applies to a stolen token after the
victim logs out. Blast radius is limited to that tenant and that token's
lifetime, but it is a real failure of an explicit control (authorization
revocation), not a theoretical one.

**Precondition:** the actor holds a still-valid access token issued before the
change.

**Fix (smallest effective):** add a monotonically increasing session/per-user
epoch claim and check it in `TenantGuard` against a small shared cache (Redis or
the catalog, one read per request), or issue tenant-scoped tokens with a
60-second lifetime and refresh before expiry. The invariant to enforce: *a
revoked session or changed membership cannot authorize a tenant request.*

**Regression test:** create a session, revoke it (or disable the membership),
immediately call `GET /api/v1/chats?tenantId=…` with the old token, expect 401.
Today that test fails; it should pass after the fix.

**Tracking:** already recorded as `backlog/security/01-access-token-revocation.md`.

---

### F-3 — MCP tool approval trusts server-supplied annotations

**Verdict:** confirmed
**Severity:** Medium
**Location:** `runtime-adapter/src/codex/config.ts:84`
(`default_tools_approval_mode: "auto"`), policy described at
`runtime-adapter/src/codex/config.ts:49-58` and `:101`, `:125`

Every MCP server entry is configured so Codex runs a tool automatically when the
server marks it read-only, and asks the user only for tools it does not. The
annotation (`readOnlyHint`) is supplied by the MCP server, which is a separate
trust boundary — a third-party service or a compromised credential at that
service.

**Impact:** a malicious or compromised connector marks a destructive tool as
read-only. The model calls it, it runs without a prompt, using the user's OAuth
token, against the user's data (delete a repository, send mail, modify records).
The platform has no independent view of which tools are safe.

**Precondition:** a curated connector's server is malicious or compromised. The
platform's catalog reduces but does not remove this: third-party MCP servers are
the supply chain.

**Fix:** keep approvals but make the allowlist **platform-owned**: for each
catalog connector, list the read-only tool names that may run unattended; every
tool not on that list requires approval regardless of its annotation. This also
gives you a reviewable artifact for enterprise customers (which tools can act
without a human).

**Test:** a fake MCP server returns `readOnlyHint: true` for a write tool; the
run must still emit an approval request.

---

### F-4 — Model-gateway bearer tokens never expire

**Verdict:** confirmed
**Severity:** Medium
**Location:** `shared/gateway-token.ts:6` (design note), `:34` (older `exp`
claims are ignored), `model-gateway/src/server.ts:143` (only profile-enabled and
key-presence are checked), `runtime-adapter/src/codex/config.ts:161`
(`experimental_bearer_token` lives in the Codex process memory)

The token is an HMAC over `{profile, tenant}`. It has no expiry and no
revocation list. Codex keeps it for the thread's lifetime. Revocation means
disabling the model profile for everyone or rotating `MODEL_GATEWAY_SECRET`,
which invalidates every tenant's tokens at once.

**Impact:** a token disclosed through a crash dump, core file, debug log,
support bundle, memory scrape on a compromised runtime host, or a future logging
mistake grants indefinite model spend on that profile. It cannot be scoped to a
single tenant's budget because the gateway has no quota. The tenant label `t` is
explicitly advisory ("grants nothing"), so a leaked token can also be used to
attribute spend to the wrong tenant in logs.

**Fix:** short-lived tokens (for example 15 minutes) minted per run, with the
platform refreshing on resume, or add `exp` + `jti` and a small revocation set
the gateway consults. Pair this with per-tenant budgets at the gateway so a
stolen credential has a bounded cost.

**Test:** an expired token, and a token whose `jti` was revoked, both return 401.

---

### F-5 — One static bearer token grants every tenant's runtime data

**Verdict:** confirmed (architecture)
**Severity:** Medium
**Location:** `runtime-adapter/src/server.ts:70` (single `RUNTIME_ADAPTER_TOKEN`,
constant-time compare), routes at `:126`, `:138`, `:167` take `tenantId` from the
query string

The adapter is a single service with a single credential. Once authenticated,
the caller names any tenant and any chat; the adapter returns that chat's
history and workspace files, and will start a run in that tenant. Tenant
isolation is entirely a property of the platform sending the right ID.

**Impact:** disclosure of `RUNTIME_ADAPTER_TOKEN` is a full cross-tenant read of
conversation history and generated files, plus the ability to run the agent as
any tenant. The token is long-lived and shared by every deployment of the
platform that points at this adapter.

**Precondition:** secret disclosure (host compromise, config leak, memory dump).

**Fix:** per-instance mTLS or a short-lived signed token that carries the tenant
and is verified on every route, so a leaked credential is narrow and expires.
Network-policy the adapter so only the platform can reach it. If customers
require it, dedicate an adapter host/VM per tenant tier.

---

### F-6 — Abuse and cost controls are shallow

**Verdict:** confirmed
**Severity:** Medium
**Location:** `platform-next/src/modules/chats/chats.service.ts:1467`
(`admitSend`), `:181` (`recentSends` in-process `Map`), comment at `:1462`
("One platform process in v1")

The only limiter is ~20 new messages/minute per member, held in a `Map` inside
one Node process. No in-application limit was found on `/auth/google/start`,
`/auth/refresh`, connector verification, or agent creation. No per-tenant token
or currency budget exists in the reviewed paths — the only quota mechanism is
`agent_quota_locks` for agent creation — and the gateway checks only that the
profile exists and is enabled.

**Impact:**

- **Cost:** a compromised account or a scripted client can consume model budget
  without bound. With N replicas the effective message limit is N×20/min, and a
  restart resets it.
- **Availability:** auth endpoints and connector verification are unthrottled
  and can be used to generate outbound requests or load.
- **Scale:** the in-memory map grows with active senders and is per-instance, so
  it is not a correctness-preserving control once you run more than one process.

**Fix:** a shared limiter (Redis) keyed `tenant:user`; a per-tenant daily token
and currency budget enforced before dispatch and metered from gateway usage; and
basic limits on `/auth/*` and connector verification. Return 429 with
`Retry-After`, and emit a metric when a tenant crosses 80% of budget.

**Test:** two platform instances, 21 sends in a minute from one member → refused
on both; budget exhausted → run creation refused with a clear error.

---

### F-7 — Secret file is outside `.gitignore`

**Verdict:** confirmed
**Severity:** Low
**Location:** `deploy/websearch.env` (untracked; `git check-ignore` returns no
match)

The file holds a live service token for the legacy search stack and is not
matched by `.gitignore` (which covers only `.env` and `.env.local`). A single
`git add -A` publishes it. I did not open the file.

**Fix:** add `deploy/*.env` (or `*.env` with an explicit allowlist) to
`.gitignore`, move the value to a secret manager, and rotate it on the
assumption it may already have been copied into a fork, backup, or build cache.
Add a secret scan (gitleaks/trufflehog) to CI.

---

### F-8 — CSP and security headers are effectively absent

**Verdict:** confirmed
**Severity:** Informational
**Location:** `frontend/next.config.ts:5-15`

The policy is `frame-src 'self'; object-src 'none'; base-uri 'self'`. With no
`default-src` or `script-src`, it does not restrict scripts and therefore does
not mitigate XSS. There is no HSTS, `X-Content-Type-Options`,
`frame-ancestors`, or `Referrer-Policy`.

**Why informational:** I found no XSS sink. `react-markdown` is used without
`rehype-raw`, so raw HTML in model output is not rendered; the only
`dangerouslySetInnerHTML` is a constant theme bootstrap script
(`frontend/app/layout.tsx:19`). This is defense-in-depth and a checkbox on
enterprise questionnaires, not a demonstrated vulnerability.

**Fix:** `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self'
'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors
'none'; base-uri 'self'; object-src 'none'`, plus HSTS, `nosniff`, and
`Referrer-Policy: strict-origin-when-cross-origin`. Roll out in report-only mode
first to avoid breaking inline styles.

---

### F-9 — Adapter health endpoint discloses operational counts

**Verdict:** confirmed
**Severity:** Informational
**Location:** `runtime-adapter/src/server.ts:60-67`

`GET /health` is unauthenticated and returns `activeRuns`, `processes`, and
`draining`. Useful for reconnaissance (capacity, restart timing). Keep a minimal
public liveness response and move the details behind the existing bearer check.

---

## 4. Needs validation (no severity)

These are real boundary questions whose answer depends on deployment facts that
are not in the repository. Per the audit discipline, no severity is assigned
until the control is observed.

### N-1 — TLS between internal services

`platform-next/src/config/chat-config.ts:36` accepts `http://` for
`RUNTIME_ADAPTER_URL` and `MODEL_GATEWAY_URL`. Those hops carry connector OAuth
tokens, prompts and completions, and the gateway token. **Missing fact:** whether
production uses `https://` with certificate verification (or mTLS and a service
mesh). Recommend rejecting non-https unless the host is loopback, so a
misconfiguration fails closed.

### N-2 — Data-store posture

Not described in the repository: MongoDB authentication, TLS, encryption at
rest, key management, backup access; S3 public-access block, bucket policy,
default encryption, and whether customer-managed keys are offered. These are
standard enterprise questionnaire items and need evidence, not code.

### N-3 — Runtime host isolation

Codex runs under a process sandbox (deny state dir and `/tmp`, network disabled,
environment not inherited). That is strong inside one process, but it is not a
VM or container boundary. One adapter host holds every tenant's connector tokens
in memory. **Missing fact:** whether each customer gets a dedicated adapter/VM
or shares a host. If shared, a sandbox escape is cross-tenant.

### N-4 — Edge protections and forwarded-header trust

`frontend/lib/forward.ts` forwards `X-Forwarded-For` only when
`TRUST_FORWARDED_FOR=on`, which is correct. **Missing fact:** whether that is
set, whether the platform is reachable only through the frontend, and whether a
WAF or edge rate limit exists. Without it, per-address limits are meaningless
and the origin can be hit directly.

### N-5 — Legacy exposure during migration

The frontend calls `/auth/invites/:token` and observability endpoints that do
not exist in `platform-next`. **Missing fact:** which backend serves `/api` in
production today, and whether `platform/` and `agent-core/` are still
internet-reachable for existing tenants. They were excluded from this review by
request, so they are the largest unmeasured surface.

---

## 5. Verified controls

These were checked and are sound; they are the reason the core does not have a
tenant-isolation finding.

**Sessions and sign-in**

- Ed25519 JWS (`EdDSA`, `at+jwt`), strict header shape, no algorithm
  negotiation, bounded token length, canonical base64url, issuer/audience/purpose
  checks (`platform-next/src/modules/sessions/access-token.ts`).
- Refresh credentials: 32 random bytes, only SHA-256 hashes stored, single-use
  rotation with a five-entry history, timing-safe comparison, reuse outside a
  30-second race grace revokes the session and writes an audit record
  (`sessions.service.ts:217`).
- Cookies: `HttpOnly`, `Path=/`, `SameSite=Strict`, `Secure` plus `__Host-`
  prefix when https; only one cookie value accepted (`common/http/cookies.ts`).
- OAuth: PKCE S256, state and nonce in a `__Host-` cookie, ten-minute TTL,
  timing-safe state comparison, Google `email_verified === true` required
  (`google-oidc.ts:193`), redirects only to fixed paths on the configured
  origin (no open redirect).

**Tenant isolation**

- Tenant database is derived server-side from the signed tenant kind and ID,
  never from request data (`tenant.guard.ts`, `sessions.service.ts`).
- Every chat, run, message and file query carries `ownerId` from the caller's
  context; another member's chat and a missing chat are indistinguishable
  (`chats.service.ts:817`, `:830`, `:860`, `:1344`).
- File objects are keyed `t/<tenant>/c/<chat>/f/<file>` and reads check chat and
  owner (`chat-files.ts:274`, `:311`).
- Connector tokens: AES-256-GCM with per-row IV, AAD binding
  tenant+owner+connector+key id, key rotation supported, one indistinguishable
  error for every failure (`token-crypto.ts`).

**Runtime boundary**

- Bearer token compared in constant time over fixed-length digests.
- Strict JSON content type and 256 KB body cap.
- Workspace reads reject dot segments, absolute paths, backslashes, NULs and
  symlinks; `O_NOFOLLOW`, `O_NONBLOCK`, real-path recheck via `/proc/self/fd`
  on Linux, 20 MB cap (`runtime/files.ts:105`, `:116`).
- Run lookup requires both `tenantId` and `chatId` to match; another chat's run
  looks unknown.
- Codex sandbox: state directory denied, `/tmp` denied, workspace and per-chat
  scratch writable, network disabled, `inherit: "none"` environment, toolchains
  read-only, dangerous git commands prompt, coding opt-in via `=1`
  (`codex/coding.ts`).
- Loopback MCP URLs only when `ADAPTER_ALLOW_LOOPBACK_MCP=1` (test-only), host
  bound to `127.0.0.1` by default.

**Model gateway**

- Provider keys never leave the server; Codex holds only a profile token.
- Profile lookup per request, disabled profile refused.
- Prompt cache key includes tenant, profile, model, tools and system messages;
  a missing session key does not broaden sharing to the tenant
  (`model-gateway/src/prompt-cache.ts`).
- No request bodies are logged (rate-limit headers only); body cap; graceful
  drain; upstream timeouts.

**Frontend transport**

- Header allowlist drops host, forwarded headers and anything a client forges to
  claim identity; `/admin` and `/v1/admin` blocked; encoded traversal refused;
  2 MB cap; `no-store` and `Vary: Cookie, Authorization`; upstream cancellation
  on browser disconnect (`frontend/lib/forward.ts`).

**Repository**

- No tracked secrets matched high-signal patterns (`sk-`, `ghp_`, `AKIA`,
  private-key headers).
- `platform-next`, `runtime-adapter`, `model-gateway`: 0 vulnerabilities from
  `npm audit --omit=dev`.

---

## 6. Enterprise readiness gaps (not vulnerabilities)

These will not appear in a scanner but will appear in a customer's security
review. None of them is addressed by the code today.

| Area | Current state | Required for enterprise |
|------|---------------|--------------------------|
| Identity | Google consumer OIDC only | SAML/OIDC enterprise SSO, SCIM provisioning, domain capture, enforced MFA, IP allowlisting |
| Keys | One platform key set for connector tokens | Customer-managed keys (BYOK/CMK), KMS integration, documented rotation |
| Audit | Operator and auth actions audited; ordinary reads not | Exportable audit log to SIEM, admin-access logging, retention controls |
| Data lifecycle | No export/delete/retention controls in the reviewed code | Per-tenant export, deletion proof, configurable retention, DPA/subprocessor list |
| Spend | No per-tenant budget | Quotas, alerts, invoicing-grade metering |
| Residency | Unspecified | Region pinning for Mongo/S3/model routing |
| Assurance | No CI workflows, no SBOM, no pen-test or SOC 2 artifacts | Dependency/secret/SAST gates, SBOM, annual pen test, SOC 2 / ISO 27001 |

The missing CI workflow is what allowed F-1 to ship; it is also the cheapest gap
to close.

---

## 7. Remediation plan

**P0 — this week**

1. F-1: upgrade Next.js, rebuild, re-run `npm audit --omit=dev`.
2. F-7: ignore `deploy/*.env`, rotate the token, enable secret scanning.

**P1 — before GA / before the first enterprise pilot**

3. F-2: close the revocation window with a session epoch or 60-second tenant
   tokens; ship the regression test.
4. F-3: replace annotation trust with a catalog-owned read-only tool allowlist.
5. F-4 + F-5: short-lived, tenant-scoped gateway and runtime credentials; mTLS
   or network policy around the adapter.
6. F-6: shared rate limiter plus per-tenant spend budgets and 429s.

**P2 — before the first large contract**

7. N-1/N-2/N-3: TLS enforcement in config, documented data-store posture,
   per-customer host isolation where required.
8. Enterprise gaps: SSO/SCIM, CMK, audit export, retention, CI gates and SBOM.
9. Re-test F-2/F-3/F-4/F-5 in staging with two tenants and a malicious MCP
   fixture.

**P3 — hardening**

10. F-8 headers, F-9 health surface, per-IP limits at the edge.

---

## 8. Coverage and limitations

**Covered by reading source:** authentication and session lifecycle; OAuth
(Google and connector); tenant guard and catalog membership; chats, runs,
streams and files; connector catalog, OAuth discovery, token encryption, MCP
verification; agent service and quotas; model gateway server, profiles, prompt
cache, upstream and logging; runtime adapter HTTP surface, manager, chat
executor, Codex config and coding sandbox, workspace file access, config;
frontend API forwarder, identity handling, invite flow, visualization and
rendering sinks; configuration loaders; deployment folder; dependency trees;
tracked-secret scan.

**Not covered:** the legacy `platform/` and `agent-core/` applications
(excluded by request), `Millions/`, `browser-companion/`, mobile/desktop code,
infrastructure-as-code (absent), live exploit validation, load or fuzzing
tests, and the full six-phase audit protocol with a coverage ledger and
independent verifier agents (the run was read-only and artifact-free by
instruction). Unit and integration tests were not executed; no behavior was
changed.

**Confidence:** high for the source properties described as confirmed; low for
anything depending on deployment (Section 4). This is a partial, source-only
pass and should be paired with a staging penetration test before an enterprise
launch.

---

## Appendix A — Dependency audit results

```
platform-next     0 vulnerabilities
runtime-adapter   0 vulnerabilities
model-gateway     0 vulnerabilities
frontend          3 vulnerabilities (1 critical, 2 high)
                  next 16.3.5   — 11 advisories, fix available
                  sharp         — librsvg CVE-2026-96889
                  source-map-js — event-loop DoS (build-time transitive)
```

Command: `npm audit --omit=dev --json` in each package directory.

## Appendix B — Non-destructive commands used

- `npm audit --omit=dev --json` (four packages)
- `git grep` for secret patterns across tracked files
- `git check-ignore -v deploy/websearch.env`
- `git status --short` (no writes performed)
- Source reads and `grep` across the four services

No tests, servers, migrations, or external requests were run against live
systems.

## Appendix C — Primary files reviewed

```
frontend/lib/forward.ts
frontend/app/api/[...path]/route.ts
frontend/lib/identity.ts
frontend/lib/invite-form.ts
frontend/next.config.ts
frontend/package.json

platform-next/src/common/access/authenticated.guard.ts
platform-next/src/common/access/tenant.guard.ts
platform-next/src/common/http/cookies.ts
platform-next/src/common/http/error-envelope.filter.ts
platform-next/src/modules/auth/*.ts
platform-next/src/modules/sessions/*.ts
platform-next/src/modules/chats/chats.controller.ts
platform-next/src/modules/chats/chats.service.ts
platform-next/src/modules/chats/chat.ts
platform-next/src/modules/chats/chat-files.ts
platform-next/src/modules/chats/run-executor.ts
platform-next/src/modules/chats/chat-store.ts
platform-next/src/modules/connectors/*.ts
platform-next/src/modules/agents/agents.service.ts
platform-next/src/modules/tenants/tenants.service.ts
platform-next/src/modules/memberships/memberships.service.ts
platform-next/src/modules/operator/operator.service.ts
platform-next/src/config/*.ts
platform-next/src/app.ts

runtime-adapter/src/server.ts
runtime-adapter/src/config.ts
runtime-adapter/src/contract.ts
runtime-adapter/src/runtime/manager.ts
runtime-adapter/src/runtime/files.ts
runtime-adapter/src/runtime/chat.ts
runtime-adapter/src/codex/config.ts
runtime-adapter/src/codex/coding.ts

model-gateway/src/server.ts
model-gateway/src/prompt-cache.ts
model-gateway/src/logging.ts
model-gateway/src/profiles.ts
model-gateway/src/upstream.ts
shared/gateway-token.ts
```

---

*Report generated 2026-10-23. Findings describe source conditions at that time;
any change to the files above requires re-validation.*
