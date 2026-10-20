# Sessions from earlier local test runs may still be active

Status: open · Low · Added 2026-10-20

## Observed

The local `session.ts` test helper revoked sessions from the wrong collection, so its revoke step did nothing. It was fixed on 2026-10-20. Sessions issued by earlier test runs on the dev database may still be valid until they expire.

## Do

List sessions on the dev database that were issued by the helper and revoke them. Add a check to the helper that revoke actually changed a record.

## Done when

No helper-issued session older than 2026-10-20 is active, and the helper fails loudly if a revoke changes nothing.
