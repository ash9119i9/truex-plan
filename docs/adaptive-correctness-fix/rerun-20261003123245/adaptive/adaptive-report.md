# Live adaptive MCP V2 benchmark

Captured 2026-10-03T12:38:41.598Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | hi this is ashok ? | 1 | 3068 | 179 | 4839 | completed |
| 2 | What is the capital of India ? | 1 | 3241 | 56 | 3235 | completed |
| 3 | what are the Qlik apps ? | 3 | 11756 | 189 | 69183 | completed |
| 4 | What is the capital of tamilnadu ? | 1 | 3798 | 55 | 2428 | completed |
| 5 | Explain this qlik app T_DCF_BANKREC_P | 1 | 4291 | 108 | 63953 | completed |
| **Total known usage** | | **7** | **26154** | **587** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 2 | 3068 | 179 | 4665 |
| 2 | 2 | 2 | 3241 | 56 | 3080 |
| 3 | 3 | 6 | 3730 | 14 | 2961 |
| 4 | 3 | 6 | 3895 | 94 | 3120 |
| 5 | 3 | 6 | 4131 | 81 | 2607 |
| 6 | 4 | 2 | 3798 | 55 | 2290 |
| 7 | 5 | 6 | 4291 | 108 | 3746 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: hi this is ashok ?

Status: completed. Thread: `01a101c7-14f2-78e2-b212-9e838539e001`.

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

Tool exchanges:

```json
[]
```

### Turn 2: What is the capital of India ?

Status: completed. Thread: `01a101c7-14f2-78e2-b212-9e838539e001`.

The capital of India is New Delhi.

[truex-suggestions]
- What is the population of New Delhi?
- What are other major cities in India?
- Can you show India's states on a map?
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 3: what are the Qlik apps ?

Status: completed. Thread: `01a101c7-14f2-78e2-b212-9e838539e001`.

I'll check what's available through the connected Qlik server.
The Qlik server is configured for this agent, but it's currently unavailable, it timed out while trying to connect. I can't list or query Qlik apps right now.

I'm not able to fall back to any other source for this since it's business data that should come specifically from Qlik. Want me to try connecting again, or is there something else I can help with in the meantime?
Still no luck, the Qlik server is timing out on connection again. It's configured for this agent but currently unavailable, so I can't retrieve the list of Qlik apps right now.

This looks like a temporary connectivity issue on the server side. Would you like to try again in a bit, or is there something else I can help with?

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_016Q9BwpRWoPfHfHb38SifTw",
    "server": "adaptive",
    "tool": "discover_server",
    "status": "completed",
    "arguments": {
      "query": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"servers\":[],\"unavailableServers\":[{\"name\":\"qlik\",\"state\":\"unavailable\",\"error\":{\"message\":\"The operation was aborted due to timeout\",\"kind\":\"timeout\",\"stage\":\"initialize\",\"retryable\":true},\"retryable\":true}],\"registryState\":\"failed\"}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 5
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01GhKtuU3gEsQQJWVw8MegkW",
    "server": "adaptive",
    "tool": "discover_server",
    "status": "completed",
    "arguments": {
      "query": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"servers\":[],\"unavailableServers\":[{\"name\":\"qlik\",\"state\":\"unavailable\",\"error\":{\"message\":\"The operation was aborted due to timeout\",\"kind\":\"timeout\",\"stage\":\"initialize\",\"retryable\":true},\"retryable\":true}],\"registryState\":\"failed\"}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 3
  }
]
```

### Turn 4: What is the capital of tamilnadu ?

Status: completed. Thread: `01a101c7-14f2-78e2-b212-9e838539e001`.

The capital of Tamil Nadu is Chennai.

[truex-suggestions]
- What is the population of Chennai?
- What are other major cities in Tamil Nadu?
- Can you try the Qlik connection again?
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 5: Explain this qlik app T_DCF_BANKREC_P

Status: completed. Thread: `01a101c7-14f2-78e2-b212-9e838539e001`.

I don't have access to that information right now. The Qlik server is configured for this agent, but its tools have been unavailable (connection timeouts) each time I've tried, so I can't look up details on the app "T_DCF_BANKREC_P" such as its data model, sheets, or purpose.

I can't guess at what this app contains since it would be inventing business data. Want me to try the Qlik connection again?

Tool exchanges:

```json
[]
```

## Payload and observability files

- [All redacted wire requests, provider SSE events, runtime events, traces and gateway events](adaptive-capture.json)
- [Exact JSON-RPC messages written to Codex stdin](adaptive-codex-input.jsonl)
- [Exact Responses bodies generated by Codex](adaptive-responses-requests.jsonl)
- [Exact Anthropic request bodies sent upstream](adaptive-provider-requests.jsonl)

The Codex `turn/start` RPC contains the new message; Codex maintains thread history and expands it into model requests. Payloads retain full instructions, schemas, history and tool results. Credentials and connector HTTP headers are redacted. Runtime MCP events show real tool results; gateway events quantify projection. No estimated component breakdown is substituted for measured billing.

## Run conditions and limits

The configuration builder loads model and MCP profiles read-only from MongoDB and uses the supplied scenario agent. Explicit connector documents are normalized into that scenario without writes to tenant configuration. Native tools remain unchanged. MCP startup is awaited before the greeting. The harness approves only the requested Qlik listing and read-only operations for the named-app explanation, plus discovery and a turn-5 plan confirmation. Approval answers are captured. It refuses writes and unrelated approval prompts. Calls capped at 48, timeout 600000 ms per turn. Sequential real-world A/B trials are sensitive to model variability and live source changes; one run is directional evidence, not a statistical performance guarantee.

## Actual model-boundary selection and first-token timing

Arm: **adaptive**. Effective projection: **platform default for get_apps**.

| Call | Turn | Codex schemas before filter | Schemas sent | Schema JSON bytes before | Schema JSON bytes after | First provider body byte ms | First text delta ms | First tool block ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 29 | 2 | 26962 | 2102 | 2233 | 2233 | no tool |
| 2 | 2 | 29 | 2 | 26962 | 2102 | 2613 | 2613 | no tool |
| 3 | 3 | 29 | 6 | 26962 | 4112 | 2317 | 2317 | 2958 |
| 4 | 3 | 29 | 6 | 26962 | 4112 | 1456 | 1457 | 3117 |
| 5 | 3 | 29 | 6 | 26962 | 4112 | 1456 | 1457 | no tool |
| 6 | 4 | 29 | 2 | 26962 | 2102 | 1787 | 1787 | no tool |
| 7 | 5 | 29 | 6 | 26962 | 4112 | 2306 | 2306 | no tool |

All timing is measured from provider-request start. HTTP headers alone are not treated as a text token. Schema byte sizes are serialized captured JSON, not component token counts. The complete [actual Responses requests sent to the model gateway](adaptive-actual-responses-requests.jsonl) are captured separately from the original Codex requests.

Routing is performed once before each user turn, not after every tool call. The selected plan is reused for the remaining calls of that turn. The model sees filtered schemas while Codex retains a static dispatch catalog. Adaptive gateway events, registry metadata, routing plans, selection traces and full/projected results are saved in the full capture. No registry or routing trace is silently inserted into model context.

```json
[
  {
    "at": "2026-10-03T12:39:46.734Z",
    "turn": 1,
    "permissionRejectedToolIds": [],
    "registryStatus": {
      "state": "failed",
      "configuredServerCount": 1,
      "enabledServerCount": 1,
      "upstreamToolCount": 0,
      "registryVersion": 0,
      "servers": [
        {
          "server": "qlik",
          "state": "unavailable",
          "upstreamToolCount": 0,
          "attempts": 2,
          "updatedAt": "2026-10-03T12:39:46.116Z",
          "lastError": {
            "message": "The operation was aborted due to timeout",
            "kind": "timeout",
            "stage": "initialize",
            "retryable": true
          }
        }
      ]
    },
    "query": "hi this is ashok ?",
    "confidence": 0,
    "candidates": [],
    "mode": "no_tools",
    "selected": [],
    "exposedBindings": [],
    "thresholds": {
      "highConfidenceThreshold": 0.85,
      "ambiguityMargin": 0.025
    },
    "retrievalIndex": {
      "startedAt": "2026-10-03T12:39:46.733Z",
      "completedAt": "2026-10-03T12:39:46.733Z",
      "durationMs": 0.2151249999878928,
      "toolCount": 0,
      "queryCount": 1,
      "cacheHits": 0,
      "cacheMisses": 0
    },
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.24316699999326374
  },
  {
    "at": "2026-10-03T12:39:51.588Z",
    "turn": 2,
    "permissionRejectedToolIds": [],
    "registryStatus": {
      "state": "failed",
      "configuredServerCount": 1,
      "enabledServerCount": 1,
      "upstreamToolCount": 0,
      "registryVersion": 0,
      "servers": [
        {
          "server": "qlik",
          "state": "unavailable",
          "upstreamToolCount": 0,
          "attempts": 2,
          "updatedAt": "2026-10-03T12:39:46.116Z",
          "lastError": {
            "message": "The operation was aborted due to timeout",
            "kind": "timeout",
            "stage": "initialize",
            "retryable": true
          }
        }
      ]
    },
    "query": "What is the capital of India ?",
    "confidence": 0,
    "candidates": [],
    "mode": "no_tools",
    "selected": [],
    "exposedBindings": [],
    "thresholds": {
      "highConfidenceThreshold": 0.85,
      "ambiguityMargin": 0.025
    },
    "retrievalIndex": {
      "startedAt": "2026-10-03T12:39:51.585Z",
      "completedAt": "2026-10-03T12:39:51.588Z",
      "durationMs": 2.540374999996857,
      "toolCount": 23,
      "queryCount": 1,
      "cacheHits": 0,
      "cacheMisses": 23
    },
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 3.202624999990803
  },
  {
    "at": "2026-10-03T12:40:54.948Z",
    "turn": 3,
    "permissionRejectedToolIds": [],
    "registryStatus": {
      "state": "failed",
      "configuredServerCount": 1,
      "enabledServerCount": 1,
      "upstreamToolCount": 0,
      "registryVersion": 1,
      "servers": [
        {
          "server": "qlik",
          "state": "unavailable",
          "upstreamToolCount": 0,
          "attempts": 2,
          "updatedAt": "2026-10-03T12:40:54.941Z",
          "lastError": {
            "message": "The operation was aborted due to timeout",
            "kind": "timeout",
            "stage": "initialize",
            "retryable": true
          }
        }
      ]
    },
    "query": "what are the Qlik apps ?",
    "confidence": 0,
    "candidates": [],
    "mode": "discovery",
    "selected": [],
    "fallbackCode": "registry_unavailable",
    "fallbackReason": "Requested connector registry is initializing or unavailable",
    "exposedBindings": [
      "discover_server",
      "discover_tools",
      "get_tool_schema",
      "invoke_tool"
    ],
    "thresholds": {
      "highConfidenceThreshold": 0.85,
      "ambiguityMargin": 0.025
    },
    "retrievalIndex": {
      "startedAt": "2026-10-03T12:40:54.943Z",
      "completedAt": "2026-10-03T12:40:54.948Z",
      "durationMs": 4.558707999996841,
      "toolCount": 23,
      "queryCount": 1,
      "cacheHits": 0,
      "cacheMisses": 23
    },
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 5.917207999998936
  },
  {
    "at": "2026-10-03T12:41:04.039Z",
    "turn": 4,
    "permissionRejectedToolIds": [],
    "registryStatus": {
      "state": "failed",
      "configuredServerCount": 1,
      "enabledServerCount": 1,
      "upstreamToolCount": 0,
      "registryVersion": 1,
      "servers": [
        {
          "server": "qlik",
          "state": "unavailable",
          "upstreamToolCount": 0,
          "attempts": 2,
          "updatedAt": "2026-10-03T12:40:54.941Z",
          "lastError": {
            "message": "The operation was aborted due to timeout",
            "kind": "timeout",
            "stage": "initialize",
            "retryable": true
          }
        }
      ]
    },
    "query": "What is the capital of tamilnadu ?",
    "confidence": 0,
    "candidates": [],
    "mode": "no_tools",
    "selected": [],
    "exposedBindings": [],
    "thresholds": {
      "highConfidenceThreshold": 0.85,
      "ambiguityMargin": 0.025
    },
    "retrievalIndex": {
      "startedAt": "2026-10-03T12:41:04.038Z",
      "completedAt": "2026-10-03T12:41:04.039Z",
      "durationMs": 1.413124999991851,
      "toolCount": 23,
      "queryCount": 1,
      "cacheHits": 23,
      "cacheMisses": 0
    },
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 1.8537080000096466
  },
  {
    "at": "2026-10-03T12:42:06.611Z",
    "turn": 5,
    "permissionRejectedToolIds": [],
    "registryStatus": {
      "state": "failed",
      "configuredServerCount": 1,
      "enabledServerCount": 1,
      "upstreamToolCount": 0,
      "registryVersion": 2,
      "servers": [
        {
          "server": "qlik",
          "state": "unavailable",
          "upstreamToolCount": 0,
          "attempts": 2,
          "updatedAt": "2026-10-03T12:42:06.604Z",
          "lastError": {
            "message": "The operation was aborted due to timeout",
            "kind": "timeout",
            "stage": "initialize",
            "retryable": true
          }
        }
      ]
    },
    "query": "Explain this qlik app T_DCF_BANKREC_P",
    "confidence": 0,
    "candidates": [],
    "mode": "discovery",
    "selected": [],
    "fallbackCode": "registry_unavailable",
    "fallbackReason": "Requested connector registry is initializing or unavailable",
    "exposedBindings": [
      "discover_server",
      "discover_tools",
      "get_tool_schema",
      "invoke_tool"
    ],
    "thresholds": {
      "highConfidenceThreshold": 0.85,
      "ambiguityMargin": 0.025
    },
    "retrievalIndex": {
      "startedAt": "2026-10-03T12:42:06.607Z",
      "completedAt": "2026-10-03T12:42:06.611Z",
      "durationMs": 3.9672500000160653,
      "toolCount": 23,
      "queryCount": 1,
      "cacheHits": 0,
      "cacheMisses": 23
    },
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 5.289707999996608
  }
]
```
