# MongoDB 8.0 requirement and the bulkWrite driver workaround

Status: open · check at every environment setup and driver upgrade · Added 2026-10-18

## Today (chat v1)

- Starting a chat, sending a follow-up and settling a reply use client-level `bulkWrite` inside a transaction (`DatabaseService.bulkWrite`), which needs MongoDB 8.0 or later. The dev Atlas cluster runs 8.0.34; tests download 8.0.14 (about 76 MB on first run).
- On an older server, chats cannot start. `checkDatabase` (`main.ts`) logs `MongoDB 8.0 or later is required` but does not stop the process.
- The driver (6.21) wraps a whole-command failure, such as a write conflict, in `MongoClientBulkWriteError` without its error labels, so `withTransaction` would not retry a `TransientTransactionError`. `DatabaseService.bulkWrite` rethrows the original `cause`. Without this, concurrent sends returned 500s.

## Do

- Confirm every environment (staging, production, any customer-hosted MongoDB) runs 8.0+ before deploying.
- Consider making the version check fail readiness instead of only logging.
- On each MongoDB driver upgrade, rerun the concurrent-send tests and remove the workaround once the driver keeps the labels.

## Done when

- Each environment's MongoDB version is recorded here.
- The driver either keeps the labels (workaround removed, tests green) or the workaround is confirmed still needed for the pinned version.
