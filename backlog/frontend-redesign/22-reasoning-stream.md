# Reasoning stream for the ThinkingBlock

Status: open · Backend · Added 2026-10-28 · Spec 12.1, 11.7 slot 2

## Spec shows

A ThinkingBlock above the answer: "Thinking…" with a live 7.25rem window while the model reasons, then "Reasoning · N words", folded, when the turn ends.

## Exists today

Nothing reaches the browser. runtime-adapter sees Codex's `item/reasoning/*` notifications but only uses them to mark the turn active (`runtime-adapter/src/runtime/chat.ts`, `this.activity(active)`); no reasoning text is forwarded to platform-next, stored, or streamed to the frontend. The frontend redesign (Task 17) therefore ships no ThinkingBlock.

## Do

- Contract task (its own task, tests on both sides): runtime-adapter forwards reasoning summary deltas as a stream event; platform-next relays them and decides whether to save them with the run (size limit, retention, masking with the shared masker before display).
- Frontend: a `reasoning` live item, the ThinkingBlock in slot 2 (12.1 states: streaming, done, empty), folded when the turn settles until the reader touches it.
- Privacy: decide whether reasoning text is shown to every member or behind a setting, and whether it is kept after the turn.

## Done when

A turn from a reasoning model shows "Thinking…" while it reasons and "Reasoning · N words" folded afterwards; a turn without reasoning shows no block.
