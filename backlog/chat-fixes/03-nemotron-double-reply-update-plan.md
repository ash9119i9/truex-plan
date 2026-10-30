# Nemotron answers twice around a pointless `update_plan` call

Status: open · Medium · Added 2026-10-29 · Source: Invoice desk chat, Nemotron 3 Ultra 550B · Related: `backlog/model-provider/`

## Observed

Prompt: "hi bro, ask you Few questions in a approval card or plan card".

From the Codex log of that turn:

1. The model replied ("I'm ready to help. What would you like me to work on? …").
2. It called `update_plan` with a one-step plan.
3. It replied again with nearly the same text.

Each tool call makes Codex ask the model again, so the turn needed two model requests (about 15k input tokens each, 30.2k total, 15 s).

## Already done (uncommitted)

The UI showed both replies as answers, each with its own "Copy answer" button. `progressFlags` in `frontend/lib/tenant-chat.ts` only treated a reply as narration when a tool row followed it, and `update_plan` has no transcript row. A reply followed by another reply in the same turn now also counts as narration, so only the last reply is the answer. Regression test in `frontend/test/tenant-chat.test.ts`.

## Still to fix

The extra model request. Our planning guidance already tells the model not to plan a short reply (`runtime-adapter/src/codex/config.ts:174`), and Nemotron ignored it. The prompt did ask for a "plan card", so the call was not entirely unprompted.

1. Run the same prompt against the other model profiles to see whether this is Nemotron-only.
2. Then decide: tighten the guidance, or stop offering `update_plan` to models that misuse it.

## Done when

A greeting-style prompt on Nemotron finishes in one model request with one reply, and the other profiles still use `update_plan` for real multi-step work.
