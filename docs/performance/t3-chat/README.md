# Backend chat history fixture benchmark

These results measure `PlatformService.history()` against an isolated MongoDB process and a synthetic owning runtime. They demonstrate operation-count and response-size changes; they do not measure a production deployment, browser rendering, or provider latency.

The baseline is commit `e44b79e9c5eea2b5de000a0cfca6ffff8a5821ec`. The after measurements use the working tree containing the chat performance changes. Measurements were captured on this Mac on 2026-10-05.

## Recorded results

- [backend-before.jsonl](backend-before.jsonl): original full-history recovery, before backend edits.
- [backend-after.jsonl](backend-after.jsonl): recovery batching and persisted-only reads.
- [backend-window-after.jsonl](backend-window-after.jsonl): the later run adding recent-history windows and payload byte counts.
- [reproduced-before.jsonl](reproduced-before.jsonl) and [reproduced-after.jsonl](reproduced-after.jsonl): a sequential verification run using the checked-in runner against the detached baseline and modified checkout. At 1,000 turns, repeated recovery measured 909.03 ms versus 278.91 ms, and the recent persisted window measured 4.46 ms. Operation and payload counts matched the earlier runs.

The JSONL files preserve the original probe output, including local checkout paths. Both `first-open` and `repeat-open` are medians of three executions against existing persisted messages. The first group is **not** a runtime cold-start benchmark. Their names describe successive measurement groups; every runtime response is synthetic and idle.

Representative 1,000-turn results:

| Measurement | Before | After |
|---|---:|---:|
| Repeated full recovery median | 1,128.52 ms | 283.17 ms after batching; 294.47 ms in the later window run |
| Persisted recent window median | unavailable | 4.85 ms |
| Message identity lookups per full recovery | 1,000 individual lookups | 20 page lookups |
| Reconciliation collection writes | 2,000 individual writes | 20 ordered bulk calls, still 2,000 logical updates |
| Persisted complete/recent response size in window run | 396,188 bytes complete | 4,386 bytes recent |
| Returned complete/recent messages | 2,000 | 20 |

Timings vary with machine load. The operation counts and selected message counts are deterministic fixture results. The recent-window byte comparison is between two modes of the **same later run**, rather than bytes recorded by the original pre-edit probe.

## Reproduce

Run from the repository root with its existing installed dependencies. The script requires an already cached MongoDB binary used by the repository's `mongodb-memory-server` tests; it disables automatic runtime downloads. No live services, private database, API keys, or `.env` files are used.

Prepare a detached baseline checkout and reuse the existing platform dependencies:

```sh
bench_before=$(mktemp -d /tmp/truex-chat-baseline.XXXXXX)
git worktree add --detach "$bench_before" e44b79e9c5eea2b5de000a0cfca6ffff8a5821ec
ln -s "$PWD/platform/node_modules" "$bench_before/platform/node_modules"
```

Run the same checked-in script sequentially against the baseline and the modified checkout:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs \
  scripts/benchmark-chat-history.mjs --repo "$bench_before" > /tmp/chat-before.jsonl

node --import ./platform/node_modules/tsx/dist/loader.mjs \
  scripts/benchmark-chat-history.mjs --persisted --window > /tmp/chat-after.jsonl
```

The baseline supports the full-history modes. Use `--persisted` and `--window` only against the modified implementation. The script asserts successful responses, expected message counts, and zero runtime calls/state writes for persisted modes; an unsupported or broken path fails the run.

Remove the temporary baseline worktree when finished:

```sh
git worktree remove "$bench_before"
```

## Fixture and measurement boundaries

The [script](../../../scripts/benchmark-chat-history.mjs) seeds 10, 100, and 1,000 turns, each with one user message and one assistant message. All documents share a timestamp, ensuring reconciliation ordering rather than timestamp differences controls the result. Assistant messages are already persisted; recovery still executes the real method and database operations. The saved plan is unchanged and the durable record queue is empty.

The owning runtime is replaced at `service.owned()` with a deterministic fixture. Each owner call waits 8 ms; runtime items paginate at 100 items per page. The benchmark exercises actual snapshot handling, record ingestion, reconciliation, persisted reads, and ordering in the selected checkout. `MongoMemoryServer` owns the only database used and is stopped after the run.

Each sample times the service method. HTTP routing, cookie authentication, JSON serialization, transfer, and frontend rendering are outside that timed interval. `payloadBytes` measures `JSON.stringify()` output separately. Counters observe collection methods, not every low-level Mongo wire command; `bulkWriteOperations` records logical updates inside the bulk calls.

Recent windows reduce response and client work. They still read and order the entire persisted transcript in Mongo. Whole request groups, command-only transcripts, and a large individual turn have no hard byte limit. Platform SSE snapshot filtering reduces downstream content; the upstream runtime snapshot is still received and parsed in full.

Authorization, tenant/user/role/visibility isolation, concurrent recovery, cursor failures, partial-write retry, command anchors, and pending/action state are verified separately in `platform/test/history.test.ts`, `platform/test/history-window.test.ts`, and the HTTP/ownership integration tests.
