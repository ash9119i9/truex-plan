# Validate chat v1 on AWS AgentCore (chat v1 slice 12)

Status: open · deferred by the user 2026-10-17 · needs an explicit go (deploys to AWS, calls a paid provider)

## Why deferred

Slices 1–11 run locally against the real Codex pin and a loopback model fixture. Slice 12 is the first step that publishes an image, invokes AgentCore and spends provider money, so it waits for a planned test session.

## Depends on

- Slice 11: adapter + Codex container, `/ping` + `/invocations` bridge, one chat per runtime session, local container test.
- A production-like model profile (see `backlog/model-provider/`).
- The base prompt (`platform-next/src/modules/chats/chat-prompt.ts`) agreed with the user.

## Do

- Deploy the slice 11 image to an isolated AgentCore runtime with `/mnt/state` storage.
- Run first message, follow-up, stop and read-after-runtime-loss through platform-next.
- Measure cold start, time to first text and completion; compare with the local numbers in `backlog/performance/`.
- Check loss-of-disk behaviour: a missing thread must surface `THREAD_LOST`, never a silent new thread.
- Write the runbook: observability, limits, rollback and cutover. No old-data adoption or destructive migration.

## Done when

Staging evidence for each flow above is recorded here, error/latency/resource numbers are healthy, and a rollback has been rehearsed.
