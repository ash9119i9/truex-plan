# Uber-style MCP discovery: live three-message benchmark

The platform controls discovery and response selection; end users do not supply `enabled_tools`. All changes remain outside the pinned Codex repository. We implemented the four-tool discovery/invocation pattern and response projection described by [Uber Engineering](https://www.uber.com/in/en/blog/designing-mcp-gateway/), then tested actual model behavior. This does not claim to recreate Uber’s internal production infrastructure or its separate Code Mode.

**Result: fewer schemas and smaller projected results worked, but total input tokens increased in this small, fresh-thread scenario. Do not enable this architecture as a blanket token optimization on this evidence.** Required projection reduced the real Qlik result by 72%, yet the complete thread consumed 42.6% more input tokens because discovery required three additional model calls.

## Primary comparison: completed runs with identical timeout controls

| Mode                      | Provider calls | Input tokens | Output tokens | Total tokens | Input change versus direct |
| ------------------------- | -------------: | -----------: | ------------: | -----------: | -------------------------: |
| Direct                    |              4 |       48,560 |         1,126 |       49,686 |                   baseline |
| Omni, optional projection |              7 |       71,601 |           691 |       72,292 |                     +47.4% |
| Omni, required projection |              7 |       69,235 |         1,072 |       70,307 |                     +42.6% |

These are upstream-reported generation counters for every successful request. All primary requests returned HTTP 200 and supplied usage, with no retry or unknown-usage attempt in these three completed runs. Currency cost is not calculated because this custom provider’s billing rates are unknown. Output counters still have an upstream tool-call accounting anomaly described below.

## Exact messages and per-turn totals

Each arm used one new thread. The harness waited for each completed response before submitting the next identical message. MCP startup was awaited before the greeting.

| Message                                  | Direct input / output / calls | Omni optional input / output / calls | Omni required input / output / calls |
| ---------------------------------------- | ----------------------------: | -----------------------------------: | -----------------------------------: |
| Hi bro ?                                 |               9,694 / 150 / 1 |                      8,467 / 131 / 1 |                      8,578 / 127 / 1 |
| Can you list down the apps in the qlik ? |              23,942 / 932 / 2 |                     49,146 / 549 / 5 |                     47,961 / 936 / 5 |
| What is the capital of india ?           |               14,924 / 44 / 1 |                      13,988 / 11 / 1 |                       12,696 / 9 / 1 |

A greeting saved 1,227 input tokens with optional discovery (12.7%). Required projection added guidance, so its greeting saved 1,116 (11.5%). The unrelated India question saved 2,228 input tokens with required projection (14.9%), because its retained history was smaller. Those savings were outweighed by the Qlik turn: 47,961 input tokens with required projection versus 23,942 directly.

## What actually executed

Direct: `get_apps({"limit":50})` → answer.

Both Omni runs: `discover_server({"query":"qlik"})` → `discover_tools({"server":"qlik","query":"list apps"})` → `get_tool_schema({"server":"qlik","tool":"get_apps"})` → `invoke_tool(...)` → answer. Each arrow after a returned tool result required another model request. All other native tools were unchanged.

The wrapper was approved only for this explicitly authorized Qlik read. The harness issued a single `Allow` answer and no persistent wrapper grant. Discovery calls are read-only and automatically approved. Generic invocation is not advertised as read-only, and arbitrary writes or unrelated questions would stop the harness.

## Real response projection

Optional projection was available, but the model omitted `fields`. The actual result remained **21,941 bytes → 21,941 bytes**, with no projection savings. The platform-owned required mode made field selection part of the wrapper contract and supplied selection guidance. The model then chose:

```json
["apps.name", "apps.stream", "apps.published", "apps.guid", "pagination"]
```

The real gateway event measured **22,444 bytes → 6,278 bytes**, a **72.0% reduction** in serialized tool-result bytes. Names, GUIDs, streams, all 50 rows and the complete pagination object were preserved. Descriptions and modification/reload timestamps were removed. `apps.published` was selected but absent in the source; it was omitted without inventing a value. The India request also contained the projected result, and verification confirmed the removed timestamp fields did not reappear in model history.

This byte reduction is not an exact token reduction. Different result ordering, answers and live reloads make the optional-versus-required total token difference directional: 71,601 → 69,235 input tokens, 3.3% lower. Required mode includes an explicit `["*"]` escape hatch for intentionally requesting a full or non-JSON result, so it is not a guarantee that every future invocation will be compact.

## Every model request and its input levels

The token column is measured for the entire request. Character columns show actual captured content sizes using compact JSON for schemas and messages; they are not exact component token counts and must not be added to provider token usage. Each call includes all system text, currently exposed schemas and full retained history.

| Arm                       | Call | Turn |  Input | Output | Schemas | System text chars | All schema JSON chars | Connector schema JSON chars | Message/history JSON chars |
| ------------------------- | ---: | ---: | -----: | -----: | ------: | ----------------: | --------------------: | --------------------------: | -------------------------: |
| Direct                    |    1 |    1 |  9,694 |    150 |      39 |            12,624 |                31,333 |                       7,192 |                         63 |
| Direct                    |    2 |    2 |  9,846 |      0 |      39 |            12,624 |                31,333 |                       7,192 |                        843 |
| Direct                    |    3 |    2 | 14,096 |    932 |      39 |            12,624 |                31,333 |                       7,192 |                     14,740 |
| Direct                    |    4 |    3 | 14,924 |     44 |      39 |            12,624 |                31,333 |                       7,192 |                     17,326 |
| Omni, optional projection |    1 |    1 |  8,467 |    131 |      29 |            13,197 |                25,946 |                       1,805 |                         63 |
| Omni, optional projection |    2 |    2 |  8,602 |     12 |      29 |            13,197 |                25,946 |                       1,805 |                        799 |
| Omni, optional projection |    3 |    2 |  8,720 |      0 |      29 |            13,197 |                25,946 |                       1,805 |                      1,265 |
| Omni, optional projection |    4 |    2 |  9,035 |      0 |      29 |            13,197 |                25,946 |                       1,805 |                      2,770 |
| Omni, optional projection |    5 |    2 |  9,283 |      3 |      29 |            13,197 |                25,946 |                       1,805 |                      3,966 |
| Omni, optional projection |    6 |    2 | 13,506 |    534 |      29 |            13,197 |                25,946 |                       1,805 |                     17,943 |
| Omni, optional projection |    7 |    3 | 13,988 |     11 |      29 |            13,197 |                25,946 |                       1,805 |                     19,687 |
| Omni, required projection |    1 |    1 |  8,578 |    127 |      29 |            13,388 |                26,310 |                       2,169 |                         63 |
| Omni, required projection |    2 |    2 |  8,710 |      0 |      29 |            13,388 |                26,310 |                       2,169 |                        765 |
| Omni, required projection |    3 |    2 |  8,815 |      0 |      29 |            13,388 |                26,310 |                       2,169 |                      1,156 |
| Omni, required projection |    4 |    2 |  9,130 |      0 |      29 |            13,388 |                26,310 |                       2,169 |                      2,661 |
| Omni, required projection |    5 |    2 |  9,441 |      0 |      29 |            13,388 |                26,310 |                       2,169 |                      4,192 |
| Omni, required projection |    6 |    2 | 11,865 |    936 |      29 |            13,388 |                26,310 |                       2,169 |                     12,121 |
| Omni, required projection |    7 |    3 | 12,696 |      9 |      29 |            13,388 |                26,310 |                       2,169 |                     15,104 |

There are **25 identical native functions** in every arm. Direct mode adds 14 Qlik functions, for 39 total. Both Omni modes add four wrapper functions, for 29 total. The 25 native schemas were verified structurally equal across all arms. Discovery keeps connector catalogs outside model context until requested, but the discovery responses and selected schema themselves remain in thread history. Neither approach removes that conversation history automatically.

The current model supplies aggregate input usage, so an exact billable split between system instructions, schemas, history, framing and tool results is unavailable. This report intentionally separates captured sizes from measured request totals.

## Answer quality and observability findings

All arms answered the India question with New Delhi. All Qlik invocations succeeded, returned 50 apps, and reported pagination total 1,324 with more pages available. None fetched all 1,324 apps.

The clean direct reply incorrectly said “server returned 28 at this page,” although the tool returned 50. Omni optional correctly reported a 50-row return but presented a sample rather than every returned name. Required mode’s full reply and rows are retained in its report; compact inputs do not establish answer correctness by themselves. The optional model stream also emitted an `(empty placeholder)` message, captured verbatim rather than hidden.

Several responses generated tool-use blocks while reporting zero output tokens: direct call 2; optional calls 3 and 4; required calls 2–5. This makes the supplied output totals an imperfect measure of actual generated tool arguments. Cache and reasoning usage fields were absent upstream; runtime zeros do not prove free caching or zero reasoning. No caching savings are claimed.

Turn latency is recorded in the per-arm reports and captures, but one serial run is too noisy to establish a latency improvement. Extra discovery calls add round trips. The intentional SIGTERM during temporary-runtime cleanup can print “runtime unavailable” after completion; it is not a failed test turn.

## Complete raw payloads and run evidence

| Arm | Full capture | Into Codex: JSON-RPC stdin | By Codex: Responses requests | To provider: Anthropic requests | Messages and tool results |
|---|---|---|---|---|
| Direct | [JSON](extended/direct-capture.json) | [JSONL](extended/direct-codex-input.jsonl) | [JSONL](extended/direct-responses-requests.jsonl) | [JSONL](extended/direct-provider-requests.jsonl) | [Report](extended/direct-report.md) |
| Omni, optional projection | [JSON](extended/omni-capture.json) | [JSONL](extended/omni-codex-input.jsonl) | [JSONL](extended/omni-responses-requests.jsonl) | [JSONL](extended/omni-provider-requests.jsonl) | [Report](extended/omni-report.md) |
| Omni, required projection | [JSON](projected/omni-capture.json) | [JSONL](projected/omni-codex-input.jsonl) | [JSONL](projected/omni-responses-requests.jsonl) | [JSONL](projected/omni-provider-requests.jsonl) | [Report](projected/omni-report.md) |

The `turn/start` payload into Codex carries the new user message. Codex reconstructs full model history internally; therefore the complete payload **into Codex** and the complete payload **sent by Codex to the model gateway** are different boundaries. Both are captured. The gateway’s Anthropic translation is captured as a third boundary, together with SSE response events, token usage, runtime traces, gateway timings, approvals and MCP results. Credentials and connector HTTP headers are redacted. Full source results retained in diagnostic gateway events are not silently added to the projected model request.

Machine-readable totals and integrity checks: [comparison.json](comparison.json).

## Earlier attempts retained separately

The initial 60-second upstream timeout run had a complete direct thread with one failed attempt and unknown usage: [direct capture](direct-capture.json). The first optional Omni attempt timed out during turn 2 after repeated upstream timeouts: [incomplete Omni capture](omni-capture.json). It never invoked Qlik or reached turn 3. These runs are retained as failure evidence and excluded from the primary savings comparison. Unknown usage is not treated as zero cost.

The three primary arms used 180,000 ms first-byte/idle limits and 600,000 ms per-turn limits, uniformly. Changing these diagnostic timeout limits did not change the profile, questions, or native tool schemas. Calls were capped at 24 per arm.

## Reproduce without changing Codex

Run from the repository root. The script loads credentials from configured MongoDB through `platform/.env` and `agent-core/.env`; credentials are neither command-line arguments nor saved payload values. Each process creates isolated temporary runtime storage, attaches the supplied explicit scenario MCP, and performs no database writes.

```sh
PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-omni-mcp.ts --mode direct --out docs/omni-mcp-benchmark/extended --timeout-ms 600000 --upstream-timeout-ms 180000
PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-omni-mcp.ts --mode omni --projection optional --out docs/omni-mcp-benchmark/extended --timeout-ms 600000 --upstream-timeout-ms 180000
PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-omni-mcp.ts --mode omni --projection required --out docs/omni-mcp-benchmark/projected --timeout-ms 600000 --upstream-timeout-ms 180000
```

Use a different `--out` directory to preserve these exact artifacts when replaying. Model and connector profiles are the supplied IDs; the explicit fixture does not assert that the tenant database’s agent attachment fields were rewritten. The pinned revision is `4a942885c8b4745757a9f86ad2075e16c42483c5`; `git -C vendor/codex status --porcelain --untracked-files=no` returned no modifications. The benchmark script passed strict TypeScript checking, and live verification confirmed three completed sequential turns per arm, HTTP 200 plus usage for every primary request, equal native schemas, preserved projected rows/pagination and valid JSON/JSONL.

## What this supports

Keep the implementation opt-in for evaluation. Response projection works and is worth testing on larger results. Four-tool discovery can be valuable when a large connector catalog overwhelms context, but this 14-tool connector did not offset its new discovery calls in a fresh thread. A promising next experiment is platform-selected tools for the user’s intent plus projection, while reducing the 25 native definitions and avoiding repeated server/schema discovery; measure complete-conversation input again rather than assuming a smaller initial schema means a cheaper task.

## Implementation verification

The final AgentCore test suite passed **207 tests**, including gateway transport/projection, runtime lifecycle, actual pinned Codex approval/denial, and dispatcher approval scope. AgentCore and platform TypeScript builds passed. Formatting and `git diff --check` passed for the final changes. Independent capture checks reconciled per-turn runtime usage with provider counters, confirmed one thread and strict turn order per arm, parsed every primary JSONL file, and verified all 50 projected app names, GUIDs, streams and pagination against the original result. A separate scan confirmed configured model and MCP credential values are absent from the deliverable files. Codex remains at the pinned revision with a clean worktree; production environment files and database records were not modified.
