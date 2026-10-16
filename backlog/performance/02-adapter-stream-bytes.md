# Runtime adapter: streamed replies send about 19× the text size

Status: open · measure on AgentCore, then decide · Added 2026-10-17

## Problem

Every Codex text delta becomes its own `text.delta` event (about 70 bytes of framing), and the full text is repeated in `item.completed` and again in `run.completed`.

Measured locally on 2026-10-17 (real adapter + pinned Codex, fake model sending 4-character pieces, scripts in `.runtime/perf-bench/`):

- 2,000-character reply → 38 KB on the wire.
- 20,000-character reply → 380 KB in about 4,400 writes.

In production the adapter runs inside the AgentCore microVM, so every byte crosses `InvokeAgentRuntime` back to the platform and is parsed again there.

## Proposed fix

- Send the first delta of each item immediately (no cost to time to first text).
- Coalesce later deltas per item into one event every 30–50 ms. The platform already batches to the browser every 50 ms.
- Stop repeating the text in `item.completed`; `run.completed` keeps it because that is the record the platform saves.

## Measure first

The gain depends on the delta size the gateway actually sends for Claude and Gemini. Capture it in the deployed AgentCore test. If deltas are already sentence-sized, the saving is small: drop this item.

## Done when

- Delta sizes for Claude and Gemini are recorded here.
- If built: bytes per reply and time to first text measured before and after on AgentCore; time to first text unchanged; adapter reconnect/snapshot tests still pass.
