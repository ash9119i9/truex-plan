# Activity Panel session view

Status: open · Design · Added 2026-10-28 · Spec 19.4, 14.1

## Gap

The Activity Panel is designed for one turn. Its whole-conversation (session) view is listed as "next to design".

## Do

Design the session view inside the panel's locked structure (14.1) and its read-only contract (14.2):

- How a member moves from a turn to the session and back.
- What the session totals: time, cost, tokens, files, approvals and helpers across turns.
- A list of turns that jumps to each turn's view.
- Empty, loading and error states.
- The 390 px layout.

Session cost and time depend on backend items [01](01-turn-cost-and-budget.md) and [02](02-time-breakdown-and-step-timings.md).

## Done when

A screen study exists in `system/screens/`, and the spec gains a 14.x section for the view.
