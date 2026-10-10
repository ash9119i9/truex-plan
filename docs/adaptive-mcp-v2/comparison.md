# Adaptive MCP V2: complete live token and payload comparison

**The final adaptive implementation reduced reported input tokens from 48,490 to 18,210: 62.4% fewer, across the same three-message thread.** It used the same four model calls as direct mode. The platform selected tools and response fields automatically; the end user supplied no `enabled_tools` or field list. All changes are outside the pinned Codex repository.

## Four fresh live modes

| Mode          | Model calls | Reported input tokens | Reported output tokens | Reported total | Input change vs direct |
| ------------- | ----------: | --------------------: | ---------------------: | -------------: | ---------------------: |
| Direct        |           4 |                48,490 |                    783 |         49,273 |               baseline |
| Omni optional |           7 |                71,757 |                    724 |         72,481 |                 +48.0% |
| Omni required |           7 |                68,408 |                    521 |         68,929 |                 +41.1% |
| Adaptive V2   |           4 |                18,210 |                    668 |         18,878 |                 -62.4% |

Every primary attempt returned HTTP 200, completed, and supplied generation usage. No unknown-usage retry is omitted from this primary table. These are reported tokens, not confirmed currency savings: the custom gateway’s billing rates are unknown, and upstream output counters have a tool-call anomaly. Four sequential live trials are evidence for this scenario, not a statistically established performance guarantee.

## Same messages, one thread per mode

| Turn | Exact message                            | Direct input / output / calls |    Omni optional |    Omni required |     Adaptive V2 |
| ---- | ---------------------------------------- | ----------------------------: | ---------------: | ---------------: | --------------: |
| 1    | Hi bro ?                                 |               9,694 / 226 / 1 |  8,467 / 166 / 1 |   8,578 / 74 / 1 | 3,065 / 125 / 1 |
| 2    | Can you list down the apps in the qlik ? |              24,108 / 546 / 2 | 49,273 / 503 / 5 | 47,685 / 438 / 5 | 9,148 / 484 / 2 |
| 3    | What is the capital of india ?           |               14,688 / 11 / 1 |  14,017 / 55 / 1 |   12,145 / 9 / 1 |  5,997 / 59 / 1 |

The harness waited for completion before sending the next message and awaited MCP startup before the greeting. User messages and requested model profile were identical; live Qlik contents, reload order and assistant wording varied. Third-turn history was preserved, including the preceding Qlik result.

## Why adaptive changed the outcome

The first Uber-style experiment exposed four discovery/invocation tools, following the [Uber Engineering pattern](https://www.uber.com/in/en/blog/designing-mcp-gateway/). It reduced catalog size but added three model calls for server, tool and schema discovery. It also left all 25 native definitions present. The repeated instructions, native schemas and growing discovery history outweighed those savings.

Adaptive V2 instead does the following outside Codex:

1. Fetches attached connector schemas into a scoped platform registry once, outside model context. Registry metadata contains no credentials.
2. Runs local retrieval and authorization before each user turn. It makes no classifier LLM call. Greetings and general knowledge select no business tools; the explicit Qlik question selects `get_apps`.
3. Keeps a static MCP dispatch catalog in Codex while filtering the actual outgoing model request to relevant definitions. Mandatory `update_plan` and `request_user_input` remain exposed.
4. Validates returned model tool-call identities against the exposed set before forwarding them to Codex.
5. Requires the existing read approval and rechecks execution authorization at the adaptive gateway.
6. Applies a platform-owned field policy for the known app-listing intent, then returns names, GUIDs, streams and pagination.

No end-user configuration of tool allowlists is required. Unknown or ambiguous requests can fall back to the four discovery functions rather than silently choosing a server. The retriever is currently lexical/BM25 with calibrated score thresholds and a replaceable retrieval interface; its confidence is a retrieval score, not a probability. Native capability selection currently uses deterministic intent rules at the model boundary. The live registry holds MCP descriptors; the native descriptor catalog is also captured, while native routing families are covered in deterministic fixtures.

## What was exposed on each adaptive call

| User turn                   | Registry routing                    | Business definitions | Native definitions              | Total model definitions | Raw Codex definitions |
| --------------------------- | ----------------------------------- | -------------------- | ------------------------------- | ----------------------: | --------------------: |
| Hi bro ?                    | direct_tools, no business selection | none                 | update_plan, request_user_input |                       2 |                    43 |
| List Qlik apps, before tool | direct_tools, score 1, get_apps     | qlik__get_apps       | update_plan, request_user_input |                       3 |                    43 |
| List Qlik apps, after tool  | same turn plan reused               | qlik__get_apps       | update_plan, request_user_input |                       3 |                    43 |
| Capital of India            | direct_tools, no business selection | none                 | update_plan, request_user_input |                       2 |                    43 |

The 43 raw definitions are 25 native functions, 14 Qlik bindings and four fallback discovery functions. They remain available for dispatch, but **only 2/3/3/2 definitions were actually sent to the model**. Direct mode sent 39 on every call; both Omni modes sent 29 on every call. The raw native catalog was verified unchanged.

## Full input levels and every output counter

Input tokens below are provider-reported for each complete request. Component sizes are captured system text or compact JSON characters and UTF-8 bytes; they show which content travels, but are not component token counts. The provider does not expose a billable system/schema/history/framing split. JSON wire bytes are not added to token usage. Characters here mean Unicode code points.

| Mode          | Call | Turn | Reported input | Reported output | Model schemas | System chars / bytes | Schema JSON chars / bytes | Message/history JSON chars / bytes | Complete body JSON bytes |
| ------------- | ---: | ---: | -------------: | --------------: | ------------: | -------------------: | ------------------------: | ---------------------------------: | -----------------------: |
| Direct        |    1 |    1 |          9,694 |             226 |            39 |      12,624 / 12,624 |           31,333 / 31,335 |                            63 / 63 |                   44,436 |
| Direct        |    2 |    2 |          9,912 |               0 |            39 |      12,624 / 12,624 |           31,333 / 31,335 |                      1,103 / 1,105 |                   45,478 |
| Direct        |    3 |    2 |         14,196 |             546 |            39 |      12,624 / 12,624 |           31,333 / 31,335 |                    15,138 / 15,144 |                   59,517 |
| Direct        |    4 |    3 |         14,688 |              11 |            39 |      12,624 / 12,624 |           31,333 / 31,335 |                    17,052 / 17,064 |                   61,437 |
| Omni optional |    1 |    1 |          8,467 |             166 |            29 |      13,197 / 13,197 |           25,946 / 25,946 |                            63 / 63 |                   39,621 |
| Omni optional |    2 |    2 |          8,633 |               0 |            29 |      13,197 / 13,197 |           25,946 / 25,946 |                          885 / 885 |                   40,443 |
| Omni optional |    3 |    2 |          8,732 |               0 |            29 |      13,197 / 13,197 |           25,946 / 25,946 |                      1,276 / 1,276 |                   40,834 |
| Omni optional |    4 |    2 |          9,047 |               0 |            29 |      13,197 / 13,197 |           25,946 / 25,946 |                      2,781 / 2,781 |                   42,339 |
| Omni optional |    5 |    2 |          9,299 |               0 |            29 |      13,197 / 13,197 |           25,946 / 25,946 |                      3,977 / 3,977 |                   43,535 |
| Omni optional |    6 |    2 |         13,562 |             503 |            29 |      13,197 / 13,197 |           25,946 / 25,946 |                    18,032 / 18,044 |                   57,602 |
| Omni optional |    7 |    3 |         14,017 |              55 |            29 |      13,197 / 13,197 |           25,946 / 25,946 |                    19,734 / 19,748 |                   59,306 |
| Omni required |    1 |    1 |          8,578 |              74 |            29 |      13,388 / 13,388 |           26,310 / 26,310 |                            63 / 63 |                   40,179 |
| Omni required |    2 |    2 |          8,664 |               0 |            29 |      13,388 / 13,388 |           26,310 / 26,310 |                          499 / 501 |                   40,617 |
| Omni required |    3 |    2 |          8,773 |               0 |            29 |      13,388 / 13,388 |           26,310 / 26,310 |                          890 / 892 |                   41,008 |
| Omni required |    4 |    2 |          9,092 |               0 |            29 |      13,388 / 13,388 |           26,310 / 26,310 |                      2,395 / 2,397 |                   42,513 |
| Omni required |    5 |    2 |          9,409 |               0 |            29 |      13,388 / 13,388 |           26,310 / 26,310 |                      3,926 / 3,928 |                   44,044 |
| Omni required |    6 |    2 |         11,747 |             438 |            29 |      13,388 / 13,388 |           26,310 / 26,310 |                    11,771 / 11,773 |                   51,889 |
| Omni required |    7 |    3 |         12,145 |               9 |            29 |      13,388 / 13,388 |           26,310 / 26,310 |                    13,432 / 13,434 |                   53,550 |
| Adaptive V2   |    1 |    1 |          3,065 |             125 |             2 |      12,624 / 12,624 |             2,040 / 2,040 |                            63 / 63 |                   15,141 |
| Adaptive V2   |    2 |    2 |          3,392 |               0 |             3 |      12,624 / 12,624 |             2,792 / 2,792 |                          745 / 745 |                   16,575 |
| Adaptive V2   |    3 |    2 |          5,756 |             484 |             3 |      12,624 / 12,624 |             2,792 / 2,792 |                      8,623 / 8,623 |                   24,453 |
| Adaptive V2   |    4 |    3 |          5,997 |              59 |             2 |      12,624 / 12,624 |             2,040 / 2,040 |                    10,407 / 10,413 |                   25,491 |

System instructions were not trimmed in this experiment. They include the Truex identity, business/tool instructions, agent role and injected permission instructions. The remaining fixed prompt dominates the adaptive greeting: 3,065 reported input tokens even with only the two mandatory tools. Retained results and answers still explain why the India turn takes 5,997 input tokens rather than the cost of its short question alone.

## Automatic projection: real source and preserved result

Final adaptive gateway result: **20,097 bytes → 6,358 bytes**, **68.4% fewer serialized result bytes**. The field policy is:

```json
["apps.name", "apps.guid", "apps.stream", "pagination"]
```

Verification confirmed all 50 returned rows retained exactly the same name, GUID and stream, with the complete pagination object unchanged: limit 50, offset 0, returned 50, total found 1,324, has more true, next offset 50. Descriptions and modification/reload timestamps were removed, and the removed timestamp fields did not reappear in the India model request. Full source results are saved only in diagnostic gateway events, not covertly added back to model context.

For a known listing intent, the model schema hides the response-field selector and the platform enforces its field policy even if a model injects `["*"]`. Explicit requests for raw/all fields or unfamiliar metadata remain separate cases with the broader selection path. Byte reduction is not identical to token reduction.

## Preserved intermediate trials and the issue they caught

| Adaptive trial                                                             | Input tokens | Output tokens | Calls | Projection behavior                                   |
| -------------------------------------------------------------------------- | -----------: | ------------: | ----: | ----------------------------------------------------- |
| [Initial](adaptive-initial/adaptive-capture.json)                          |       18,299 |           822 |     4 | Model omitted fields; default compact result worked   |
| [Model-controlled fields](adaptive-model-projection/adaptive-capture.json) |       22,809 |         1,075 |     4 | Model selected ["*"], keeping all 19,223 source bytes |
| [Final platform policy](adaptive/adaptive-capture.json)                    |       18,210 |           668 |     4 | Known-list projection owned by the platform           |

The second trial exposed a real regression: making the current schema authoritative also exposed the full-result escape hatch, and the model added unrequested last-modified data. We retained that capture, changed the platform’s known-intent field policy, and reran only adaptive mode. The final four-mode table uses the last run; earlier numbers are not substituted to make the result appear better.

## Timing and router overhead

| Mode          | Call | Turn | First provider body byte ms | First text delta ms | First tool block ms | Full provider stream ms |
| ------------- | ---: | ---: | --------------------------: | ------------------: | ------------------: | ----------------------: |
| Direct        |    1 |    1 |                        2242 |                2242 |         not emitted |                    5901 |
| Direct        |    2 |    2 |                        1994 |         not emitted |                2140 |                    2142 |
| Direct        |    3 |    2 |                        2545 |                2546 |         not emitted |                    9994 |
| Direct        |    4 |    3 |                        1707 |                2796 |         not emitted |                    2841 |
| Omni optional |    1 |    1 |                        2299 |                2300 |         not emitted |                    4582 |
| Omni optional |    2 |    2 |                        2032 |         not emitted |                2776 |                    2779 |
| Omni optional |    3 |    2 |                        1775 |         not emitted |                2110 |                    2112 |
| Omni optional |    4 |    2 |                        1834 |         not emitted |                2138 |                    2140 |
| Omni optional |    5 |    2 |                        1758 |         not emitted |                2397 |                    2399 |
| Omni optional |    6 |    2 |                        2434 |                2434 |         not emitted |                    9525 |
| Omni optional |    7 |    3 |                        1773 |                1773 |         not emitted |                    2404 |
| Omni required |    1 |    1 |                        2263 |                2264 |         not emitted |                    3325 |
| Omni required |    2 |    2 |                        1954 |         not emitted |                2129 |                    2133 |
| Omni required |    3 |    2 |                        1683 |         not emitted |                1985 |                    1986 |
| Omni required |    4 |    2 |                        1817 |         not emitted |                2185 |                    2187 |
| Omni required |    5 |    2 |                      122990 |         not emitted |              123781 |                  123784 |
| Omni required |    6 |    2 |                        2543 |                2543 |         not emitted |                    8663 |
| Omni required |    7 |    3 |                        1943 |                1943 |         not emitted |                    1947 |
| Adaptive V2   |    1 |    1 |                        2111 |                2113 |         not emitted |                    3944 |
| Adaptive V2   |    2 |    2 |                        2186 |         not emitted |                3384 |                    3386 |
| Adaptive V2   |    3 |    2 |                        2860 |                2861 |         not emitted |                   10208 |
| Adaptive V2   |    4 |    3 |                        1773 |                1774 |         not emitted |                    2584 |

HTTP headers alone are not labeled as the first text token. Calls emitting only tool use have no text TTFT. One Omni-required invocation-selection call took over two minutes upstream before output; it completed within the shared 180-second first-byte bound. That variability prevents a reliable latency-win claim from these single trials.

| Adaptive user turn | Local routing latency ms | Retrieval score | Selected business tools |
| ------------------ | -----------------------: | --------------: | ----------------------- |
| 1                  |                    0.434 |           0.000 | none                    |
| 2                  |                    0.990 |           1.000 | qlik/get_apps           |
| 3                  |                    0.263 |           0.000 | none                    |

Router work does not consume model tokens. The same plan is reused after a tool result within a turn. Initialization timing, selection trace, schema bytes and requested/effective projection are retained in the captures.

## Answer quality and limits

All four modes actually invoked Qlik and received 50 app rows with total 1,324; none fetched the complete 1,324-app catalog. Every mode answered the India question with New Delhi. The gateway’s projected rows were checked against the actual source, rather than against only the final prose.

The assistants grouped, shortened or sampled the returned app names; some replies claimed a first-50 batch while displaying an abbreviated list. The direct reply introduced its list as “first 30.” These are presentation limitations, not evidence that the connector returned fewer rows. An exact tabular export or automated answer check is still needed when the product promises every returned name verbatim. Complete replies and tool data are preserved below.

## Observability and accounting cautions

Several successful calls generated tool-use blocks while the upstream reported zero output tokens. The captures retain those events, so zero reported output must not be interpreted as free tool arguments. Upstream cache and reasoning counters were absent; runtime defaults of zero do not prove uncached execution or no reasoning. No pricing or caching benefit is invented.

Per-turn runtime usage was reconciled with the provider request sums. All primary calls completed with usage. Credentials and connector HTTP headers are redacted. Permission-removal observability keys matching the general credential-redactor pattern may also appear redacted; safe `permissionRejectedToolNames`/`permissionRejectedToolIds` aliases are captured in the final adaptive trial. Temporary-runtime cleanup emits an intentional SIGTERM, which can print “runtime unavailable” after completed turns; that is not a failed test.

## Complete payloads at all boundaries

| Mode          | Complete capture                        | Raw messages into Codex                       | Raw requests produced by Codex                       | Actual requests sent to model gateway                       | Anthropic requests sent to provider                 | Replies/tool results                   |
| ------------- | --------------------------------------- | --------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| Direct        | [JSON](direct/direct-capture.json)      | [JSONL](direct/direct-codex-input.jsonl)      | [JSONL](direct/direct-responses-requests.jsonl)      | [JSONL](direct/direct-actual-responses-requests.jsonl)      | [JSONL](direct/direct-provider-requests.jsonl)      | [Report](direct/direct-report.md)      |
| Omni optional | [JSON](omni-optional/omni-capture.json) | [JSONL](omni-optional/omni-codex-input.jsonl) | [JSONL](omni-optional/omni-responses-requests.jsonl) | [JSONL](omni-optional/omni-actual-responses-requests.jsonl) | [JSONL](omni-optional/omni-provider-requests.jsonl) | [Report](omni-optional/omni-report.md) |
| Omni required | [JSON](omni-required/omni-capture.json) | [JSONL](omni-required/omni-codex-input.jsonl) | [JSONL](omni-required/omni-responses-requests.jsonl) | [JSONL](omni-required/omni-actual-responses-requests.jsonl) | [JSONL](omni-required/omni-provider-requests.jsonl) | [Report](omni-required/omni-report.md) |
| Adaptive V2   | [JSON](adaptive/adaptive-capture.json)  | [JSONL](adaptive/adaptive-codex-input.jsonl)  | [JSONL](adaptive/adaptive-responses-requests.jsonl)  | [JSONL](adaptive/adaptive-actual-responses-requests.jsonl)  | [JSONL](adaptive/adaptive-provider-requests.jsonl)  | [Report](adaptive/adaptive-report.md)  |

The `turn/start` RPC into Codex contains the new user message. Codex maintains the thread and produces model requests containing full history. Adaptive mode filters the tool definitions in those requests before the model gateway receives them. Therefore “raw Codex request” and “actual model request” are distinct artifacts; both are complete except credential redactions. Input and conversation history are preserved by the filter.

Machine-readable totals and verified invariants: [comparison.json](comparison.json). Deterministic routing examples, thresholds, multiple connectors and authorization cases: [fixture-traces.json](fixture-traces.json). Those fixtures use artificial catalog metadata, not live SAP or Snowflake credentials; the live business-data benchmark is Qlik. Calibration accuracy on the fixture cases is not a universal accuracy guarantee.

For a deeper input split into user messages, assistant text, tool calls, tool results and request-envelope bytes, see the [payload and token ledger](PAYLOAD_TOKEN_LEDGER.md). These remain captured content sizes rather than invented component token charges. Complete test, compiler, credential and unchanged-Codex evidence is recorded in [validation.json](validation.json). The [implementation report](../ADAPTIVE_MCP_GATEWAY_V2.md) describes the adapter, registry, routing, security checks and remaining limits.

## Reproduce

The new script is [benchmark-adaptive-mcp-v2.ts](../../platform/scripts/benchmark-adaptive-mcp-v2.ts). It loads the supplied model and MCP IDs read-only from configured MongoDB, uses the supplied Research Agent role, and creates isolated temporary runtime storage. It never writes tenant/agent records, credentials or `.env` files. Explicit scenario attachment is a diagnostic fixture and does not assert that tenant attachment fields were migrated.

```sh
PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-adaptive-mcp-v2.ts --mode direct
PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-adaptive-mcp-v2.ts --mode omni --projection optional
PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-adaptive-mcp-v2.ts --mode omni --projection required
PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-adaptive-mcp-v2.ts --mode adaptive
```

Use `--out` to preserve these artifacts when replaying. Timeouts default to 180,000 ms upstream and 600,000 ms per turn, with 24 calls maximum per arm. `MCP_ROUTING_MODE` supplies the standalone script’s default mode; explicit `--mode` overrides it. Direct remains the default. These are opt-in V2 experiments, not a production rollout. The pinned Codex revision is `4a942885c8b4745757a9f86ad2075e16c42483c5`; no Codex source or binary modification is required.

## What to optimize next

The highest-value tested change is platform routing plus native tool selection, which removes irrelevant schemas without extra model calls. Platform-owned projection prevents a generic full-result preference from consuming avoidable input. The remaining targets are the fixed instruction text and retained conversation results. Broader multilingual/ambiguous queries, schema changes, permission changes and long threads need continued evaluation; fallback discovery intentionally trades extra calls for avoiding an unsupported selection.
