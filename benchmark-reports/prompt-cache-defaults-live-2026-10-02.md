# Real provider prompt-cache benchmark

Started: 2026-10-02T13:12:23.631Z
Baseline: `2417dff195b22f19b3dc5c29a48d6a30d3c02354`
Model profile: `claude-sonnet-5`
Provider host: `ashok-kiro-gw.duckdns.org`
Candidate policy: `default`

Prompt content equivalent before cache-isolation partitions: **PASS**.

| Metric | Existing gateway | Candidate gateway |
| --- | ---: | ---: |
| Requests | 12 | 12 |
| Correct answers | 7 | 9 |
| Empty answers | 5 | 3 |
| Proxy-reported input tokens | 152788 | 152752 |
| Cache-read tokens | Unverified | Unverified |
| Cache-write tokens | Unverified | Unverified |
| Uncached input tokens | Unverified | Unverified |
| Output tokens | 198 | 254 |
| Median first-request time to first text (ms) | 2432 | 1806 |
| Median repeated-request time to first text (ms) | 1710 | 1860 |
| Median repeated-request total duration (ms) | 1912 | 2123 |
| Median correct repeated-request total duration (ms) | 1912 | 2124 |
| p95 total duration (ms) | 4794 | 3715 |
| Estimated cost (rates unavailable) | Unverified | Unverified |

## Interpretation

Answer correctness and empty-response counts must be considered before attributing lower durations or output tokens to an improvement.

Cache usage was not fully reported; cache savings cannot be established.

Actual monetary savings are unverified because this proxy's billing rates were not supplied.

## Method and limitations

- Synthetic invoice extraction through gateways, not a full UI or agent workload.
- Short repeated-request test; it does not evaluate reuse after five minutes or one hour.
- Baseline already requests caching. Automatic caching was not artificially disabled.
- Each arm uses an equal-length unique partition in its initial instructions to isolate caches. Business reference and questions are identical.
- Small sample; latency differences are descriptive and not a statistical guarantee.
- Provider-reported tokens are not an invoice. Monetary estimates require actual endpoint rates.

Raw samples and candidate source digests: [JSON report](prompt-cache-defaults-live-2026-10-02.json).
