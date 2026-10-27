# Live replies across more than one platform-next instance

Status: open · do before platform-next runs more than one instance · Added 2026-10-18

## Today (chat v1)

A reply is read from the runtime by the platform-next process that started it. Its live state (`RunExecutor.live`, `run-executor.ts`) exists only in that process's memory, and v1 assumes one process. A stream that reaches that process authorizes against the live entry and makes 0 MongoDB calls.

## What breaks with two instances

Behind a round-robin load balancer, the message can land on A while its stream lands on B:

1. B has no live entry, so it reads the run from MongoDB and sees it unfinished.
2. B starts a recovery reader. It waits for A's lease to expire, up to `LEASE_MS` (30 s), and then reads the same runtime turn as A.
3. The user sees a long stall, and the reply has two readers. Settling is conditional, so it is still saved only once.

This comes from reading the code and hasn't been reproduced with two processes yet.

## Options

- **Sticky routing by chat ID (smallest).** The load balancer hashes on the `/chats/:chatId` path segment, so a chat's send, stream and stop reach one instance. A restart or scale-down moves chats, and the existing lease recovery covers that.
- **Shared fan-out.** The reading instance publishes events through Redis pub/sub (or streams for replay), so any instance can serve the stream. More work, but no instance is tied to a chat.
- Either way, B should not start a recovery reader while A's lease is fresh. Today the lease wait hides this; make it explicit.

## Done when

- A two-instance test (send on A, stream on B) shows the first token with no lease wait and exactly one reader.
- Killing the reading instance mid-reply still recovers the reply on another instance, with a test.
- The live stream's 15 s heartbeat cost is measured at the expected number of concurrent streams.
