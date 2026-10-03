# Live adaptive MCP V2 benchmark

Captured 2026-10-03T02:50:43.489Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | hi this is ashok ? | 1 | 3068 | 170 | 4629 | completed |
| 2 | What is the capital of India ? | 1 | 3233 | 54 | 3428 | completed |
| 3 | what are the Qlik apps ? | 3 | 11485 | 162 | 10304 | completed |
| 4 | What is the capital of tamilnadu ? | 1 | 3663 | 51 | 2018 | completed |
| 5 | Explain this qlik app T_DCF_BANKREC_P | 1 | 4153 | 254 | 5242 | completed |
| **Total known usage** | | **7** | **25602** | **691** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 2 | 3068 | 170 | 4513 |
| 2 | 2 | 2 | 3233 | 54 | 3236 |
| 3 | 3 | 6 | 3720 | 14 | 2312 |
| 4 | 3 | 6 | 3827 | 0 | 2903 |
| 5 | 3 | 6 | 3938 | 148 | 4788 |
| 6 | 4 | 2 | 3663 | 51 | 1945 |
| 7 | 5 | 6 | 4153 | 254 | 5054 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: hi this is ashok ?

Status: completed. Thread: `01a0ffac-5194-75b3-83f4-b81cb5abb3af`.

Hi Ashok, nice to meet you.

I'm your Truex assistant. I'm here to help with things like:

- Answering questions and summarizing documents you share with me
- Pulling and analyzing business data through connected sources (I have a Qlik connector available for this)
- Researching current information from the web
- Creating documents (PDF, Word, Excel, PowerPoint) or interactive visualizations
- Working through multi-step tasks with a clear plan you approve first

What can I help you with today?

[truex-suggestions]
- What data can you pull from Qlik?
- Can you summarize a document I upload?
- What kinds of reports can you create?
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 2: What is the capital of India ?

Status: completed. Thread: `01a0ffac-5194-75b3-83f4-b81cb5abb3af`.

The capital of India is New Delhi.

[truex-suggestions]
- What is the capital of Pakistan?
- What is the population of New Delhi?
- Tell me more about New Delhi's history
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 3: what are the Qlik apps ?

Status: completed. Thread: `01a0ffac-5194-75b3-83f4-b81cb5abb3af`.

I'll check what's available through the connected Qlik server.
The Qlik server is configured for this agent, but I'm not finding any usable tools on it right now, no apps or data came back from discovery. That means I can't retrieve your Qlik apps at the moment.

Could you confirm if the Qlik connector should be active for your account? If so, this may need to be checked on the connection side. In the meantime, is there anything else I can help with?

[truex-suggestions]
- Can you try the Qlik connection again?
- What other data sources can you connect to?
- Can you help me with something else?
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01JAknRBRWco6qUrZQVAGUs3",
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
          "text": "{\"servers\":[]}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 3
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_016HJcqF1ypMMMnare8J3RYq",
    "server": "adaptive",
    "tool": "discover_tools",
    "status": "completed",
    "arguments": {
      "server": "qlik",
      "query": "apps"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"server\":\"qlik\",\"tools\":[],\"totalMatched\":0}"
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

Status: completed. Thread: `01a0ffac-5194-75b3-83f4-b81cb5abb3af`.

The capital of Tamil Nadu is Chennai.

[truex-suggestions]
- What is the capital of Karnataka?
- What is the population of Chennai?
- Tell me more about Chennai's history
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 5: Explain this qlik app T_DCF_BANKREC_P

Status: completed. Thread: `01a0ffac-5194-75b3-83f4-b81cb5abb3af`.

I don't have access to that app's details right now. When I checked the Qlik connector earlier, no tools or apps came back from discovery, so I can't retrieve information about "T_DCF_BANKREC_P" (its structure, sheets, data model, or contents).

The Qlik server is configured for this agent, but its tools aren't currently available to me. This could be a temporary connection issue on the backend. I don't want to guess or invent details about what this app contains, since that could be misleading for something that sounds like a bank reconciliation app (DCF_BANKREC likely relates to financial/bank reconciliation data).

Could you try again in a bit, or let me know if there's another way you'd like to get this information (e.g., if you can share screenshots or an export of the app's content, I can help analyze that)?

[truex-suggestions]
- Can you try the Qlik connection again?
- Can I upload a document about this app instead?
- What else can you help me with?
[/truex-suggestions]

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
| 1 | 1 | 29 | 2 | 26962 | 2102 | 2182 | 2183 | no tool |
| 2 | 2 | 29 | 2 | 26962 | 2102 | 2965 | 2965 | no tool |
| 3 | 3 | 29 | 6 | 26962 | 4112 | 1683 | 1684 | 2308 |
| 4 | 3 | 29 | 6 | 26962 | 4112 | 2901 | no text | 2901 |
| 5 | 3 | 29 | 6 | 26962 | 4112 | 4320 | 4322 | no tool |
| 6 | 4 | 29 | 2 | 26962 | 2102 | 1713 | 1717 | no tool |
| 7 | 5 | 29 | 6 | 26962 | 4112 | 1351 | 1351 | no tool |

All timing is measured from provider-request start. HTTP headers alone are not treated as a text token. Schema byte sizes are serialized captured JSON, not component token counts. The complete [actual Responses requests sent to the model gateway](adaptive-actual-responses-requests.jsonl) are captured separately from the original Codex requests.

Routing is performed once before each user turn, not after every tool call. The selected plan is reused for the remaining calls of that turn. The model sees filtered schemas while Codex retains a static dispatch catalog. Adaptive gateway events, registry metadata, routing plans, selection traces and full/projected results are saved in the full capture. No registry or routing trace is silently inserted into model context.

```json
[
  {
    "at": "2026-10-03T02:51:18.311Z",
    "turn": 1,
    "permissionRejectedToolIds": [],
    "query": "hi this is ashok ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.047292000002926216
  },
  {
    "at": "2026-10-03T02:51:22.950Z",
    "turn": 2,
    "permissionRejectedToolIds": [],
    "query": "What is the capital of India ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.06379200000083074
  },
  {
    "at": "2026-10-03T02:51:26.391Z",
    "turn": 3,
    "permissionRejectedToolIds": [],
    "query": "what are the Qlik apps ?",
    "confidence": 0,
    "candidates": [],
    "mode": "discovery",
    "selected": [],
    "fallbackReason": "No authorized matching enterprise tool",
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.0768339999995078
  },
  {
    "at": "2026-10-03T02:51:36.709Z",
    "turn": 4,
    "permissionRejectedToolIds": [],
    "query": "What is the capital of tamilnadu ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.05025000000023283
  },
  {
    "at": "2026-10-03T02:51:38.753Z",
    "turn": 5,
    "permissionRejectedToolIds": [],
    "query": "Explain this qlik app T_DCF_BANKREC_P",
    "confidence": 0,
    "candidates": [],
    "mode": "discovery",
    "selected": [],
    "fallbackReason": "No authorized matching enterprise tool",
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.05658400000538677
  }
]
```
