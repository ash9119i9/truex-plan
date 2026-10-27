# Access-token revocation window on tenant routes

Status: open · accepted risk for chat v1 (user, 2026-10-18) · revisit before the first enterprise tenant · Added 2026-10-18

## Today (chat v1)

Tenant routes (chats, agents, models) trust the access token's signed `tid`, `role` and `tkind` without a MongoDB read. Tokens live 5 minutes (`ACCESS_TOKEN_TTL_SECONDS`, `session-policy.ts`). So for up to 5 minutes:

- a copied access token keeps working after logout or session revoke (the logging-out tab drops its own token at once, and refresh stops at once);
- a removed member, a role change or a disabled tenant still reaches those routes.

Still checked fresh, so outside the window: `GET /me`, `/me/tenants`, `GET /tenant`, refresh, the 15 s heartbeat on an open stream, and the admin re-read when archiving another member's agent.

Vendors land in the same place: WorkOS 5 min, Clerk 60 s, Auth0 / Supabase / Firebase 1 h, all valid until expiry.

## Proposal

1. **Revocation watch (closes the window to about 1 s).** Each platform-next process watches `sessions` and `memberships` (and tenant status) with a MongoDB change stream. A revoke, removal, role change or tenant disable records a "valid after" time per session or per user–tenant pair, kept for one token lifetime. The guard refuses, or rechecks MongoDB for, any token issued before it. Load the last token lifetime of changes at startup. If the stream drops, fall back to the per-request database check until it resumes; never trust stale state silently. Same idea as Microsoft CAE and the AWS `aws:TokenIssueTime` cutoff.
2. **Enterprise SSO tenants:** receive OpenID CAEP / Shared Signals events so that disabling a user in their Okta or Entra revokes them here. Fits the WorkOS adoption planned for SSO.
3. Optional: replace the hand-written verifier in `access-token.ts` with `jose` pinned to `EdDSA` and `typ: at+jwt`; the existing token tests cover it.

## Done when

- Logout, member removal, role change and tenant disable are refused on tenant routes within about 1 s, with a test for each.
- With the change stream down, tenant routes fall back to the database check, with a test.
- The guard still makes 0 MongoDB calls per request while the watch is healthy (Server-Timing call-count test).
