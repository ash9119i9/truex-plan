# Chat: show when the conversation is being condensed

Status: open · Medium · Added 2026-10-20 · Source: context stress test

## Observed

When Codex compacts, the turn shows nothing for 40–45 s (45.6 s and 45.4 s before the first reply text in two runs). The adapter already emits a `compaction` event (`runtime-adapter/src/runtime/chat.ts:620`), but platform-next drops it, so the UI looks hung.

Related, from the same test:

- Stopping during compaction works (120 ms) and the chat keeps its memory, but the compaction runs again on the next message, so it is paid for twice.
- Sending during compaction is steered into the running turn and answered.

## Do

- Pass the `compaction` event through platform-next's stream to the frontend.
- Show "Condensing conversation…" in the transcript while it runs.
- Decide whether Stop during compaction should be allowed, warned about, or deferred until compaction finishes.

## Done when

A long chat shows the condensing state within a second of compaction starting, verified in the real app, and the Stop behaviour is decided and recorded here.
