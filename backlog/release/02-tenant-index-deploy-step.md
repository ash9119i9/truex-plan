# Tenant index builds are a manual deploy step

Status: open · accepted risk for chat v1 (user, 2026-10-18) · do before the first production deploy pipeline · Added 2026-10-18

## Today (chat v1)

Requests no longer check or build indexes. Retries of a Send are made harmless only by the unique indexes `owner_first_message_unique` and `chat_client_message_unique`: the server tries the insert and reads the original only on a duplicate-key error.

- New tenants: `provision-tenant` builds the indexes before marking the tenant `ready` and records `indexVersion`.
- Existing tenants: when a release raises `TENANT_INDEX_VERSION` (`tenant-indexes.ts`), someone must run `npm run operator -- ensure-tenant-indexes --operator <name> --all` before the release takes traffic.
- At startup, `checkDatabase` (`main.ts`) logs an error if any ready tenant is behind. It only logs; it does not block startup or chats.

## Risk

If the step is skipped, a retried message can create a duplicate chat or message, with no error to the user and only the one startup log line.

## Proposal

- Run `ensure-tenant-indexes --all` in the deploy pipeline before the rollout, so there is no human step.
- Alert on the `tenants are missing this release's indexes` log line.
- Decide whether to fail safe: refuse to start while any tenant is behind, or refuse chat writes for stale tenants only (the token path would need the tenant's index version).

## Done when

- The pipeline runs the command before rollout and fails the deploy if it fails.
- The alert exists and has been fired once in staging.
