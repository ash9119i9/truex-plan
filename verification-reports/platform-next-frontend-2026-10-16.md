# Platform-next frontend integration — 2026-10-16

Implemented users/tenants tasks 7a and 7b on `truex_planv2`.

## Behavior

- The existing Google login design uses the platform-next start/callback flow.
  `/auth/complete` and `/` discover the account and enter `/t/<tenantId>/chat`.
- The tenant layout verifies the URL's tenant against `/api/v1/tenant`, independently
  of account discovery and other tabs. Invalid, absent or unauthorized memberships
  cannot render the workspace. Multiple memberships at entry show an explicit
  blocked state while the chooser remains deferred; direct authorized routes work.
- Access tokens stay in memory. Refresh is shared within a tab and serialized with
  Web Locks across tabs where supported. Logout clears private state immediately;
  failed logout is reported honestly. Refresh/account-switch/logout races cannot
  replay a mutation as another person or restore an old view.
- API responses are invalidated on identity/tenant changes, including changes
  during response-body parsing. API errors retain the platform's code/message.
- Chat currently shows the shell only. The old chat source moved unchanged from
  the starting working tree to `frontend/legacy/chat.tsx`, outside the route tree.
  Its existing behavior tests still run. Retired invitation URLs redirect to login.
- No production backend behavior, dependencies, schemas or migrations changed.

## Evidence

| Check | Result |
| --- | --- |
| `npm --prefix frontend test` | 408 passed; 0 failed/skipped |
| `npm --prefix frontend run typecheck` | Passed |
| `npm --prefix frontend run build` | Passed, including completion and tenant routes |
| `npm --prefix platform-next test` | Baseline: 156 passed; production sources unchanged |
| `npm --prefix platform-next run typecheck` | Passed, including the browser fixture |
| `npm --prefix platform-next run build` | Passed |
| `npm --prefix platform-next run format:check` | Passed |
| Changed frontend file formatting | Passed |
| Broad frontend formatting | 27 pre-existing, untouched files fail; no mass reformat performed |
| `npm run check:secrets` | Passed (tracked root configuration scan) |
| `git diff --check` | Passed |

New tests first demonstrated failures for explicit tenant routing, malformed IDs,
tenant substitution, logout during refresh/request, delayed identity checks,
account-switch retries and delayed API response bodies. They pass after the fixes.
An adversarial mutation inverted the gate's stale-check condition: 10 of 11 gate
tests failed. The original condition was restored before the final build.

Browser verification used the actual Next app/proxy, Nest handlers, Mongo replica
set and signed local Google fixture. No real Google account or production data:

- Fresh sign-in redirects through completion into the default tenant shell.
- Reload and a second tab retain their route and authorized workspace.
- Signing out in one tab clears both private views, with distinct local/remote
  sign-out notices; a later fresh sign-in works.
- A foreign tenant URL shows recovery controls and no private workspace.
- Backend unavailable shows retry, not a false sign-out.
- Widths 320, 768, 1024 and 1440 match document scroll width; no horizontal overflow.
- Light/dark toggle works; shell controls have accessible names and native focus.
- No hydration/application exception on the completed sign-in path. Expected
  401/403/503 probes appear as network errors; development hot edits briefly
  produced a Fast Refresh dependency-array warning, absent after navigation.

Reproduce using the fixture commands in `platform-next/README.md`.

## Remaining release work

`npm audit --omit=dev` reports zero platform-next production findings. The existing
frontend lockfile reports **1 critical and 2 high vulnerable packages**:

- `next` (installed 16.3.5): includes next/og RCE, image-optimization SSRF and
  additional cache/disclosure advisories.
- `sharp`: librsvg vulnerability, fixed in 0.35.5 according to the registry audit.
- `source-map-js`: indexed source-map event-loop denial of service.

These dependencies were already present and were not upgraded as part of the
frontend integration. Investigate reachability and land separately verified
patch upgrades before production release; this report is not a release approval.
The new shell does not introduce image processing or Open Graph handlers.

Real Google staging validation, production origin/cookie configuration, production
cutover and any performance/load certification remain open. Chat execution,
invitations, analytics and tenant chooser UI remain deferred. Existing login
marketing copy still describes the broader product; the shell explicitly states
that chat is not yet available.

All work remains in the existing working tree alongside prior uncommitted work;
no commit, push, deployment or old-data migration was performed.
