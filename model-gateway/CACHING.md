# Gateway caching and measurements

Profiles and credentials stay process-local. Expired profiles now block for an
authoritative refresh; Mongo failure does not dispatch using an expired profile.
There is no stale-while-revalidate fallback. Source/capacity failures return a retryable
503 without source details; they never dispatch an expired or keyless profile. Positive profile entries default to
30 seconds, missing profiles to 5 seconds, resolved secrets to 5 minutes. A profile
cannot extend the remaining expiry of a reused secret. Revocation inside these
explicit freshness windows is not instantaneous, and already-dispatched calls
cannot be cancelled by a cache clear. Direct Responses routes bypass this gateway.

`clear()` aborts/fences active fills, including secret resolution. Current catalog
writers have no cross-replica invalidation connection: changing credentials or
disabling a model must allow the defined freshness window or restart/clear every
gateway process. Keys and source profile values never leave these local caches.

| Environment variable        | Default | Meaning                                                                       |
| --------------------------- | ------- | ----------------------------------------------------------------------------- |
| `PROFILE_CACHE_TTL_MS`      | 30000   | Profile freshness; zero disables retention                                    |
| `SECRET_CACHE_TTL_MS`       | 300000  | Secret freshness; zero disables retention                                     |
| `PROFILE_CACHE_MAX_ENTRIES` | 256     | Maximum entries in each profile/secret cache                                  |
| `PROFILE_CACHE_MAX_BYTES`   | 2097152 | Maximum serialized profile/key bytes                                          |
| `SECRET_CACHE_MAX_BYTES`    | 262144  | Maximum serialized secret/key bytes                                           |
| `PROFILE_CACHE_MAX_PENDING` | 32      | Maximum outstanding loads per profile/secret source, including ignored aborts |
| `PROFILE_CACHE_MAX_WAITERS` | 256     | Maximum callers awaiting profile results, including same-key joiners          |
| `PROFILE_LOOKUP_TIMEOUT_MS` | 3000    | Deadline for source lookups                                                   |
| `CACHE_PROVIDER_CONTROLS`   | off     | `on`, `1` or `true` enables declared optional provider controls               |

Limits apply to the serialized working set; JavaScript objects, connections and
in-flight results add overhead. Admission excludes oversized cached entries;
load deadlines, source cancellation and concurrency bounds protect pending work.
Waiter admission also bounds hot-key singleflight fan-out; clearing the cache does
not reset reservations before waiting callers or abort-ignoring sources settle.

Provider caching still requires an eligible stable prefix. The existing Anthropic
automatic/system ephemeral cache markers remain enabled. Optional controls require
both `CACHE_PROVIDER_CONTROLS` and an explicit `promptCache` capability on the
catalog model profile, verified against that endpoint/model:

```json
{ "wireApi": "chat", "promptCache": { "key": true, "retention": "24h" } }
```

The chat adapter accepts only the declared `in_memory`/`24h` retention values and
scopes incoming runtime cache keys by HMAC with the signed tenant and profile.
The key does not grant access. Unsupported capabilities and request-supplied
retention are ignored. Do not declare retention for models that reject it.

```json
{ "wireApi": "anthropic", "promptCache": { "ttl": "1h" } }
```

Anthropic accepts declared `5m`/`1h` TTLs on its existing automatic and system
breakpoints. There is no Gemini explicit-cache lifecycle manager or Responses
gateway adapter. Newer OpenAI `prompt_cache_options`/breakpoints cannot be added
to direct requests by changing this gateway; the pinned runtime does not emit
those fields. See the [OpenAI guide](https://developers.openai.com/api/docs/guides/prompt-caching/)
and [Anthropic guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Read/write cache counters flow through Responses SSE and privacy-safe access
logs. Total input already includes cache reads/writes: budgets and total tokens
must not add them again. Missing counters from other providers remain unknown.

Run `npm --prefix model-gateway run bench:cache` for an **offline synthetic**
authority/cache benchmark. It reports disabled/cold/warm/outage latency and
origin counts; these numbers are not production Mongo or model TTFT measurements.

Run `npm --prefix model-gateway run probe:cache` for a dry run with no network
calls. An explicitly requested `-- --live` run makes two billable synthetic
requests using `PROBE_GATEWAY_URL`, `PROBE_PROFILE_ID`, and `PROBE_GATEWAY_TOKEN`.
Use approved non-production credentials and verify model eligibility, data
retention and test budget. Output contains counts/timings, never credentials,
prompt bodies, model output or provider error bodies.
