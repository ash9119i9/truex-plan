# T3 streaming Markdown adoption

Truex now uses the incremental parser from [T3 Code's markdown-incremental.ts](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/markdown-incremental.ts), retaining its MIT license notice. The wrapper follows T3's ChatMarkdown activation boundary: a streaming document with a code fence and a known remark pipeline. Completed answers use the full parser. No new highlighting, raw HTML support, streaming transport behavior, or token dropping is introduced.

A closed top-level fence followed by a blank line makes the preceding Markdown stable. Its pristine syntax tree is cached; subsequent updates parse the suffix, restore absolute source positions, and clone the cached prefix before transforms mutate it. Document-wide link/footnote definitions, carriage returns, BOM characters, changed prefixes, and secondary transform parses use the full/original parser. Nested or incomplete fences are not cached. The whole document still passes through GFM transforms and React rendering; this optimization saves parsing, not every rendering stage.

## Reproduce

```sh
node --experimental-strip-types docs/performance/t3-chat/benchmark-streaming-markdown.mjs --repo /tmp/truex-chat-before --mode full
node --experimental-strip-types docs/performance/t3-chat/benchmark-streaming-markdown.mjs --repo /Users/ashok/truex-plan --mode incremental
```

The harness dynamically imports each checkout's actual ReactMarkdown/GFM dependencies. Each synthetic stream has 81 updates, with a full parse on its final settled update. Each fixture runs one warmup followed by five samples in a fresh process. Timing includes Markdown parsing, transforms, React element rendering, and server HTML serialization; it excludes fixture generation and HTML digesting. Parsing time is also measured inside the actual parser. This is CPU-only evidence: browser reconciliation, layout, paint, network, token arrival, and live user data are excluded. Both modes produced identical hashes over every intermediate rendered HTML output.

| Fixture                                         | Median total render before / after | Median parser before / after | Parsed characters before / after |
| ----------------------------------------------- | ---------------------------------- | ---------------------------- | -------------------------------- |
| Three completed code fences plus streamed prose | 180.54 / 55.27 ms                  | 161.86 / 35.88 ms            | 1,754,181 / 134,286              |
| Prose without fences (unchanged parser control) | 263.49 / 314.98 ms                 | 187.78 / 224.63 ms           | 456,966 / 456,966                |

The code fixture reduced measured total CPU rendering by 69% and parser input by 92%. The unchanged prose control varied by 20%; concurrent host work, scheduling, and garbage collection limit precise timing comparisons. The deterministic parser-input reduction and equivalent HTML establish the mechanism independently of timing. These figures do not establish browser streaming latency or a general improvement for prose-only streams.

Regression tests compare rendered HTML and transformed AST/source positions at every character prefix for prose, GFM, late references, footnotes, nested/unclosed fences, escaped HTML, and Unicode. Additional cases cover replacement text, CRLF/BOM, repeated renders, private caches, suffix-only parsing, and synthetic secondary parses. The original full parser remains the fallback and final-answer authority.

Raw measurements: `streaming-markdown-before.json`, `streaming-markdown-after.json`. Runnable harness: `benchmark-streaming-markdown.mjs`.
