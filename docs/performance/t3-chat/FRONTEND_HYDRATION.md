This benchmark measures only `historyEntries()` against generated, nonprivate
messages. It excludes module loading, fixture generation, network requests,
React rendering, Markdown parsing, layout, scrolling, and runtime agents. These
results describe helper CPU cost, not chat-opening latency or T3 Code's speed.

Each fixture runs once to warm up, then five times in the same process. The raw
JSON retains every sample and its median, Node/V8 and CPU metadata, and the exact
helper source hash. The before and after runs use the same script in separate
processes, executed sequentially on the same machine. Background system work and
garbage collection can affect samples; this is not an isolated laboratory test.

The representative fixtures contain 100, 1,000, 5,000, and 10,000 alternating user
and assistant messages with unique item identities and one turn per pair. The
optional 10,000-message stress fixture puts distinct assistant items with equal
text and distinct ordinals into one turn, checking that they remain separate.

Run with Node supporting TypeScript type stripping:

```sh
node --experimental-strip-types docs/performance/t3-chat/benchmark-chat-hydration.mjs --repo /path/to/baseline --single-turn > frontend-hydration-before.json
node --experimental-strip-types docs/performance/t3-chat/benchmark-chat-hydration.mjs --repo /path/to/current --single-turn > frontend-hydration-after.json
```

The checked-in `frontend-hydration-before.json` uses the baseline checkout at
`/tmp/truex-chat-before`; `frontend-hydration-after.json` uses the implementation in
this repository. The temporary baseline path is recorded as evidence, not a
required location for reproducing the benchmark.
