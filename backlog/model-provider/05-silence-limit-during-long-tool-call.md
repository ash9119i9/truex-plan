# Replies time out while the model writes a long tool call

Status: open · High · Added 2026-11-01 · Source: V-taper document chats, Nemotron 3 Ultra 550B, coding on · Related: `backlog/model-provider/02-long-first-response-silence.md`

## Observed

Request: "Can you create a document in various format for Building a vtaper physique" (Markdown, Word, PDF, PowerPoint, Excel), in a new chat on prompt v6.

- First reply: the agent sent its plan, then asked the model for the next step. Nothing came back for 120 s, and the reply failed with `MODEL_TIMEOUT` after 123 s. No commands ran and no files were made.
- Second reply: 4 commands ran (1 failed) and the agent made `v_taper_guide.md`, `V_Taper_Physique_Guide.docx` and `V_Taper_Physique_Guide.pdf`. Its next model request ran for exactly 120,003 ms with nothing returned, and the reply failed with `MODEL_TIMEOUT` after 305 s. The PowerPoint and Excel files were never made.
- The earlier requests in that reply took 2 to 68 s each (gateway access log).
- On 2026-10-31 a four-formats chat also stopped with `MODEL_TIMEOUT` before making its PDF.

## Why it happens (suspected, not confirmed)

The adapter stops a reply after `silenceMs` (120 s, `DEFAULT_LIMITS` in `runtime-adapter/src/config.ts`) with no event from Codex. Its longer wait (`COMMAND_WATCHDOG_MS`) only applies while a command is already running (`rearmWatchdog` in `runtime-adapter/src/runtime/chat.ts`).

While the model writes one long tool call, such as a single script that builds several documents, nothing seems to reach Codex until the call is complete. `model-gateway/src/responses.ts` doesn't appear to stream tool-call argument text piece by piece. The provider adapters in `model-gateway/src/adapters/` haven't been checked.

## Proposed fix

1. Check what reaches the adapter: a test on the pinned Codex that streams tool-call argument text from the gateway, to see whether Codex emits an event the adapter can count as activity.
2. If it does: stream tool-call text from the gateway, so a long tool call is no longer silence.
3. If it doesn't: raise the silence limit for coding replies to about 300 s, set by an environment variable. The trade-off is that a stuck model takes longer to notice.
4. Either way: tell the agent to make each file with its own short script and keep scripts in `$TMPDIR`, so each step stays small. This also stops helper scripts (`generate_docx.py`, `generate_pdf.py`) cluttering the reply's file card.

## Done when

The five-format request finishes on Nemotron with all 5 files in 3 runs out of 3, and a model that really stops responding still ends as `MODEL_TIMEOUT`.
