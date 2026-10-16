# Tenant chat page: first-load latency

Status: open · Added 2026-10-17

## Problem

Opening `/t/:tenantId/chat` takes about 3.5 s before agents appear (local dev against Atlas). The requests run one after another, and each one costs 0.7–1.2 s:

```text
refresh 860 ms → me 705 ms → tenant 1.0 s → agents 1.19 s / models 0.9 s
```

Measured on 2026-10-17:

- The frontend `/api` forwarder adds about 5 ms.
- One MongoDB round trip from the dev machine to Atlas is about 280 ms (`/health/ready`).
- Each authenticated request makes 3–4 MongoDB calls in sequence: session, membership, tenant, then the actual query.

Production next to Atlas will be faster, but both causes below cost time wherever the database is.

## Causes

1. **The frontend waterfalls.** `agents` and `models` wait for `me` and `tenant` to finish, even though they only need the tenant id from the URL.
2. **Every request repeats the auth lookups in sequence.** Session, membership and tenant are read one after another on each request.

## Options

- Start `agents` + `models` in parallel with `me` + `tenant`. Render once all have settled; a 401/403 still wins.
- Run the independent auth lookups in parallel inside the guard where the data allows it.
- Short in-memory cache (a few seconds) for membership/tenant lookups. Must not delay revocation beyond the agreed window; check against the session-revocation rules before choosing a TTL.

## Not in scope

- The duplicate `me`/`tenant`/`agents`/`models` calls in the dev network tab. They come from React Strict Mode in `next dev` (effects run twice; the first result is discarded) and do not happen in a production build. Optional cosmetic fix: abort the first request with an `AbortController` on unmount.

## Done when

- Agents appear after at most two sequential round trips on first load.
- Measured before and after, locally and on the deployed stack, with numbers recorded here.
- Revocation and tenant-isolation tests still pass.
