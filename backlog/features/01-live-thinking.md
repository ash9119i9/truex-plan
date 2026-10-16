# Chat: live thinking, usage and timing

Status: open · Added 2026-10-17 · Depends on: chat v1 slice

## Goal

Show the model's thinking as it happens, plus token usage, context use and timing per reply, using what the pinned Codex already provides. No Codex changes.

## Problem

The model gateway buffers thinking instead of streaming it:

- Anthropic: `thinking_delta` is collected and sent to Codex as one finished `reasoning` item when the block ends (`model-gateway/src/adapters/anthropic.ts:487-506`, `model-gateway/src/responses.ts:117`).
- Gemini: thoughts are accumulated into one `summary` string (`model-gateway/src/adapters/gemini.ts:375`).

Effects:

1. The user sees nothing for the 10–60 s the model thinks, then the whole thought appears at once.
2. No events reach the platform during thinking, so the chat watchdog's first-response timer (about 90 s) can kill a model that is thinking normally. Until this is fixed, the watchdog must allow for buffered thinking.
3. Time to first visible output is worse than it needs to be.

## Proposed fix

**Gateway (only change on the provider side):** emit the standard Responses streaming events as thinking arrives: `response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta`, then the finished `reasoning` item with its signature. Codex maps these to `item/reasoning/summaryPartAdded` and `item/reasoning/summaryTextDelta`.

**Unverified:** that Codex reads these events from a custom provider. Probe this before building.

## UX

| Codex provides | UX |
|---|---|
| `reasoning` item + `summaryPartAdded` / `summaryTextDelta` | Live "Thinking…" panel that streams, then collapses to "Thought for 14s" and can be reopened. Each `summaryIndex` is a step. |
| `effort` / `summary` on `turn/start` | Per-message depth picker: Fast / Balanced / Deep, defaulting to the model's `reasoningEffort` |
| `thread/tokenUsage/updated` (`total`, `last`, `modelContextWindow`) | One quiet line under each reply, e.g. "1.2k in · 640 out · 92% cached", expandable. Context meter in the chat header. |
| Turn `startedAt` / `completedAt` / `durationMs` + platform timestamps | "First text in 1.4s · 9.8s total · 65 tok/s", and thinking duration |
| `error` with `willRetry: true` | "Claude is busy, retrying (2/4)…" |
| `contextCompaction` item | Divider: "Earlier messages were summarized to keep this chat going" |

Out of scope here: cost per reply (needs price fields on model profiles), `agentMessage.phase`, plan/tool/web-search/goal items.

## Schema additions

```js
messages.kind      // "user" | "assistant" | "reasoning" | "compaction" | "notice"
messages.durationMs // reasoning: how long it thought; text is the summary, never the signature
runs.usage         // { input, cached, cacheWrite, output, reasoning } from `last`
runs.timings       // + firstThinkingAt
chats.context      // { usedTokens, windowTokens, updatedAt }
```

Store `runs.usage` and `runs.timings` from chat v1 so this feature needs no migration.

## Open decisions

1. Make the gateway stream thinking live (recommended).
2. Depth picker per message (recommended; Codex supports it per turn).
3. Usage line visible to everyone (recommended) or admins only.

## Verify before building

Run one probe through the real gateway with Claude and Gemini:

- Live thinking deltas reach the browser.
- Token counts match the provider's own numbers. Anthropic reports cached and cache-write tokens separately, and counts thinking as output, so totals need checking.
- The context meter's numbers are correct.
- Retry events (`willRetry`) come through.

## Done when

- Thinking streams live for Claude and Gemini and is saved, so it survives a reload.
- A long thinking phase does not trip the watchdog (test with a slow fake provider).
- Usage, context meter and timing are shown and match the probe's provider numbers.
- Gateway tests cover the new streaming events; the signature is never sent to the browser.
