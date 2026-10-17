# Prompt caching not working on the dev Claude profile

Status: open · re-check on the production provider · Added 2026-10-17

## Observed

Real adapter + pinned Codex + local gateway + catalog profile `claude-sonnet-5-5` (dev Anthropic-compatible proxy, not Anthropic directly). Four turns on a ~3,800-token conversation: every turn reported 0 cached and 0 cache-write tokens. The profile has `promptCache.enabled`, and the gateway sets cache breakpoints, but the provider returned no cache usage fields at all. Most likely the proxy does not support caching.

## Why it matters

Codex resends the whole conversation each turn (3.8 KB → 18 KB over the test). Without caching, every turn pays for the full history in cost and time to first text.

## Do when the real provider is configured

- Run the cache benchmarks in `model-gateway/scripts` against the production Claude provider (Anthropic or Bedrock) and Gemini.
- Confirm `cachedInputTokens` / cache-write counts reach `runs.usage`.
- `prompt_cache_key` is the thread ID and is stable across turns (see `backlog/performance/04-codex-injected-context.md`).

## Done when

From turn 2 onward, cached input tokens are a large share of input tokens on the production provider, and the numbers are recorded here.
