# Google implicit-cache verification

Model: `gemini-flash-latest`; host: `generativelanguage.googleapis.com`.
Baseline: `2417dff195b22f19b3dc5c29a48d6a30d3c02354`; candidate HEAD: `7b2c4d6591d7eda26d9fc964d60e0b379a2c26cd`.
Started: 2026-10-02T14:52:17.925Z; finished: 2026-10-02T14:52:17.961Z.

Supplied wire API: `google`; test uses supported `gemini` adapter. Stored profile was not changed.
Equivalent upstream bodies before isolation partitions: **UNVERIFIED**.

| Metric | Original gateway | Current gateway |
| --- | ---: | ---: |
| Requests | 0 | 0 |
| Correct answers | 0 | 0 |
| Failures | 0 | 0 |
| Cache-hit requests | 0 | 0 |
| Requests with missing cache counters | 0 | 0 |
| Observed cached input tokens | Unverified | Unverified |
| Total prompt tokens (includes cached) | Unverified | Unverified |
| Output tokens including thoughts | Unverified | Unverified |
| Median first-observed TTFT (ms) | Unverified | Unverified |
| Median correct repeated TTFT (ms) | Unverified | Unverified |
| Median correct repeated duration (ms) | Unverified | Unverified |

Execution error: spawnSync git ENOBUFS

Positive provider cache counters verify reuse. This is a comparison with identical implicit-cache settings, not a test of additional Gemini cache controls. Monetary savings remain unverified without the billing tier and applicable rates.

## Limitations

- Synthetic invoice extraction, not a full application agent or tool execution test.
- Implicit caching is provider controlled; first requests are first-observed, not guaranteed cold.
- Fresh equal-length partitions isolate each arm and block; reference content, tools and questions are identical.
- Missing cachedContentTokenCount stays unknown; gateway fallback zero alone is not cache evidence.
- No explicit cache objects or storage charges were created; no new Gemini cache controls are implemented by the earlier application changes.
- No billing tier or endpoint rates supplied; monetary savings remain unverified.
- Small sample; latency differences are descriptive and do not establish causal improvement or all-task quality.
- The latest model alias may change; response modelVersion is recorded when supplied.

Sources: [Google caching guide](https://ai.google.dev/gemini-api/docs/caching), [generateContent usage fields](https://ai.google.dev/api/generate-content#UsageMetadata).

Raw evidence: [JSON](gemini-cache-live-2026-10-02.json).
