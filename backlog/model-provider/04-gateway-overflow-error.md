# Gateway doesn't recognise the dev proxy's context-overflow error

Status: open · Medium · do with `03-context-window-cap.md` · Added 2026-10-20

## Observed

When a request is too big, the dev Claude proxy returns a 400 `api_error` with "Model context limit reached…". `isContextError` (`model-gateway/src/adapters/chat.ts:292`) matches "maximum context length", "context window", "context length", "too many tokens" and "prompt is too long", but not this wording. The gateway passes a plain 400 to Codex instead of `context_length_exceeded`, so Codex can't recover by compacting.

Today the 258k cap (see `03-context-window-cap.md`) stops chats from getting that large, so it only matters once the cap is fixed.

## Do

- Add the wording (for example `/context limit/i`) to `isContextError`, with a unit test using the proxy's real message.
- Collect the overflow messages of the production Claude and Gemini providers and add tests for those too.

## Done when

An oversized request through the gateway returns `context_length_exceeded` for each configured provider, covered by tests.
