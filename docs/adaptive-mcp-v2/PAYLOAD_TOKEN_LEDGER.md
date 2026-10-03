# Complete payload and token ledger

Each row is one real provider request. Input/output tokens are the original provider-reported usage counters. Component sizes are UTF-8 bytes of canonical compact JSON from the captured provider body; they are **not exact component token counts**. The provider does not report a system/schema/history token breakdown.

| Mode          | Call | Turn | Input tokens | Output tokens | Native schemas | MCP schemas | Schema bytes | System bytes | History bytes |
| ------------- | ---: | ---: | -----------: | ------------: | -------------: | ----------: | -----------: | -----------: | ------------: |
| direct        |    1 |    1 |         9694 |           226 |             25 |          14 |        31335 |        12826 |            63 |
| direct        |    2 |    2 |         9912 |             0 |             25 |          14 |        31335 |        12826 |          1105 |
| direct        |    3 |    2 |        14196 |           546 |             25 |          14 |        31335 |        12826 |         15144 |
| direct        |    4 |    3 |        14688 |            11 |             25 |          14 |        31335 |        12826 |         17064 |
| omni-optional |    1 |    1 |         8467 |           166 |             25 |           4 |        25946 |        13400 |            63 |
| omni-optional |    2 |    2 |         8633 |             0 |             25 |           4 |        25946 |        13400 |           885 |
| omni-optional |    3 |    2 |         8732 |             0 |             25 |           4 |        25946 |        13400 |          1276 |
| omni-optional |    4 |    2 |         9047 |             0 |             25 |           4 |        25946 |        13400 |          2781 |
| omni-optional |    5 |    2 |         9299 |             0 |             25 |           4 |        25946 |        13400 |          3977 |
| omni-optional |    6 |    2 |        13562 |           503 |             25 |           4 |        25946 |        13400 |         18044 |
| omni-optional |    7 |    3 |        14017 |            55 |             25 |           4 |        25946 |        13400 |         19748 |
| omni-required |    1 |    1 |         8578 |            74 |             25 |           4 |        26310 |        13594 |            63 |
| omni-required |    2 |    2 |         8664 |             0 |             25 |           4 |        26310 |        13594 |           501 |
| omni-required |    3 |    2 |         8773 |             0 |             25 |           4 |        26310 |        13594 |           892 |
| omni-required |    4 |    2 |         9092 |             0 |             25 |           4 |        26310 |        13594 |          2397 |
| omni-required |    5 |    2 |         9409 |             0 |             25 |           4 |        26310 |        13594 |          3928 |
| omni-required |    6 |    2 |        11747 |           438 |             25 |           4 |        26310 |        13594 |         11773 |
| omni-required |    7 |    3 |        12145 |             9 |             25 |           4 |        26310 |        13594 |         13434 |
| adaptive      |    1 |    1 |         3065 |           125 |              2 |           0 |         2040 |        12826 |            63 |
| adaptive      |    2 |    2 |         3392 |             0 |              2 |           1 |         2792 |        12826 |           745 |
| adaptive      |    3 |    2 |         5756 |           484 |              2 |           1 |         2792 |        12826 |          8623 |
| adaptive      |    4 |    3 |         5997 |            59 |              2 |           0 |         2040 |        12826 |         10413 |

## What reaches the model

| Layer                                           | Sent as model context?    | How it contributes                                                                                 |
| ----------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| Agent database IDs, tint, look, timestamps      | No                        | Platform configuration; absent from provider messages.                                             |
| Agent systemPrompt                              | Yes                       | Included in the larger system instruction text.                                                    |
| Business/runtime/permission instructions        | Yes                       | Repeated with each provider request. These remain unchanged in V2.                                 |
| Current user message                            | Yes                       | Included with accumulated history.                                                                 |
| Previous user/assistant messages                | Yes                       | Replayed in later calls, including follow-ups.                                                     |
| Native tool schemas                             | Yes, selected             | Direct/Omni send 25; final Adaptive sends two controls for this scenario.                          |
| MCP business schemas                            | Yes, selected             | Direct sends all 14; Adaptive sends one for the Qlik turn and none for greetings/India.            |
| Omni discovery schemas/results                  | Fallback only in Adaptive | Existing Omni adds three discovery rounds to this conversation.                                    |
| Upstream tool arguments                         | Yes                       | Generated tool calls become part of history.                                                       |
| Tool results                                    | Yes                       | Projection occurs before this history insertion, so subsequent requests replay the smaller result. |
| Registry/catalog/index outside selected schemas | No                        | Remains in the platform/gateway.                                                                   |
| Credentials and HTTP authentication headers     | No                        | Gateway/transport configuration; redacted captures. Never model content.                           |

## Reading the costs

A tool is not charged once merely because it exists. Every request resends its exposed schema plus accumulated conversation. Direct repeats 39 schemas over four calls; Omni repeats 29 over seven calls. Adaptive sends 2,3,3,2 schemas over four calls.

The final India request still consumes 5,997 reported input tokens despite exposing no Qlik schema, because the same thread retains prior user messages, assistant answers and projected Qlik results. Removing irrelevant schemas does not remove existing history. The first Adaptive greeting consumes 3,065 input tokens; fixed instructions and controls are a substantial remaining baseline.

Provider tool-only requests report zero output tokens even though tool arguments exist. These zeros are preserved as reported usage, with an explicit observability anomaly. They do not prove free tool generation or independently verified billing. Missing cache/reasoning counters remain unknown. No model-specific pricing was assumed.

[Machine-readable component ledger](payload-ledger.json) includes separate user text, assistant text, tool-call, tool-result, other-block and envelope byte measurements for every call. [Full comparison and raw payload links](comparison.md) provide complete message content and timing.
