# Real provider prompt-cache benchmark

Started: 2026-10-02T13:08:51.965Z
Baseline: `2417dff195b22f19b3dc5c29a48d6a30d3c02354`
Model profile: `claude-sonnet-5`
Provider host: `ashok-kiro-gw.duckdns.org`

Prompt content equivalent before cache-isolation partitions: **PASS**.

| Metric | Existing gateway | Candidate gateway |
| --- | ---: | ---: |
| Requests | 6 | 6 |
| Correct answers | 5 | 4 |
| Cache-read tokens | Unverified | Unverified |
| Cache-write tokens | Unverified | Unverified |
| Uncached input tokens | Unverified | Unverified |
| Output tokens | 187 | 121 |
| Median first-request time to first text (ms) | 4946 | 1688 |
| Median repeated-request time to first text (ms) | 1731 | 1571 |
| Median repeated-request total duration (ms) | 2097 | 1931 |
| p95 total duration (ms) | 5177 | 3109 |
| Estimated cost (rates unavailable) | Unverified | Unverified |

## Interpretation

Cache usage was not fully reported; cache savings cannot be established.

Actual monetary savings are unverified because this proxy's billing rates were not supplied.

## Method and limitations

- Synthetic invoice extraction through gateways, not a full UI or agent workload.
- Short repeated-request test; it does not evaluate reuse after five minutes or one hour.
- Baseline already requests caching. Automatic caching was not artificially disabled.
- Each arm uses an equal-length unique partition in its initial instructions to isolate caches. Business reference and questions are identical.
- Small sample; latency differences are descriptive and not a statistical guarantee.
- Provider-reported tokens are not an invoice. Monetary estimates require actual endpoint rates.

Raw samples and candidate source digests: [JSON report](prompt-cache-live-2026-10-02.json).
