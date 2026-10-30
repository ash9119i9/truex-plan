# Sign-off: corners, primitives, patterns

Status: open · Design · Added 2026-10-28 · Spec 0.1, 21

## Gap

Chapters 04 Corners (`corner.css`), 05 Primitives (`primitives.css`) and 06 Patterns (`patterns.css`) are "Proposal, ready for sign-off". They ship as written, but until they're locked any change to them is a system change, not a local edit.

## Do

- Review each chapter against its study page (`04-corners.html`, `05-primitives.html`, `06-patterns.html`).
- Apply the migration rows that touch them first: M4, M6, M7, M15 and M18 ([20](20-system-migration-list.md)).
- Mark each chapter **Locked** with a date in 0.1, and add a change-log line.

## Done when

All three show Locked in 0.1. Sign off before the React control layer (build step 2) freezes their APIs.
