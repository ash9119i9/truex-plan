# Real provider prompt-cache benchmark

Started: 2026-10-02T13:15:37.855Z
Baseline: `2417dff195b22f19b3dc5c29a48d6a30d3c02354`
Model profile: `claude-sonnet-5`
Provider host: `ashok-kiro-gw.duckdns.org`
Candidate policy: `explicit`

Prompt content equivalent before cache-isolation partitions: **PASS**.

| Metric | Existing gateway | Candidate gateway |
| --- | ---: | ---: |
| Requests | 1 | 0 |
| Correct answers | 0 | 0 |
| Empty answers | 1 | 0 |
| Provider tool-request responses | 0 | 0 |
| Proxy-reported input tokens | Unverified | Unverified |
| Cache-read tokens | Unverified | Unverified |
| Cache-write tokens | Unverified | Unverified |
| Uncached input tokens | Unverified | Unverified |
| Output tokens | Unverified | Unverified |
| Median first-request time to first text (ms) | Unverified | Unverified |
| Median repeated-request time to first text (ms) | Unverified | Unverified |
| Median repeated-request total duration (ms) | Unverified | Unverified |
| Median correct repeated-request total duration (ms) | Unverified | Unverified |
| p95 total duration (ms) | 10526 | Unverified |
| Estimated cost (rates unavailable) | Unverified | Unverified |

Execution error: Provider request failed; stopped to avoid repeating failed calls

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
- Single-call answer scoring; requests for tools are recorded as no final text, not silently counted as fast answers.
- Provider-reported tokens are not an invoice. Monetary estimates require actual endpoint rates.

Raw samples and candidate source digests: [JSON report](prompt-cache-controlled-live-2026-10-02.json).

Reporting correction: the candidate made no requests in this failed run; its usage is unknown.
