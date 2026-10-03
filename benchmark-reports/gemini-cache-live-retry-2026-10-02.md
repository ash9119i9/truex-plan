# Google caching verification: first live attempt

Model: `gemini-flash-latest`; endpoint: `generativelanguage.googleapis.com`.
Supplied profile: `6abfc2c3cac1e27f48b52b25`.
The test mapped supplied `wireApi: google` to the supported `gemini` adapter in memory; no stored profile was changed.

The original gateway made one request and returned **HTTP 504 after 60,029 ms**, with no provider response headers, answer, or usage. No candidate generation calls were made. The test stopped without automatic retries.

Upstream bodies before cache-isolation partitions were equivalent. Caching, cost savings, latency improvement, and answer quality are **unverified**.

The first report attempt also exposed a missing-usage summary bug in the new benchmark script; the script has been corrected and this report's derived summary repaired. Raw recorded samples are unchanged.

[Raw evidence](gemini-cache-live-retry-2026-10-02.json).

Model metadata lookup returned HTTP 200 and advertised `createCachedContent` support. Two separate short non-streaming generation probes also timed out: Node fetch after 30,008 ms; curl after 30,006 ms (exit 28, zero response bytes). Across these checks, three generation requests were attempted and none returned an answer or usage. Metadata access alone does not establish generation or caching availability.
