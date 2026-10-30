# Share a conversation

Status: open · Backend + design · Added 2026-10-28 · Spec 11.3, 19.4

## Spec shows

Topbar **Share** copies a link; the label changes to "Link copied" for 1.8 s. The Share dialog itself is not designed yet (19.4).

## Exists today

Nothing. Chats are private to their owner. `backlog.txt` already lists "Share button: wire up sharing a conversation link".

## Do

- Product: who can open the link (workspace members only, or anyone with it), whether it's a frozen snapshot or live, and how it's revoked.
- Security: links must not cross workspaces. Masked content stays masked, and files and approval records need a rule for whether they're included. Rate-limit link creation.
- Design the Share dialog: create, copy, revoke, and an expired-link state.

## Done when

A member can share, copy and revoke a link. A non-member can't open a workspace-only link. Revoking takes effect immediately.
