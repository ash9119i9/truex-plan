# Context window: Codex caps the 1M profile at 258k, and 1M is wrong anyway

Status: open · High · Added 2026-10-20 · Source: context stress test on the dev Claude profile (`claude-sonnet-5.5` via the dev proxy), scripts and results in `.runtime/context-stress/` (gitignored)

## Observed

The profile sets `contextWindow: 1_000_000` and `autoCompactTokenLimit: 750_000`. The adapter passes both to Codex (`runtime-adapter/src/codex/config.ts:125`). Codex uses neither:

- Codex doesn't know the slug, so it uses fallback metadata (`vendor/codex/codex-rs/models-manager/src/model_info.rs:98`): `context_window` and `max_context_window` 272,000, `effective_context_window_percent` 95.
- `with_config_overrides` (same file, line 20) takes `min(configured, max_context_window)`, so 1M becomes 272k. 95% of that is the 258,400 Codex reports.
- Compaction fired at about 244,800 (90% of 272k), not 750k. In the long-fill test it ran at 253k.

The proxy's real limit is lower than 1M. Called directly: 500k ✅ (TTFT 18.7 s), 700k ✅ (16.5 s; 705,589 tokens accepted), 800k ❌, 900k ❌, 1.1M ❌ ("Model context limit reached"). If the cap were lifted as-is, the 750k compaction point would be past the limit and long chats would fail instead of compacting.

## Why it matters

Users get a quarter of the advertised window, and the profile fields look like they work but don't. Fixing only the cap would turn a silent limitation into hard failures.

## Proposed fix (no Codex change)

1. Check in the pin how `model_catalog_json` is read, then have the adapter give Codex a model entry for each gateway profile with `context_window` / `max_context_window` from the profile, so the fallback cap no longer applies.
2. Change the dev Claude profile to about 700k with compaction at about 550k. Record the real limit of the production provider before choosing its numbers.
3. Do `04-gateway-overflow-error.md` at the same time, so an overflow still leads to compaction.

## Done when

- Codex logs `model_context_window` equal to the profile value (less its percent), and compaction fires at the profile's `autoCompactTokenLimit`, with a test on the real pin.
- A fill test past 300k on the dev profile compacts once near the configured limit and never gets a provider overflow.
- Production provider limits are recorded here.
