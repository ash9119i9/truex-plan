# Application prompt caching

## Plan and scope

Baseline: `2417dff195b22f19b3dc5c29a48d6a30d3c02354`. Branch:
`feat/application-prompt-caching`.

Verification with a new provider is pending. See the
[retest note and completion criteria](PROMPT_CACHE_RETEST.md).

1. Preserve all prompt text, history, tool schemas, ordering and reasoning settings.
2. Add opt-in, validated provider controls to gateway model profiles. Keep existing defaults.
3. Scope supported Chat cache keys using the authenticated tenant, model profile,
   reusable prefix and (by default) runtime session key.
4. Report cache reads, writes, write TTL breakdown, uncached input and time to first text.
5. Test content equivalence, provider compatibility, tenant separation and runtime integration.
6. Compare the exact baseline gateway and candidate gateway against the configured real
   provider. Use synthetic reference documents and objective questions; record raw usage,
   cold/repeated latency and answer correctness. Never replace missing usage with invented savings.

## Configuration

Settings live in the catalog's `truex_models` documents. The gateway reads them;
this change does not update stored profiles or enable new options globally.

For an Anthropic-compatible profile:

```js
promptCache: {
  type: "anthropic",
  ttl: "5m",
  conversationBreakpoint: true
}
```

Absent settings preserve the current top-level automatic cache control and system
breakpoint. `conversationBreakpoint` adds an explicit breakpoint at the last text
or tool-result block for proxies that omit automatic caching. It leaves content
unchanged. `ttl: "1h"` is opt-in; its higher write rate may outweigh savings for
infrequent or short requests. `enabled: false` omits gateway cache markers; it
cannot force a provider to stop any provider-managed implicit caching.

For a Chat-compatible endpoint that explicitly supports OpenAI cache options:

```js
promptCache: {
  type: "chat",
  keyScope: "session",
  retention: "24h"
}
```

Chat options are omitted unless a policy is configured. Choose retention only if
the actual model and provider support it. Newer OpenAI Responses controls are not
translated into Chat options. Session scope uses the runtime's incoming cache key;
without one, no cache key is invented. `keyScope: "prefix"` deliberately allows
reuse across sessions within a tenant for matching system instructions and tools,
and requires a tenant-scoped signed gateway token. Hashes include profile and model;
keys and prompts are not logged. A request-body tenant id is never trusted.

Unknown fields, mismatched provider types and invalid values fail with 422 before
contacting the provider. Gemini has no new cache controls. Direct Responses requests
bypass the gateway and keep the pinned runtime's existing caching behavior.

## Measurement and limits

Gateway access logs include `cached_tokens`, `cache_write_tokens`, separate Anthropic
5-minute/1-hour writes when supplied, and `uncached_input_tokens` when both read and
write counts are available. Existing `input_tokens` still includes the full input.
Missing fields mean **unknown**, not zero. `ttftMs` measures the first nonblank text
delta; existing `ttfbMs` measures the first gateway stream event, which can precede
answer text or be generated from a thinking event.

Responses usage also carries cache-write tokens, but the pinned runtime may ignore
that additional field. The full write breakdown is retained in gateway logs rather
than claiming it is available in existing thread traces.

Token-weighted cache reuse is `sum(cache reads) / sum(total input)`; request hit rate
is the fraction of requests reporting nonzero reads. Neither alone measures cost.
Calculate cost from uncached input, reads, each write TTL and output using the
endpoint's actual rates. Do not apply official Anthropic prices to a third-party
proxy unless it uses those rates. Cache-write charges can make caching more expensive.

Caching should preserve generation behavior, but exact response text is not guaranteed.
Content-equivalence tests and an objective benchmark check for observable regressions;
a small benchmark does not establish quality for every task.

Provider references:
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Reproduce the live benchmark

```sh
npm --prefix model-gateway run benchmark:cache -- \
  --blocks 2 --requests 4 \
  --output ../benchmark-reports/prompt-cache-run
```

The default `--policy explicit` compares existing automatic caching with a 5-minute
TTL and the optional conversation breakpoint. `--policy default` compares the
baseline and new implementation with the same original cache settings. Both arms
use the baseline's prompt translation, history and tools without content changes.
Content equivalence is checked before running live requests. Cold partitions use
equal-length unique identifiers; tokens can differ slightly because tokenization
of those identifiers differs. Baseline caching is never disabled for the comparison.

The script selects the sole enabled Anthropic profile, or accepts `--profile <id>`.
It reads existing app environment files and catalog credentials without changing
the database. It archives baseline source into a temporary directory, starts two
temporary gateways, alternates request order, and closes its gateways/database and
removes its scratch directory when finished. Each request has a two-minute deadline.

Each call looks up one known invoice from a synthetic 240-invoice document. The
script scores the returned fields objectively and records calls with no answer text,
including provider tool requests, separately. It measures the first nonblank text
delta and total duration; correct-answer duration excludes no-answer responses.
It is a one-call test and does not execute requested tools or benchmark full agent turns.

Optional `--rates <path>` reads a JSON file with `currency`, `source`, and per-million
rates `input`, `read`, `write5m`, `write1h`, `output`. Without rates and full provider
cache usage, monetary savings remain unverified. Reports contain synthetic answers,
whitelisted usage, timings and source digests, never provider keys or request headers.
