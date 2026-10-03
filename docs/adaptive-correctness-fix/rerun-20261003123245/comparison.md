# Five messages: complete MCP token and execution report

Each table cell is **provider-reported input / output / upstream calls**. These are five sequential user turns in one fresh thread per mode. Omni uses required projection. Full message text, model requests, raw outputs and tool results are retained in the linked turn bundles.

| Turn        | Exact user message                    | Direct input / output / calls | Omni required input / output / calls | Adaptive input / output / calls |
| ----------- | ------------------------------------- | ----------------------------: | -----------------------------------: | ------------------------------: |
| 1           | hi this is ashok ?                    |               7,953 / 111 / 1 |                      8,581 / 112 / 1 |                 3,068 / 179 / 1 |
| 2           | What is the capital of India ?        |                8,067 / 47 / 1 |                       8,696 / 56 / 1 |                  3,241 / 56 / 1 |
| 3           | what are the Qlik apps ?              |              24,965 / 148 / 3 |                     35,763 / 157 / 4 |                11,756 / 189 / 3 |
| 4           | What is the capital of tamilnadu ?    |                8,630 / 43 / 1 |                       9,243 / 51 / 1 |                  3,798 / 55 / 1 |
| 5           | Explain this qlik app T_DCF_BANKREC_P |              17,580 / 127 / 2 |                     18,749 / 178 / 2 |                 4,291 / 108 / 1 |
| **Overall** | **All five messages**                 |              67,195 / 476 / 8 |                     81,032 / 554 / 9 |                26,154 / 587 / 7 |

All three threads completed all five turns. The harness waited for the preceding response before submitting the next message.

**Business-task limitation:** Direct and Omni required and Adaptive retrieved no Qlik app list. The retrieval-coverage table below distinguishes unavailable results from completed work. These counter sums do not establish equivalent end-to-end savings.

Input/output totals are the custom upstream's counters, not independently verified billing. Tool-use events with zero reported output are flagged below. Cache/reasoning counters absent upstream remain unknown. No exact system/schema/history token split or currency cost is invented.

## Overall counters and accounting gaps

| Mode          | Status    | Reported input | Reported output | Reported total | Attempts | Attempts missing input / output | Non-200 attempts | Zero tool-output anomalies |
| ------------- | --------- | -------------: | --------------: | -------------: | -------: | ------------------------------: | ---------------: | -------------------------: |
| Direct        | completed |         67,195 |             476 |         67,671 |        8 |                           0 / 0 |                0 |                          0 |
| Omni required | completed |         81,032 |             554 |         81,586 |        9 |                           0 / 0 |                0 |                          1 |
| Adaptive      | completed |         26,154 |             587 |         26,741 |        7 |                           0 / 0 |                0 |                          0 |

Correctness gate: **failed**. Equivalent-work performance claims are withheld. [Full gate evidence](CORRECTNESS_GATE.md).

## Every model request: input levels

The sizes below are captured system text and compact JSON Unicode characters / UTF-8 bytes. They are not model token counts. The complete request-body size includes JSON serialization that is not a billable-token attribution.

| Mode          | Call | Turn | Reported input / output | Native / MCP schemas | System text chars / bytes | Schema JSON chars / bytes | History JSON chars / bytes | Request body bytes |
| ------------- | ---: | ---: | ----------------------: | -------------------: | ------------------------: | ------------------------: | -------------------------: | -----------------: |
| Direct        |    1 |    1 |             7,953 / 111 |               25 / 0 |           12,624 / 12,624 |           24,142 / 24,142 |                    73 / 73 |             37,253 |
| Direct        |    2 |    2 |              8,067 / 47 |               25 / 0 |           12,624 / 12,624 |           24,142 / 24,142 |                  693 / 693 |             37,873 |
| Direct        |    3 |    3 |              8,125 / 12 |               25 / 0 |           12,624 / 12,624 |           24,142 / 24,142 |              1,009 / 1,009 |             38,189 |
| Direct        |    4 |    3 |              8,314 / 39 |               25 / 0 |           12,624 / 12,624 |           24,142 / 24,142 |              1,818 / 1,818 |             38,998 |
| Direct        |    5 |    3 |              8,526 / 97 |               25 / 0 |           12,624 / 12,624 |           24,142 / 24,142 |              2,735 / 2,737 |             39,917 |
| Direct        |    6 |    4 |              8,630 / 43 |               25 / 0 |           12,624 / 12,624 |           24,142 / 24,142 |              3,277 / 3,281 |             40,461 |
| Direct        |    7 |    5 |              8,690 / 16 |               25 / 0 |           12,624 / 12,624 |           24,142 / 24,142 |              3,588 / 3,592 |             40,772 |
| Direct        |    8 |    5 |             8,890 / 111 |               25 / 0 |           12,624 / 12,624 |           24,142 / 24,142 |              4,404 / 4,408 |             41,588 |
| Omni required |    1 |    1 |             8,581 / 112 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |                    73 / 73 |             40,189 |
| Omni required |    2 |    2 |              8,696 / 56 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |                  691 / 691 |             40,807 |
| Omni required |    3 |    3 |              8,762 / 12 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |              1,027 / 1,027 |             41,143 |
| Omni required |    4 |    3 |               8,876 / 0 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |              1,493 / 1,493 |             41,609 |
| Omni required |    5 |    3 |              8,986 / 48 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |              1,922 / 1,922 |             42,038 |
| Omni required |    6 |    3 |              9,139 / 97 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |              2,562 / 2,562 |             42,678 |
| Omni required |    7 |    4 |              9,243 / 51 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |              3,081 / 3,081 |             43,197 |
| Omni required |    8 |    5 |              9,310 / 24 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |              3,418 / 3,418 |             43,534 |
| Omni required |    9 |    5 |             9,439 / 154 |               25 / 4 |           13,388 / 13,388 |           26,310 / 26,310 |              3,971 / 3,971 |             44,087 |
| Adaptive      |    1 |    1 |             3,068 / 179 |                2 / 0 |           12,624 / 12,624 |             2,040 / 2,040 |                    73 / 73 |             15,151 |
| Adaptive      |    2 |    2 |              3,241 / 56 |                2 / 0 |           12,624 / 12,624 |             2,040 / 2,040 |                  942 / 942 |             16,020 |
| Adaptive      |    3 |    3 |              3,730 / 14 |                2 / 4 |           12,624 / 12,624 |             3,878 / 3,878 |              1,280 / 1,280 |             18,196 |
| Adaptive      |    4 |    3 |              3,895 / 94 |                2 / 4 |           12,624 / 12,624 |             3,878 / 3,878 |              2,053 / 2,053 |             18,969 |
| Adaptive      |    5 |    3 |              4,131 / 81 |                2 / 4 |           12,624 / 12,624 |             3,878 / 3,878 |              3,139 / 3,139 |             20,055 |
| Adaptive      |    6 |    4 |              3,798 / 55 |                2 / 0 |           12,624 / 12,624 |             2,040 / 2,040 |              3,614 / 3,614 |             18,692 |
| Adaptive      |    7 |    5 |             4,291 / 108 |                2 / 4 |           12,624 / 12,624 |             3,878 / 3,878 |              3,972 / 3,972 |             20,888 |

## Output text and tool-argument payloads

These are generated content sizes reconstructed from the complete raw provider SSE. They are not exact output-token allocations. Tool argument JSON may be emitted even when the upstream reports zero output tokens; the raw events remain authoritative.

| Mode          | Call | Reported output tokens | Assistant text chars / bytes | Tool argument JSON chars / bytes                                  | Thinking chars / bytes |
| ------------- | ---: | ---------------------: | ---------------------------: | ----------------------------------------------------------------- | ---------------------: |
| Direct        |    1 |                    111 |                    467 / 467 | none                                                              |                  0 / 0 |
| Direct        |    2 |                     47 |                    174 / 174 | none                                                              |                  0 / 0 |
| Direct        |    3 |                     12 |                      49 / 49 | list_mcp_resources: 18 / 18; list_mcp_resource_templates: 18 / 18 |                  0 / 0 |
| Direct        |    4 |                     39 |                    157 / 159 | list_mcp_resource_templates: 18 / 18; list_mcp_resources: 18 / 18 |                  0 / 0 |
| Direct        |    5 |                     97 |                    393 / 395 | none                                                              |                  0 / 0 |
| Direct        |    6 |                     43 |                    156 / 156 | none                                                              |                  0 / 0 |
| Direct        |    7 |                     16 |                      56 / 56 | list_mcp_resources: 18 / 18; list_mcp_resource_templates: 18 / 18 |                  0 / 0 |
| Direct        |    8 |                    111 |                    436 / 436 | none                                                              |                  0 / 0 |
| Omni required |    1 |                    112 |                    465 / 465 | none                                                              |                  0 / 0 |
| Omni required |    2 |                     56 |                    193 / 193 | none                                                              |                  0 / 0 |
| Omni required |    3 |                     12 |                      49 / 49 | mcp__omni__discover_server: 17 / 17                               |                  0 / 0 |
| Omni required |    4 |                      0 |                        0 / 0 | mcp__omni__discover_tools: 40 / 40                                |                  0 / 0 |
| Omni required |    5 |                     48 |                    190 / 190 | mcp__omni__discover_tools: 35 / 35                                |                  0 / 0 |
| Omni required |    6 |                     97 |                    365 / 365 | none                                                              |                  0 / 0 |
| Omni required |    7 |                     51 |                    181 / 181 | none                                                              |                  0 / 0 |
| Omni required |    8 |                     24 |                      96 / 96 | mcp__omni__discover_tools: 42 / 42                                |                  0 / 0 |
| Omni required |    9 |                    154 |                    559 / 561 | none                                                              |                  0 / 0 |
| Adaptive      |    1 |                    179 |                    709 / 709 | none                                                              |                  0 / 0 |
| Adaptive      |    2 |                     56 |                    195 / 195 | none                                                              |                  0 / 0 |
| Adaptive      |    3 |                     14 |                      62 / 62 | mcp__adaptive__discover_server: 17 / 17                           |                  0 / 0 |
| Adaptive      |    4 |                     94 |                    373 / 373 | mcp__adaptive__discover_server: 17 / 17                           |                  0 / 0 |
| Adaptive      |    5 |                     81 |                    326 / 326 | none                                                              |                  0 / 0 |
| Adaptive      |    6 |                     55 |                    202 / 202 | none                                                              |                  0 / 0 |
| Adaptive      |    7 |                    108 |                    402 / 402 | none                                                              |                  0 / 0 |

## Native versus MCP schema burden

These are complete compact JSON schema-array bytes on each actual provider request, including descriptions and parameters. They expose repeated schema size without claiming exact schema token charges. Original and sent counts refer to the captured Responses boundary; native/MCP bytes refer to the translated provider boundary.

| Mode          | Call | Original / sent definitions | Native schema count / bytes | MCP schema count / bytes |
| ------------- | ---: | --------------------------: | --------------------------: | -----------------------: |
| Direct        |    1 |                     25 / 25 |                 25 / 24,142 |                    0 / 2 |
| Direct        |    2 |                     25 / 25 |                 25 / 24,142 |                    0 / 2 |
| Direct        |    3 |                     25 / 25 |                 25 / 24,142 |                    0 / 2 |
| Direct        |    4 |                     25 / 25 |                 25 / 24,142 |                    0 / 2 |
| Direct        |    5 |                     25 / 25 |                 25 / 24,142 |                    0 / 2 |
| Direct        |    6 |                     25 / 25 |                 25 / 24,142 |                    0 / 2 |
| Direct        |    7 |                     25 / 25 |                 25 / 24,142 |                    0 / 2 |
| Direct        |    8 |                     25 / 25 |                 25 / 24,142 |                    0 / 2 |
| Omni required |    1 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Omni required |    2 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Omni required |    3 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Omni required |    4 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Omni required |    5 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Omni required |    6 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Omni required |    7 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Omni required |    8 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Omni required |    9 |                     29 / 29 |                 25 / 24,142 |                4 / 2,169 |
| Adaptive      |    1 |                      29 / 2 |                   2 / 2,040 |                    0 / 2 |
| Adaptive      |    2 |                      29 / 2 |                   2 / 2,040 |                    0 / 2 |
| Adaptive      |    3 |                      29 / 6 |                   2 / 2,040 |                4 / 1,839 |
| Adaptive      |    4 |                      29 / 6 |                   2 / 2,040 |                4 / 1,839 |
| Adaptive      |    5 |                      29 / 6 |                   2 / 2,040 |                4 / 1,839 |
| Adaptive      |    6 |                      29 / 2 |                   2 / 2,040 |                    0 / 2 |
| Adaptive      |    7 |                      29 / 6 |                   2 / 2,040 |                4 / 1,839 |

## History block categories

Categories measure compact JSON bytes of each actual history content block. Message wrapper bytes contain role/content framing and array/object separators. User text here includes every retained user message, not just the current question.

| Mode          | Call | Turn | User text | Assistant text | Tool calls | Tool results | Thinking / other | Message wrappers | History total |
| ------------- | ---: | ---: | --------: | -------------: | ---------: | -----------: | ---------------: | ---------------: | ------------: |
| Direct        |    1 |    1 |        43 |              0 |          0 |            0 |            0 / 0 |               30 |            73 |
| Direct        |    2 |    2 |        98 |            502 |          0 |            0 |            0 / 0 |               93 |           693 |
| Direct        |    3 |    3 |       147 |            706 |          0 |            0 |            0 / 0 |              156 |         1,009 |
| Direct        |    4 |    3 |       147 |            780 |        241 |          428 |            0 / 0 |              222 |         1,818 |
| Direct        |    5 |    3 |       147 |            964 |        482 |          856 |            0 / 0 |              288 |         2,737 |
| Direct        |    6 |    4 |       206 |          1,386 |        482 |          856 |            0 / 0 |              351 |         3,281 |
| Direct        |    7 |    5 |       268 |          1,572 |        482 |          856 |            0 / 0 |              414 |         3,592 |
| Direct        |    8 |    5 |       268 |          1,653 |        723 |        1,284 |            0 / 0 |              480 |         4,408 |
| Omni required |    1 |    1 |        43 |              0 |          0 |            0 |            0 / 0 |               30 |            73 |
| Omni required |    2 |    2 |        98 |            500 |          0 |            0 |            0 / 0 |               93 |           691 |
| Omni required |    3 |    3 |       147 |            724 |          0 |            0 |            0 / 0 |              156 |         1,027 |
| Omni required |    4 |    3 |       147 |            798 |        123 |          205 |            0 / 0 |              220 |         1,493 |
| Omni required |    5 |    3 |       147 |            798 |        266 |          428 |            0 / 0 |              283 |         1,922 |
| Omni required |    6 |    3 |       147 |          1,013 |        404 |          651 |            0 / 0 |              347 |         2,562 |
| Omni required |    7 |    4 |       206 |          1,410 |        404 |          651 |            0 / 0 |              410 |         3,081 |
| Omni required |    8 |    5 |       268 |          1,622 |        404 |          651 |            0 / 0 |              473 |         3,418 |
| Omni required |    9 |    5 |       268 |          1,743 |        549 |          874 |            0 / 0 |              537 |         3,971 |
| Adaptive      |    1 |    1 |        43 |              0 |          0 |            0 |            0 / 0 |               30 |            73 |
| Adaptive      |    2 |    2 |        98 |            751 |          0 |            0 |            0 / 0 |               93 |           942 |
| Adaptive      |    3 |    3 |       147 |            977 |          0 |            0 |            0 / 0 |              156 |         1,280 |
| Adaptive      |    4 |    3 |       147 |          1,064 |        127 |          495 |            0 / 0 |              220 |         2,053 |
| Adaptive      |    5 |    3 |       147 |          1,464 |        254 |          990 |            0 / 0 |              284 |         3,139 |
| Adaptive      |    6 |    4 |       206 |          1,817 |        254 |          990 |            0 / 0 |              347 |         3,614 |
| Adaptive      |    7 |    5 |       268 |          2,050 |        254 |          990 |            0 / 0 |              410 |         3,972 |

## Execution, projection and permission evidence

| Mode          | Turn | Completed tool calls                                                                                                                                     | Gateway source / returned bytes | Projection fidelity | Approval events |
| ------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------- | --------------: |
| Direct        |    1 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Direct        |    2 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Direct        |    3 | qlik/list_mcp_resource_templates (failed), qlik/list_mcp_resources (failed), qlik/list_mcp_resource_templates (failed), qlik/list_mcp_resources (failed) | no gateway projection event     | not applicable      |               0 |
| Direct        |    4 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Direct        |    5 | qlik/list_mcp_resources (failed), qlik/list_mcp_resource_templates (failed)                                                                              | no gateway projection event     | not applicable      |               0 |
| Omni required |    1 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Omni required |    2 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Omni required |    3 | omni/discover_server (completed), omni/discover_tools (failed), omni/discover_tools (failed)                                                             | no gateway projection event     | not applicable      |               0 |
| Omni required |    4 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Omni required |    5 | omni/discover_tools (failed)                                                                                                                             | no gateway projection event     | not applicable      |               0 |
| Adaptive      |    1 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Adaptive      |    2 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Adaptive      |    3 | adaptive/discover_server (completed), adaptive/discover_server (completed)                                                                               | no gateway projection event     | not applicable      |               2 |
| Adaptive      |    4 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |
| Adaptive      |    5 | none                                                                                                                                                     | no gateway projection event     | not applicable      |               0 |

## Answer quality and retrieval coverage

A completed assistant turn can still fail the requested business task. An MCP timeout is different from a provider HTTP failure: the error may enter a successful, billed model continuation. The table reports what was actually retrieved, rather than treating unavailable data as an empty result.

| Mode          | Turn | Elapsed seconds | Successful Qlik data / evidence | Failed operations                                                                                | Task limits                             |
| ------------- | ---: | --------------: | ------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Direct        |    1 |             5.1 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Direct        |    2 |             2.4 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Direct        |    3 |             9.7 | none                            | list_mcp_resource_templates, list_mcp_resources, list_mcp_resource_templates, list_mcp_resources | No app list retrieved                   |
| Direct        |    4 |             2.2 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Direct        |    5 |             5.8 | none                            | list_mcp_resources, list_mcp_resource_templates                                                  | App explanation unavailable             |
| Omni required |    1 |             4.2 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Omni required |    2 |             3.4 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Omni required |    3 |            72.4 | none                            | discover_tools, discover_tools                                                                   | No app list retrieved                   |
| Omni required |    4 |             3.6 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Omni required |    5 |            37.3 | none                            | discover_tools                                                                                   | App explanation unavailable             |
| Adaptive      |    1 |             4.8 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Adaptive      |    2 |             3.2 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Adaptive      |    3 |            69.2 | none                            | none                                                                                             | No app list retrieved                   |
| Adaptive      |    4 |             2.4 | none                            | none                                                                                             | General answer; no Qlik lookup required |
| Adaptive      |    5 |            64.0 | none                            | none                                                                                             | App explanation unavailable             |

Adaptive registry initialization reported "The operation was aborted due to timeout" before turn 1; its registry event reports 0 tools after 60.1 seconds. Its Qlik turns therefore exercised unavailable-catalog discovery fallback. This run does not measure the healthy catalog's app-specific direct routing or projection. [Full startup evidence](turns/adaptive-bootstrap.json).

Direct's first request carries **24,142 native schema bytes** and **2 Qlik schema bytes**; native definitions comprise **100.0%** of the sum of those separate compact arrays. The **12,624-byte system text** is repeated on model requests. Native schema selection therefore addresses a larger observed schema component than Qlik catalog pruning alone; system instructions remain a material fixed input cost. These byte shares are not token shares.

Direct turn 4 sends **3,281 history JSON bytes** after the app-listing attempt, although its new user question is only 34 bytes. Retained answers and connector errors continue consuming input on subsequent unrelated questions in this run.

Before evaluating end-to-end savings, repeat under healthy connector initialization with comparable Qlik evidence. Separately, preflight analysis identified that an app explanation needs an appropriate app-detail/script/lineage/sheet tool set, rather than a listing-only route; the unavailable adaptive catalog in this run does not test that healthy-route limitation. Review authorization and projection for the broader intent before expanding exposure. [Read-only connector health evidence](catalog-health.json) · [Validation evidence](validation.json).

## What the logs establish

- Direct mode carries the native and attached connector schemas on ordinary questions; adaptive selection keeps only relevant definitions plus mandatory runtime controls. Exact counts appear above.
- Omni discovery adds model round trips when schemas must be discovered. Count every discovery, invocation and answer request, rather than comparing only the greeting.
- Turn 4 follows the Qlik listing attempt. Its request retains the earlier answer and any returned results or errors. In a successful listing mode, the business data continues to consume input on the unrelated capital question.
- Turn 5 is an app explanation rather than another listing. Inspect the actual tools and raw data before treating any token reduction as an equivalent explanation. The current adaptive router's selected set is recorded verbatim; this report does not invent missing app-script or app-detail evidence.
- Projection fidelity checks compare every selected parsed JSON value with the actual source. Full-result selections can correctly preserve values while saving no bytes.
- Approvals include the harness's existing authorization for read-only Qlik operations and any captured turn-5 plan confirmation. No permission answer is silently omitted from the turn bundles.
- Routing traces with `authorizationRemoved: [REDACTED]` do not reveal the number of rejected tools; the redactor masks that metadata key. Its value is not assumed to be an empty list.

## Timing and routing

HTTP response headers are recorded separately from the first provider body byte, text delta and tool block. A tool-only call may emit no text token. Single sequential runs do not establish a stable latency improvement.

| Turn                      | Direct elapsed seconds | Omni required elapsed seconds | Adaptive elapsed seconds |
| ------------------------- | ---------------------: | ----------------------------: | -----------------------: |
| 1                         |                    5.1 |                           4.2 |                      4.8 |
| 2                         |                    2.4 |                           3.4 |                      3.2 |
| 3                         |                    9.7 |                          72.4 |                     69.2 |
| 4                         |                    2.2 |                           3.6 |                      2.4 |
| 5                         |                    5.8 |                          37.3 |                     64.0 |
| **Five-turn elapsed sum** |                   25.2 |                         121.0 |                    143.6 |

The elapsed sum excludes startup. Startup spans include database reads, relay/runtime setup and connector hydration; it is separate from model first-token latency.

| Mode          | Harness creation to first user turn seconds | Registry hydration seconds | Registry tools | Hydration status                         |
| ------------- | ------------------------------------------: | -------------------------: | -------------: | ---------------------------------------- |
| Direct        |                                        39.2 |               not recorded |   not recorded | no registry event                        |
| Omni required |                                         4.0 |               not recorded |   not recorded | no registry event                        |
| Adaptive      |                                        65.1 |                       60.1 |              0 | The operation was aborted due to timeout |

| Mode          | Call | Turn | First body byte ms | First text delta ms | First tool block ms | Full stream ms |
| ------------- | ---: | ---: | -----------------: | ------------------: | ------------------: | -------------: |
| Direct        |    1 |    1 |               3196 |                3198 |         not emitted |           4745 |
| Direct        |    2 |    2 |               1598 |                1598 |         not emitted |           2313 |
| Direct        |    3 |    3 |               1974 |                1974 |                2906 |           2910 |
| Direct        |    4 |    3 |               2078 |                2078 |                3474 |           3476 |
| Direct        |    5 |    3 |               1548 |                1549 |         not emitted |           3051 |
| Direct        |    6 |    4 |               1514 |                1514 |         not emitted |           2117 |
| Direct        |    7 |    5 |               1684 |                1685 |                2458 |           2463 |
| Direct        |    8 |    5 |               1494 |                1495 |         not emitted |           3111 |
| Omni required |    1 |    1 |               2610 |                2611 |         not emitted |           4049 |
| Omni required |    2 |    2 |               2509 |                2510 |         not emitted |           3204 |
| Omni required |    3 |    3 |               1931 |                1932 |                2343 |           2348 |
| Omni required |    4 |    3 |               2013 |         not emitted |                2318 |           2320 |
| Omni required |    5 |    3 |               2295 |                2295 |                3574 |           3577 |
| Omni required |    6 |    3 |               2405 |                2405 |         not emitted |           3789 |
| Omni required |    7 |    4 |               2955 |                2955 |         not emitted |           3545 |
| Omni required |    8 |    5 |               1690 |                1690 |                2536 |           2538 |
| Omni required |    9 |    5 |               2802 |                2802 |         not emitted |           4603 |
| Adaptive      |    1 |    1 |               2233 |                2233 |         not emitted |           4665 |
| Adaptive      |    2 |    2 |               2613 |                2613 |         not emitted |           3080 |
| Adaptive      |    3 |    3 |               2317 |                2317 |                2958 |           2961 |
| Adaptive      |    4 |    3 |               1456 |                1457 |                3117 |           3120 |
| Adaptive      |    5 |    3 |               1456 |                1457 |         not emitted |           2607 |
| Adaptive      |    6 |    4 |               1787 |                1787 |         not emitted |           2290 |
| Adaptive      |    7 |    5 |               2306 |                2306 |         not emitted |           3746 |

## Full messages, assistant outputs and tool arguments

Assistant text is reproduced verbatim without truncation. A turn's JSON bundle contains all original and transformed model inputs, provider SSE outputs, reconstructed assistant content, runtime events, approvals and complete tool results. Runtime placeholder text, if present, is retained rather than silently removed.

### Turn 1: hi this is ashok ?

**Direct** — status completed; 7,953 / 111 / 1. [Complete turn JSON](turns/direct-turn-1.json).

<details>
<summary>Full Direct assistant output and tool arguments</summary>

```text
Hi Ashok, good to meet you.

I'm your Truex assistant. I can help with things like:

- Answering questions and summarizing documents you share with me
- Pulling and explaining business data through connected sources (I currently have a Qlik connector available)
- Researching current information from the web
- Creating downloadable documents (Word, Excel, PowerPoint, PDF)
- Building interactive charts or visualizations when helpful

What would you like to work on?
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

**Omni required** — status completed; 8,581 / 112 / 1. [Complete turn JSON](turns/omni-turn-1.json).

<details>
<summary>Full Omni required assistant output and tool arguments</summary>

```text
Hi Ashok, nice to meet you.

I'm your Truex assistant. I can help with things like:

- Answering questions and summarizing documents you share with me
- Pulling and analyzing data from connected business systems (I currently have a Qlik connector available)
- Researching current information from the web
- Creating downloadable documents (Word, Excel, PowerPoint, PDF)
- Building interactive visuals or charts for things we discuss

What would you like to work on?
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

**Adaptive** — status completed; 3,068 / 179 / 1. [Complete turn JSON](turns/adaptive-turn-1.json).

<details>
<summary>Full Adaptive assistant output and tool arguments</summary>

```text
Hi Ashok, good to meet you.

I'm your Truex assistant. Here's what I can help you with:

- Answering questions and summarizing documents you share with me
- Looking up current information from the web when needed
- Pulling insights from connected business data sources (I have access to Qlik for your organization's analytics)
- Creating downloadable documents (PDF, Word, Excel, PowerPoint)
- Building interactive visualizations and charts
- Working through multi-step projects with a clear plan you approve first

What would you like to work on today?

[truex-suggestions]
- What data can you pull from Qlik?
- Can you create a report for me?
- What kinds of documents can you generate?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

### Turn 2: What is the capital of India ?

**Direct** — status completed; 8,067 / 47 / 1. [Complete turn JSON](turns/direct-turn-2.json).

<details>
<summary>Full Direct assistant output and tool arguments</summary>

```text
The capital of India is New Delhi.

[truex-suggestions]
- What is the population of New Delhi?
- Can you tell me more about India's government structure?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

**Omni required** — status completed; 8,696 / 56 / 1. [Complete turn JSON](turns/omni-turn-2.json).

<details>
<summary>Full Omni required assistant output and tool arguments</summary>

```text
The capital of India is New Delhi.

[truex-suggestions]
- What's the population of New Delhi?
- Can you show data from our Qlik connector?
- What else can you help me with?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

**Adaptive** — status completed; 3,241 / 56 / 1. [Complete turn JSON](turns/adaptive-turn-2.json).

<details>
<summary>Full Adaptive assistant output and tool arguments</summary>

```text
The capital of India is New Delhi.

[truex-suggestions]
- What is the population of New Delhi?
- What are other major cities in India?
- Can you show India's states on a map?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

### Turn 3: what are the Qlik apps ?

**Direct** — status completed; 24,965 / 148 / 3. [Complete turn JSON](turns/direct-turn-3.json).

<details>
<summary>Full Direct assistant output and tool arguments</summary>

```text
I'll check the Qlik connector for available apps.
The Qlik connector is configured for this agent, but I wasn't able to connect to it just now — the connection attempt timed out during startup. Let me retry.
The Qlik connector is configured for this session, but it's currently unavailable — both attempts to connect timed out during the handshake, so I can't retrieve the list of Qlik apps right now. This isn't something I can work around by searching elsewhere, since that data only exists in Qlik.

You could try again in a bit, or let me know if you'd like me to attempt the connection once more.
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[
  {
    "id": "toolu_bdrk_017b3Nekn3wLASH7JD4Yv949",
    "server": "qlik",
    "tool": "list_mcp_resource_templates",
    "arguments": {
      "server": "qlik"
    },
    "status": "failed",
    "durationMs": 0,
    "error": {
      "message": "resources/templates/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    }
  },
  {
    "id": "toolu_bdrk_01NinHjkPKTXEGEA9WKKh6iY",
    "server": "qlik",
    "tool": "list_mcp_resources",
    "arguments": {
      "server": "qlik"
    },
    "status": "failed",
    "durationMs": 0,
    "error": {
      "message": "resources/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    }
  },
  {
    "id": "toolu_bdrk_01JR6xCfAvPYGaq8KXnbvBC8",
    "server": "qlik",
    "tool": "list_mcp_resource_templates",
    "arguments": {
      "server": "qlik"
    },
    "status": "failed",
    "durationMs": 0,
    "error": {
      "message": "resources/templates/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    }
  },
  {
    "id": "toolu_bdrk_01CqtfKarGUh2ZfUVrzDRssj",
    "server": "qlik",
    "tool": "list_mcp_resources",
    "arguments": {
      "server": "qlik"
    },
    "status": "failed",
    "durationMs": 0,
    "error": {
      "message": "resources/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    }
  }
]
```

</details>

**Omni required** — status completed; 35,763 / 157 / 4. [Complete turn JSON](turns/omni-turn-3.json).

<details>
<summary>Full Omni required assistant output and tool arguments</summary>

```text
I'll check the Qlik connector for available apps.
The Qlik connector is configured, but the tool discovery call timed out, so I wasn't able to retrieve the list of Qlik apps just now. Let me try once more before concluding it's unavailable.
The Qlik connector is configured, but its tools are currently unavailable, both discovery attempts timed out. I don't have evidence of a list of Qlik apps to share right now.

Want me to try again, or is there something else I can help with in the meantime?

[truex-suggestions]
- Try the Qlik connector again?
- What else can you help me with?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[
  {
    "id": "toolu_bdrk_01CMrW79vy5Zcx2p6sPTBrpo",
    "server": "omni",
    "tool": "discover_server",
    "arguments": {
      "query": "qlik"
    },
    "status": "completed",
    "durationMs": 5,
    "error": null
  },
  {
    "id": "toolu_bdrk_01FQPh5h5JrNgQRpywRGHFkB",
    "server": "omni",
    "tool": "discover_tools",
    "arguments": {
      "server": "qlik",
      "query": "list apps"
    },
    "status": "failed",
    "durationMs": 30011,
    "error": null
  },
  {
    "id": "toolu_bdrk_01XaRo9zAfgsJeDeZQZWXpoM",
    "server": "omni",
    "tool": "discover_tools",
    "arguments": {
      "server": "qlik",
      "query": "apps"
    },
    "status": "failed",
    "durationMs": 30005,
    "error": null
  }
]
```

</details>

**Adaptive** — status completed; 11,756 / 189 / 3. [Complete turn JSON](turns/adaptive-turn-3.json).

<details>
<summary>Full Adaptive assistant output and tool arguments</summary>

```text
I'll check what's available through the connected Qlik server.
The Qlik server is configured for this agent, but it's currently unavailable, it timed out while trying to connect. I can't list or query Qlik apps right now.

I'm not able to fall back to any other source for this since it's business data that should come specifically from Qlik. Want me to try connecting again, or is there something else I can help with in the meantime?
Still no luck, the Qlik server is timing out on connection again. It's configured for this agent but currently unavailable, so I can't retrieve the list of Qlik apps right now.

This looks like a temporary connectivity issue on the server side. Would you like to try again in a bit, or is there something else I can help with?
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[
  {
    "id": "toolu_bdrk_016Q9BwpRWoPfHfHb38SifTw",
    "server": "adaptive",
    "tool": "discover_server",
    "arguments": {
      "query": "qlik"
    },
    "status": "completed",
    "durationMs": 5,
    "error": null
  },
  {
    "id": "toolu_bdrk_01GhKtuU3gEsQQJWVw8MegkW",
    "server": "adaptive",
    "tool": "discover_server",
    "arguments": {
      "query": "qlik"
    },
    "status": "completed",
    "durationMs": 3,
    "error": null
  }
]
```

</details>

### Turn 4: What is the capital of tamilnadu ?

**Direct** — status completed; 8,630 / 43 / 1. [Complete turn JSON](turns/direct-turn-4.json).

<details>
<summary>Full Direct assistant output and tool arguments</summary>

```text
The capital of Tamil Nadu is Chennai.

[truex-suggestions]
- What is the population of Chennai?
- Can you try connecting to Qlik again?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

**Omni required** — status completed; 9,243 / 51 / 1. [Complete turn JSON](turns/omni-turn-4.json).

<details>
<summary>Full Omni required assistant output and tool arguments</summary>

```text
The capital of Tamil Nadu is Chennai.

[truex-suggestions]
- What is the capital of Karnataka?
- Try the Qlik connector again?
- What else can you help me with?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

**Adaptive** — status completed; 3,798 / 55 / 1. [Complete turn JSON](turns/adaptive-turn-4.json).

<details>
<summary>Full Adaptive assistant output and tool arguments</summary>

```text
The capital of Tamil Nadu is Chennai.

[truex-suggestions]
- What is the population of Chennai?
- What are other major cities in Tamil Nadu?
- Can you try the Qlik connection again?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

### Turn 5: Explain this qlik app T_DCF_BANKREC_P

**Direct** — status completed; 17,580 / 127 / 2. [Complete turn JSON](turns/direct-turn-5.json).

<details>
<summary>Full Direct assistant output and tool arguments</summary>

```text
Let me try the Qlik connector again to look up that app.
The Qlik connector is still timing out on the handshake, so I can't retrieve details on **T_DCF_BANKREC_P** right now. I don't have information about this app from any other source, and I can't substitute a web search or guess at its contents since it's private Qlik data.

This looks like a persistent connection issue rather than something a retry will fix. Would you like me to try once more, or would you prefer to check back later?
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[
  {
    "id": "toolu_bdrk_01J1HH8UHCiQWfZzJkMLgRBQ",
    "server": "qlik",
    "tool": "list_mcp_resources",
    "arguments": {
      "server": "qlik"
    },
    "status": "failed",
    "durationMs": 0,
    "error": {
      "message": "resources/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    }
  },
  {
    "id": "toolu_bdrk_01FPUNd66MZ5cJSqGV4RRXnU",
    "server": "qlik",
    "tool": "list_mcp_resource_templates",
    "arguments": {
      "server": "qlik"
    },
    "status": "failed",
    "durationMs": 0,
    "error": {
      "message": "resources/templates/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    }
  }
]
```

</details>

**Omni required** — status completed; 18,749 / 178 / 2. [Complete turn JSON](turns/omni-turn-5.json).

<details>
<summary>Full Omni required assistant output and tool arguments</summary>

```text
I need to check the Qlik connector for details on that specific app. Let me try discovery again.
I tried again, but the Qlik connector's tools are still timing out on discovery. The connector is configured, but I can't currently reach its tools to look up "T_DCF_BANKREC_P" or any app details.

I don't have any other source for this information — I can't guess at what this app contains without pulling it from Qlik. Want me to try once more, or would you like to share any details about it yourself (e.g., from a document) that I could summarize?

[truex-suggestions]
- Try the Qlik connector again?
- What else can you help me with?
[/truex-suggestions]
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[
  {
    "id": "toolu_bdrk_011jxtF32t6B439JGNjSBtMV",
    "server": "omni",
    "tool": "discover_tools",
    "arguments": {
      "server": "qlik",
      "query": "app details"
    },
    "status": "failed",
    "durationMs": 30006,
    "error": null
  }
]
```

</details>

**Adaptive** — status completed; 4,291 / 108 / 1. [Complete turn JSON](turns/adaptive-turn-5.json).

<details>
<summary>Full Adaptive assistant output and tool arguments</summary>

```text
I don't have access to that information right now. The Qlik server is configured for this agent, but its tools have been unavailable (connection timeouts) each time I've tried, so I can't look up details on the app "T_DCF_BANKREC_P" such as its data model, sheets, or purpose.

I can't guess at what this app contains since it would be inventing business data. Want me to try the Qlik connection again?
```

Tool arguments and execution status (full results are in the turn JSON):

```json
[]
```

</details>

## Raw payloads at every boundary

| Mode          | Full capture                           | Into Codex JSON-RPC                          | Original Codex Responses requests                   | Actual Responses requests sent                             | Anthropic provider requests                        | Bootstrap                             |
| ------------- | -------------------------------------- | -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| Direct        | [JSON](direct/direct-capture.json)     | [JSONL](direct/direct-codex-input.jsonl)     | [JSONL](direct/direct-responses-requests.jsonl)     | [JSONL](direct/direct-actual-responses-requests.jsonl)     | [JSONL](direct/direct-provider-requests.jsonl)     | [JSON](turns/direct-bootstrap.json)   |
| Omni required | [JSON](omni/omni-capture.json)         | [JSONL](omni/omni-codex-input.jsonl)         | [JSONL](omni/omni-responses-requests.jsonl)         | [JSONL](omni/omni-actual-responses-requests.jsonl)         | [JSONL](omni/omni-provider-requests.jsonl)         | [JSON](turns/omni-bootstrap.json)     |
| Adaptive      | [JSON](adaptive/adaptive-capture.json) | [JSONL](adaptive/adaptive-codex-input.jsonl) | [JSONL](adaptive/adaptive-responses-requests.jsonl) | [JSONL](adaptive/adaptive-actual-responses-requests.jsonl) | [JSONL](adaptive/adaptive-provider-requests.jsonl) | [JSON](turns/adaptive-bootstrap.json) |

The new-message `turn/start` payload into Codex and the full-history request generated by Codex are different boundaries. Adaptive model filtering happens between that raw request and the actual model gateway request. Both are captured; provider translation is a third captured boundary. Credentials and connector HTTP headers are redacted in the source captures. Diagnostic copies of full source results are not secretly appended to projected model history.

[Machine-readable comparison and verification](comparison.json) · [All request-level categories](call-ledger.json).

## Run conditions and reproducibility

This offline reporter reads only the sanitized capture files and performs no model, MCP or database call. The live harness used the supplied model/MCP profiles, explicit scenario attachment and temporary runtime storage, without database writes or changes to Codex. Implementation/version context belongs to the captured configuration, routing traces and companion validation; the reporter changes no runtime behavior.

```sh
platform/node_modules/.bin/tsx platform/scripts/report-five-message-mcp-v2.ts
# Use --dir PATH for another capture directory; --allow-incomplete creates a labeled progress report.
```

Actual run conditions, request failures, raw usage fields and per-turn runtime reconciliation are retained in comparison.json and the source captures. This report does not replace absent upstream cache/reasoning counters with runtime zeros, claim zero-cost failed attempts, or independently certify output billing.
