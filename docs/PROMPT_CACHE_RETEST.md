# Prompt-cache verification with a new provider

Status: **PENDING — rerun after a new model provider is configured.**

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
original settings. The current live benchmark harness supports Anthropic-compatible
profiles only; extend it for the new API format if the provider uses Chat,
Responses or Gemini. Do not silently substitute a different provider or model.

## Completion criteria

- Provider-supplied usage shows eligible cache writes and subsequent cache reads.
- Actual endpoint billing or a complete rate-based calculation demonstrates
  lower total cost for the representative workload.
- Answer correctness and failure behavior meet the agreed quality requirement;
  unanswered tool requests and HTTP failures remain visible.
- Results are reproducible with the recorded candidate and baseline. A small
  synthetic benchmark does not certify production performance or all-task quality.

Retest result, provider identity and enablement decision: **not yet recorded**.
