# How it checked the answer

Status: open · Backend + product · Added 2026-10-28 · Spec 14.8 §6

## Spec shows

A checklist with states ok, warn, wait and off. Items: "Totals match across systems", "Sources are recent", "Every number has a source", the steer check ("Follows / Followed your note", "Your note wasn't applied"), rules ("Stayed within its rules" / "One write failed") and "Within budget". On a stopped turn, unrun checks are off ("Not checked. You stopped the turn first.").

## Exists today

Nothing. No component checks answers.

## Do

- Decide what produces each check, and drop any check nothing can honestly produce.
  - Deterministic, from data the platform holds: "Within budget" ([01](01-turn-cost-and-budget.md)), "One write failed" (tool results), steer applied or not (steers are stored on the run).
  - Model-judged: "Totals match", "Every number has a source", "Sources are recent". These need a verifier pass, which adds cost and latency and can be wrong.
- Ship the deterministic checks first.

## Done when

Every check shown comes from a defined producer. No check is shown as passed by default.
