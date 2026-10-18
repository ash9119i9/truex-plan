# Models and built-in agents: shared cache with removal on change

Status: open · do when platform-next runs more than one server · Added 2026-10-18

## Today (chat v1)

Each platform-next process keeps models and built-in agents (with their instructions) in a 60 s in-memory list, refreshed in the background. A model or built-in the list doesn't know yet is read from MongoDB directly. When the product team disables one with the operator CLI, new chats can still start with it for up to 60 s on every server. The gateway's own 30 s profile cache (`model-gateway/src/profiles.ts`) already lags the same way.

## Why change it

- With N servers, MongoDB gets N reloads per minute, and each server lags independently.
- The product team wants a removal to take effect right away, not after a TTL.

## Proposal

- Move the list to Redis (one copy shared by all servers and the gateway).
- The operator CLI writes MongoDB first, then deletes or updates the Redis entry. A failure after the DB write must not leave Redis serving the old entry: delete the key, and keep a TTL as the safety net.
- Alternative to CLI-driven removal: a MongoDB change stream on the catalog collections updates Redis, so changes made outside the CLI are caught too.
- Each server may keep a short local copy in front of Redis; it must be cleared by the same event (Redis pub/sub), or its TTL becomes the new window.
- If Redis is down, read MongoDB directly. Never serve a list older than the TTL.

## Done when

- Disabling a model or built-in stops new chats on every server within about 1 s, with a test.
- Starting a chat makes 0 MongoDB calls for models and built-ins when Redis is warm.
- A Redis outage falls back to MongoDB reads, with a test.
