# Context composition (context jar, Model context)

Status: open · Backend · Added 2026-10-28 · Spec 12.8, 14.8 §4

## Spec shows

- Trace **context jar**: stacked layers (system, tools, docs, conversation, free) against the window, with a 75% warn line and a 90% full line, plus a Compact button.
- Trace **Model context (Dev)**: one section each for System, Tools, Workspace docs and Conversation. Each has a share meter, a file list and a masked preview, with the footer "Masked on the server. Captured for live turns only."
- Insights: "‹n›K of 200K" with an 80% tick.

## Exists today

- Models carry `contextWindow` (`platform-next/src/modules/models/model.ts`). Run usage has total input tokens.
- There's no per-section token split and no masked capture of the model context in the new stack. The old stack's trace (`frontend/components/observability/*`) isn't wired to platform-next.

## Do

- Count tokens per section when the turn's input is built, and send the split with the run.
- Dev tab: capture a masked preview server-side for live turns only. Restrict it to admins or a dev flag, because it exposes instructions.
- Compact button: the new stack only auto-compacts (`autoCompactTokenLimit`). It has no manual compact action, so add one, then map its outcomes to the spec's four button states. The live-compaction display is tracked in `backlog/features/03-compaction-status.md`.

## Done when

The jar's layers add up to the reported input tokens within rounding, and the Dev tab is hidden from non-admin members.
