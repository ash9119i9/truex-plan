# Prompt caching: implementation and real benchmark results

The application now supports opt-in provider caching controls and accurate cache
usage reporting. **These tests did not establish cost savings with the configured
proxy. Do not enable the new options on that profile based on these results.**

Branch: `feat/application-prompt-caching`. Baseline source:
`2417dff195b22f19b3dc5c29a48d6a30d3c02354`. At benchmark time the candidate was an
uncommitted working tree; each live report records source digests. Stored model
configuration was not changed. No commit, push, deployment or production traffic
switch was performed as part of those benchmark runs.

Follow-up recorded on 2026-10-02: **retest with a new model provider and verify
caching, cost and quality before enabling the new settings**. See the
[pending retest note](../docs/PROMPT_CACHE_RETEST.md).

## Implemented

- Provider-specific settings with validation before contacting the provider.
- Scoped, hashed Chat cache keys and optional supported retention settings.
- Optional Anthropic TTL and conversation breakpoint; original defaults preserved.
- Cache reads, writes, write TTL breakdown and uncached input in gateway logs when
  the provider supplies them. Missing counters remain unknown rather than being
  fabricated as zero. Cache-write count is also preserved in Responses usage.
- Time to first answer text, separately from time to first gateway stream event.
- A reproducible benchmark against the actual Git baseline gateway.

Application prompts, tool definitions, ordering, history and reasoning configuration
are unchanged by the implementation. Content equivalence was checked in local tests
and against the baseline translator before live requests. Direct Responses routes
and Gemini cache controls are unchanged.

## Real comparison on the configured proxy

Model profile: `claude-sonnet-5`, Anthropic-compatible route. Each request used the
same synthetic 240-invoice reference and an objectively scored invoice lookup.
The controlled run sent an identical disabled tool definition and `tool_choice:
none` in both arms. The candidate added a 5-minute TTL and an explicit conversation
breakpoint; the baseline kept its already implemented automatic caching and system
breakpoint. The benchmark did not disable baseline caching.

| Controlled run metric                             | Existing implementation | New cache options |
| ------------------------------------------------- | ----------------------: | ----------------: |
| Live requests                                     |                       6 |                 6 |
| Correct final text answers                        |                     5/6 |               4/6 |
| Responses ending in `tool_use` without final text |                       1 |                 2 |
| Proxy-reported input tokens                       |                  76,626 |            76,692 |
| Median warm time to first text                    |                1,575 ms |          1,829 ms |
| Median warm duration, correct answers only        |                1,860 ms |          2,180 ms |
| Cache-read/write counts                           |            Not reported |      Not reported |
| Monetary savings                                  |              Unverified |        Unverified |

The candidate was about 17% slower on the correct warm responses in this small run;
this is descriptive, not a statistically established regression. Input-token
differences are less than 0.1% and are consistent with equal-length cache-isolation
identifiers tokenizing differently and optional request metadata. They are not
evidence of savings. Every answer that contained final text matched the expected
invoice fields. Some samples returned a tool request instead of an answer, even
with tool use disabled; those samples were not counted as successful fast answers.

[Controlled raw samples](prompt-cache-controlled-retry-live-2026-10-02.json),
[generated comparison](prompt-cache-controlled-retry-live-2026-10-02.md).

## Other runs and failures

An initial comparison made 12 live requests (6 per arm). It returned correct text
for 5/6 baseline and 4/6 candidate requests, with no cache counters. That run predates
the correction to preserve absent cache-read counts as unknown, and did not record
provider stop reasons. Its raw data is retained:
[initial run](prompt-cache-live-2026-10-02.json).

A 24-request check kept the original cache settings in both implementations. It
returned correct text for 7/12 baseline and 9/12 candidate requests. The other eight
responses ended with `tool_use` and had no final text. Correct warm-response median
duration was 1,912 ms baseline versus 2,124 ms candidate. Cache counters were still
absent. This shows request variability exists even without enabling the new cache
options; it does not demonstrate a causal quality or speed improvement:
[same-settings run](prompt-cache-defaults-live-2026-10-02.json).

The first attempt at the controlled test failed on its initial baseline request
with gateway HTTP 502 before a provider response was received. It stopped without
making candidate calls. A separate retry then completed the 12-request comparison
above. The failed attempt is preserved:
[failed run](prompt-cache-controlled-live-2026-10-02.json).

Total: **48 completed live requests and one failed baseline attempt**. No synthetic
cache hits or official-model price assumptions were used to manufacture savings.
All benchmark gateways and temporary baseline directories were cleaned up.

## Validation

| Check                                                               | Result                                             |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Model gateway TypeScript build                                      | PASS                                               |
| Gateway tests, including cache validation/content equivalence/usage | PASS: 64                                           |
| Platform TypeScript build and tests                                 | PASS: 142 tests                                    |
| Agent-core TypeScript build                                         | PASS                                               |
| Pinned-runtime Chat, Anthropic and Gemini gateway integrations      | PASS: 3; none skipped                              |
| Benchmark script TypeScript check                                   | PASS                                               |
| Changed-file formatting and Git whitespace checks                   | PASS                                               |
| Real cache savings with this proxy                                  | UNVERIFIED: counters and billing rates unavailable |
| Quality equivalence across all tasks                                | UNVERIFIED: small synthetic single-call benchmark  |

The integration tests use real pinned runtime execution with local simulated
providers; they validate compatibility, not real provider performance. Live timing
and answers above came from the configured external proxy. Existing test teardown
warnings did not cause test failures. Frontend checks were not required because
there are no UI or public thread-contract changes.

## Required next step for measurable savings

The proxy needs to preserve upstream cache markers and expose actual upstream
`cache_read_input_tokens`, `cache_creation_input_tokens`, TTL write breakdown and
billing rates (or a usage invoice). We cannot infer that it does or does not cache
from missing fields. Its `tool_choice: none` behavior also needs investigation
before treating this single-call test as a complete quality assessment.

Once that evidence is available, rerun the same benchmark and calculate total
cost including cache writes and output. Application caching controls are ready
to test with a compatible endpoint; savings on this proxy remain unproven.

Configuration and reproduction steps: [application caching documentation](../docs/PROMPT_CACHING.md).
