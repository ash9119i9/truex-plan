# Prompt-cache verification with a new provider

Status: **ATTEMPTED — Google generation timed out; caching verification remains pending.**

## Google retest on 2026-10-02

The user supplied Google profile `6abfc2c3cac1e27f48b52b25`, model
`gemini-flash-latest`, at the direct Google `v1beta` endpoint. Model metadata
lookup succeeded with HTTP 200 and advertised `createCachedContent` support.
The supplied `wireApi: "google"` is unsupported by this application; the test
used `wireApi: "gemini"` in memory, without changing the stored profile.

The first original-gateway generation request timed out after 60 seconds
(HTTP 504) without provider response headers or usage. A separate short
non-streaming generation request also timed out after 30 seconds. Cache reuse,
cost savings and answer-quality comparisons remain **unverified**. See the
[recorded attempt](../benchmark-reports/gemini-cache-live-retry-2026-10-02.md).

The new Google benchmark compares the original and current gateways using
identical Gemini requests and automatic caching. The earlier application changes
do not add Gemini cache controls. Positive raw `cachedContentTokenCount` values
can establish provider reuse; missing fields stay unknown even if the gateway
response substitutes zero. This test creates no explicit cache objects.

To repeat with private profile credentials in an ignored file:

```sh
npm --prefix model-gateway run benchmark:cache:gemini -- \
  --profile-file ../.runtime/google-model-profile.json \
  --blocks 2 --requests 3 \
  --output ../benchmark-reports/gemini-cache-new-run
```

Use a fresh output name. Restrict credential-file permissions and remove the file
after testing. The script records provider usage, actual model version when
available, request/source hashes, answer correctness and failures. Billing tier
and applicable rates are still needed to quantify monetary savings.

Recorded on 2026-10-02 at the user's request. Preserve the current implementation
and benchmark evidence on `feat/application-prompt-caching`; verify caching,
cost and answer quality again with the new provider before enabling its new cache
options for normal application traffic.

## Current evidence

The current Anthropic-compatible proxy completed 48 benchmark requests; one
additional baseline attempt failed with HTTP 502. It did not return cache-read
or cache-write counters. No monetary savings were established. Some responses
requested tools despite `tool_choice: none`, which limits single-call quality
comparisons. The new cache settings remain opt-in, and the existing stored model
profile was not changed.

See [results and raw samples](../benchmark-reports/PROMPT_CACHE_RESULTS.md) and
[configuration and benchmark instructions](PROMPT_CACHING.md).

## Retest procedure

1. Record the new provider, actual model identifier, API format and model-profile
   id. Confirm supported caching controls, minimum prefix length and retention.
2. Confirm cache markers/options reach the upstream model. Preserve actual
   upstream cache-read/write counters and write-TTL breakdown in the response.
   Missing counters are unknown, not zero; estimated character counts are not
   a substitute for actual model usage.
3. Obtain the new endpoint's billing policy and rates for uncached input, cached
   input, cache writes and output, or actual billed usage. A subscription or credit
   system may not translate cache reuse into monetary savings.
4. Verify tool settings and final-answer behavior so unanswered tool requests
   are not counted as successful fast responses.
5. Compare the original gateway baseline with the new cache options using the
   same model, reference content, tools, history and generation settings. Keep
   baseline caching enabled as originally implemented. Use isolated cold prefixes
   and repeated requests, alternate arm order, and preserve failed samples.
6. Record cache hits/writes, total cost including writes and output, time to first
   answer text, total duration, correct final answers and failures. Preserve raw
   usage, request/source hashes, configuration and the baseline revision.
7. Decide whether to enable the settings based on measured cost and quality.
   Do not infer success from cache markers alone or from missing usage fields.

For an **Anthropic-compatible** new provider, run:

```sh
npm --prefix model-gateway run benchmark:cache -- \
  --profile <new-model-profile-id> \
  --blocks 3 --requests 4 \
  --output ../benchmark-reports/prompt-cache-new-provider
```

Use a fresh output name for each run. Optional `--rates <path>` supplies the
endpoint's documented rates; see the configuration guide for its JSON schema.
Also run with `--policy default` to measure the new implementation using the
original settings. The `benchmark:cache` harness supports Anthropic-compatible
profiles; `benchmark:cache:gemini` supports the direct Google endpoint as described
above. Extend the harness for Chat or Responses. Do not silently substitute a
different provider or model.

## Completion criteria

- Provider-supplied usage shows eligible cache writes and subsequent cache reads.
- Actual endpoint billing or a complete rate-based calculation demonstrates
  lower total cost for the representative workload.
- Answer correctness and failure behavior meet the agreed quality requirement;
  unanswered tool requests and HTTP failures remain visible.
- Results are reproducible with the recorded candidate and baseline. A small
  synthetic benchmark does not certify production performance or all-task quality.

Retest result, provider identity and enablement decision: **not yet recorded**.
