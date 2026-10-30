# Approval modes: Always allow, read-only, Autopilot

Status: open · Backend · Added 2026-10-28 · Spec 13.4, 13.6, 13.7

## Spec shows

- Tool approval buttons: **Allow once**, **Allow for this chat**, **Always allow** and **Don't allow**.
- Approval records for auto-handled requests: "Auto-allowed (read-only)", "Auto-accepted (Autopilot)" and "Allowed for this chat"; Autopilot answers read "‹answer› (chosen by Autopilot)".
- Policy: secrets and plans always ask, in every mode.

## Exists today

- New stack: Allow once and Allow for this chat (`runtime-adapter/src/runtime/chat.ts`, `allowForChat`). "Allow for this chat" is held by the adapter, never Codex's `persist`.
- Always allow, read-only auto-allow and Autopilot exist only as the old stack's alpha (`agent-core/src/approval-modes.ts`, see `backlog.txt` "Auto Accepts"). They aren't ported.

## Do

- Always allow: decide its scope (member + agent + tool, or member + tool), where it's stored, and how a member reviews and revokes it. Without a way to revoke, don't ship it.
- Port read-only auto-allow, based on the connector's `writeTools`.
- Autopilot: a security change. Close the gaps the alpha left: the mode endpoint had no auth, and the mode was saved before the runtime confirmed it.
- Every auto-handled request writes an approval record.

## Done when

Each mode leaves a record, secrets and plans still ask, and any standing permission can be seen and revoked by its owner.
