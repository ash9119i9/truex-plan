# Bounded history body reads

Baseline `d6e3f45a45e6948873b8a64d0a9453fb2c2f4307`; candidate uses the
same authoritative command ordering and request-group pagination. Large chats
load compact ordering headers, then fetch only selected page bodies by ID.
Small chats retain one body query. Full-history callers retain their contract.
No migration, schema field, index, or dependency was added.

Paired actual Store/PlatformService and isolated Mongo; 1 KiB text per message,
one warm-up and seven measured runs per size, Node24.21.0. No provider or user's
database. These are service measurements, not browser or production latency.

|  Turns | Baseline median | Candidate median | Bodies decoded before → after |
| -----: | --------------: | ---------------: | ----------------------------: |
|     10 |         0.76 ms |          0.73 ms |                        20 →20 |
|    100 |         1.48 ms |          1.52 ms |                      200 →200 |
|  1,000 |         9.00 ms |          5.51 ms |                    2,000 →271 |
| 10,000 |        72.97 ms |         27.85 ms |                   20,000 →271 |

At10,000 turns JSON transferred from Mongo falls from23,414,451 to1,943,221
bytes, including the compact headers and constant251-body size probe. The API
still returns the same20 messages. `totalDocsExamined` for ordering remains20,000:
this bounds expensive body decoding, **not** the metadata scan or ordering CPU.
Complete oversized request groups remain complete and can exceed the usual page
size. No claim of constant-time reads or bounded single-turn bytes is made.

The initial75-record cutoff improved large chats but added two queries at100
turns, increasing that fixture's median from1.48 to1.75ms. A measured250-record
cutoff preserves the single-query path at that size; the271 decoded bodies for
long chats are251 probe records plus20 page records. This is a measured Truex
adaptation, rather than blindly copying T3's frontend page size.

The original402-body regression fails before and passes after. Tests compare
every concatenated page to authoritative full ordering; commands and equal
timestamps, empty/short histories, complete400-message single groups, anchored
pages under concurrent append, removed anchors and deletion between metadata
and body reads are covered. A partial page returns an actionable409 rather than
silently caching missing content. Authorization remains before any history read.
Concurrent edits to ordering metadata are not a transactionally isolated read;
that existing consistency limit is unchanged.

Raw evidence: `next-history-{before,after}.json`,
`next-history-threshold-75.json`, `next-history-read-{before,after}.txt`.

Reproduce:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-history-benchmark.mjs /tmp/truex-chat-next-before
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/next-history-benchmark.mjs .
npm --prefix platform test
```

The first argument can be any detached baseline checkout with installed platform
dependencies. Keep benchmark runs sequential to avoid CPU contention. Rollback
is the original full-body read before `historyWindow`; no migration is needed.
