# Time breakdown and step timings

Status: open · Backend · Added 2026-10-28 · Spec 14.5 §4, 14.8 §2, 12.8

## Spec shows

- Activity steps: a waterfall on one time scale, with **Started** (+offset) and **Took** for each step.
- Insights, "Where the time went": thinking / your systems / web / **waiting for you**. Waiting time is kept separate so the agent isn't read as slow.
- Trace timing: Accept, First token, Stream, Longest gap, Rate (tok/s), Finalize.

## Exists today

- `RunTimings` stores `acceptedAt`, `dispatchedAt`, `firstTextAt` and `completedAt` (`platform-next/src/modules/chats/chat.ts:351`).
- No per-step start/end, waiting-for-approval duration or stream-gap figures are stored. Live events may carry item times, but this isn't verified. Either way, nothing reloads after the turn ends.

## Do

- Record each step's start, end and kind (thinking, tool + connector, web, waiting for the person).
- Record the total time spent waiting on request cards per run.
- Derive Stream, Longest gap and Rate from the stream and store them with the run.

## Done when

A reloaded, finished turn redraws the same waterfall and time split it showed live, with waiting time separated out.
