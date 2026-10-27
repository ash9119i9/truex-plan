# A lone surrogate character kills the chat

Status: open · High · Added 2026-10-20 · Source: context stress test

## Observed

A message containing an unpaired UTF-16 surrogate (half an emoji, as from a broken paste) passes platform-next and the adapter. Codex fails to read it (`unexpected end of hex escape` in its log) and never replies. The adapter gives up after 30 s with `RUNTIME_ERROR`.

- First message of a chat: the chat becomes `THREAD_LOST` permanently. No conversation record was ever written.
- Later message: only that turn fails, but the error is marked retryable, and retrying the same text fails the same way.

Smaller finding from the same pass (Low): a message of only zero-width spaces (U+200B) is accepted (202), while whitespace-only is rejected (400). `trim()` does not remove U+200B.

## Fix

- `messageText` in `platform-next/src/modules/chats/chat.ts:296`: reject text that isn't well-formed (`!text.isWellFormed()`, Node 20+) with a 400 and a clear message. Also treat zero-width-only text as empty.
- Same check in the adapter's input validation (`runtime-adapter/src/contract.ts`), so the adapter is safe on its own.
- Regression tests in both packages: lone high surrogate, lone low surrogate, a valid emoji (accepted), zero-width-only text.

## Done when

The bad inputs get a 400 before any run or thread is created, a valid emoji is still accepted, and the tests fail before the fix and pass after it.
