# Models, built-in agents and connectors: shared cache (Valkey or Dragonfly) with removal on change

Status: open · do when platform-next runs more than one server · Added 2026-10-18 · Updated 2026-10-29

## Today (chat v1)

Each platform-next process keeps models, built-in agents (with their instructions) and the connector catalog in a 60 s in-memory list (`TtlCache`). Since 2026-10-29 an expired list is still served for up to 60 s more (`CATALOG_STALE_MS`) while it reloads in the background, so a send never waits on MongoDB for these lists. A model or built-in the list doesn't know yet is read from MongoDB directly. When the product team disables one with the operator CLI, new chats can still start with it for up to 2 minutes on every server. The gateway's own 30 s profile cache (`model-gateway/src/profiles.ts`) already lags the same way.

The window is 60 s, not longer, because nothing tells a server that a list changed: the TTL is the only way a disable takes effect. Measured from a laptop ~300 ms from Atlas, an expired model list cost one extra round trip (~300 ms) on `POST /messages`.

## Why change it

- With N servers, MongoDB gets N reloads per minute, and each server lags independently.
- The product team wants a removal to take effect right away, not after a TTL.
- After a quiet period longer than 2 minutes, the first send on a server still waits one MongoDB round trip for the model list.

## Proposal

- Load model config (and the built-in and connector lists) from a shared Redis-compatible cache: **Valkey or Dragonfly**. Pick one when this is scheduled; both speak the Redis protocol, so the client code is the same.
- The operator CLI writes MongoDB first, then deletes or updates the cache entry. A failure after the DB write must not leave the cache serving the old entry: delete the key, and keep a TTL as the safety net.
- Alternative to CLI-driven removal: a MongoDB change stream on the catalog collections updates the cache, so changes made outside the CLI are caught too.
- Each server keeps its local `TtlCache` copy in front of the shared cache, cleared by the same event (pub/sub).
- **Raise `CATALOG_STALE_MS` to 10 minutes once removal on change works.** A disable then reaches every server through the event, so the stale window only covers a missed event and no longer decides how fast a disable takes effect. Do not raise it before invalidation exists: without it, a disable takes up to 11 minutes.
- If the shared cache is down, read MongoDB directly. Never serve a list older than TTL + stale window.

## Done when

- Disabling a model, built-in or connector stops new chats on every server within about 1 s, with a test.
- Starting a chat makes 0 MongoDB calls for models, built-ins and connectors when the cache is warm.
- `CATALOG_STALE_MS` is 10 minutes, and a test shows a disable still applies within about 1 s with it.
- A cache outage falls back to MongoDB reads, with a test.
