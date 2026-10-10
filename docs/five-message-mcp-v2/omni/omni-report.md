# Live omni-required MCP V2 benchmark

Captured 2026-10-03T02:45:53.323Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | hi this is ashok ? | 1 | 8581 | 128 | 4228 | completed |
| 2 | What is the capital of India ? | 1 | 8710 | 9 | 2023 | completed |
| 3 | what are the Qlik apps ? | 5 | 44816 | 137 | 105224 | completed |
| 4 | What is the capital of tamilnadu ? | 1 | 9305 | 9 | 1816 | completed |
| 5 | Explain this qlik app T_DCF_BANKREC_P | 3 | 28360 | 153 | 70466 | completed |
| **Total known usage** | | **11** | **99772** | **436** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 29 | 8581 | 128 | 4077 |
| 2 | 2 | 29 | 8710 | 9 | 1934 |
| 3 | 3 | 29 | 8735 | 12 | 2004 |
| 4 | 3 | 29 | 8849 | 0 | 2118 |
| 5 | 3 | 29 | 8961 | 10 | 2919 |
| 6 | 3 | 29 | 9075 | 12 | 3577 |
| 7 | 3 | 29 | 9196 | 103 | 4255 |
| 8 | 4 | 29 | 9305 | 9 | 1576 |
| 9 | 5 | 29 | 9335 | 14 | 2205 |
| 10 | 5 | 29 | 9459 | 0 | 2827 |
| 11 | 5 | 29 | 9566 | 139 | 5154 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: hi this is ashok ?

Status: completed. Thread: `01a0ffa7-6c2f-7030-8eb2-c8440c270427`.

Hi Ashok, good to meet you.

I'm your Truex assistant, a senior consultant here to help with things like:
- Analyzing and summarizing business data through connected systems (I have a Qlik connector available)
- Answering questions and researching current information from the web
- Drafting and revising documents (PDF, Word, Excel, PowerPoint)
- Building interactive charts, diagrams, or explainers when they'd help
- Working through multi-step projects with a clear plan you approve first

What can I help you with today?

Tool exchanges:

```json
[]
```

### Turn 2: What is the capital of India ?

Status: completed. Thread: `01a0ffa7-6c2f-7030-8eb2-c8440c270427`.

The capital of India is New Delhi.

Tool exchanges:

```json
[]
```

### Turn 3: what are the Qlik apps ?

Status: completed. Thread: `01a0ffa7-6c2f-7030-8eb2-c8440c270427`.

I'll check the Qlik connector for available apps.
Let me retry the Qlik tool discovery.
One more attempt before I report this as a limitation.
The Qlik connector is configured, but its tools are currently unavailable — three attempts to discover its tools all timed out. I can't retrieve the list of Qlik apps right now.

You could try again shortly, or let me know if there's something else I can help with in the meantime.

[truex-suggestions]
- Can you try the Qlik apps list again?
- What other connectors are available?
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_012QdHn6pgMiNtqBSecQEESQ",
    "server": "omni",
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
          "text": "{\"servers\":[{\"name\":\"qlik\"}]}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 4
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01J8zxF2un3gHcSPtYECemsh",
    "server": "omni",
    "tool": "discover_tools",
    "status": "failed",
    "arguments": {
      "server": "qlik",
      "query": "list apps"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"error\":\"The operation was aborted due to timeout\"}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 30010
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01MdMGK15sgufLuNavQY5hYW",
    "server": "omni",
    "tool": "discover_tools",
    "status": "failed",
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
          "text": "{\"error\":\"The operation was aborted due to timeout\"}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 30007
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01K5BQVERUqNLvcLWXMC2xcn",
    "server": "omni",
    "tool": "discover_tools",
    "status": "failed",
    "arguments": {
      "server": "qlik",
      "query": "list apps"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"error\":\"The operation was aborted due to timeout\"}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 30004
  }
]
```

### Turn 4: What is the capital of tamilnadu ?

Status: completed. Thread: `01a0ffa7-6c2f-7030-8eb2-c8440c270427`.

The capital of Tamil Nadu is Chennai.

Tool exchanges:

```json
[]
```

### Turn 5: Explain this qlik app T_DCF_BANKREC_P

Status: completed. Thread: `01a0ffa7-6c2f-7030-8eb2-c8440c270427`.

I'll check the Qlik connector for details on this app.
The Qlik connector is configured, but its tools are currently unavailable — tool discovery has timed out on repeated attempts, so I can't look up details on T_DCF_BANKREC_P right now.

I don't have information about this app from any other source, so I can't explain it without the connector. You could try again in a bit, or if you know roughly what it covers, I can help interpret results once the connection is working.

[truex-suggestions]
- Can you try connecting to Qlik again?
- What other data sources are available?
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01VfyEp5VzhYyXrgCLYgtt76",
    "server": "omni",
    "tool": "discover_tools",
    "status": "failed",
    "arguments": {
      "server": "qlik",
      "query": "app details metadata"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"error\":\"The operation was aborted due to timeout\"}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 30007
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01BzNDzXYeT787TMcVKhvsLf",
    "server": "omni",
    "tool": "discover_tools",
    "status": "failed",
    "arguments": {
      "server": "qlik",
      "query": "app"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"error\":\"The operation was aborted due to timeout\"}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 30005
  }
]
```

## Payload and observability files

- [All redacted wire requests, provider SSE events, runtime events, traces and gateway events](omni-capture.json)
- [Exact JSON-RPC messages written to Codex stdin](omni-codex-input.jsonl)
- [Exact Responses bodies generated by Codex](omni-responses-requests.jsonl)
- [Exact Anthropic request bodies sent upstream](omni-provider-requests.jsonl)

The Codex `turn/start` RPC contains the new message; Codex maintains thread history and expands it into model requests. Payloads retain full instructions, schemas, history and tool results. Credentials and connector HTTP headers are redacted. Runtime MCP events show real tool results; gateway events quantify projection. No estimated component breakdown is substituted for measured billing.

## Run conditions and limits

The configuration builder loads model and MCP profiles read-only from MongoDB and uses the supplied scenario agent. Explicit connector documents are normalized into that scenario without writes to tenant configuration. Native tools remain unchanged. MCP startup is awaited before the greeting. The harness approves only the requested Qlik listing and read-only operations for the named-app explanation, plus discovery and a turn-5 plan confirmation. Approval answers are captured. It refuses writes and unrelated approval prompts. Calls capped at 48, timeout 600000 ms per turn. Sequential real-world A/B trials are sensitive to model variability and live source changes; one run is directional evidence, not a statistical performance guarantee.

## Actual model-boundary selection and first-token timing

Arm: **omni-required**. Effective projection: **required**.

| Call | Turn | Codex schemas before filter | Schemas sent | Schema JSON bytes before | Schema JSON bytes after | First provider body byte ms | First text delta ms | First tool block ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 29 | 29 | 27300 | 27300 | 2412 | 2414 | no tool |
| 2 | 2 | 29 | 29 | 27300 | 27300 | 1840 | 1842 | no tool |
| 3 | 3 | 29 | 29 | 27300 | 27300 | 1408 | 1409 | 1991 |
| 4 | 3 | 29 | 29 | 27300 | 27300 | 1923 | no text | 2115 |
| 5 | 3 | 29 | 29 | 27300 | 27300 | 2511 | 2512 | 2917 |
| 6 | 3 | 29 | 29 | 27300 | 27300 | 2646 | 2647 | 3575 |
| 7 | 3 | 29 | 29 | 27300 | 27300 | 3047 | 3048 | no tool |
| 8 | 4 | 29 | 29 | 27300 | 27300 | 1475 | 1475 | no tool |
| 9 | 5 | 29 | 29 | 27300 | 27300 | 1986 | 1987 | 2162 |
| 10 | 5 | 29 | 29 | 27300 | 27300 | 2719 | no text | 2825 |
| 11 | 5 | 29 | 29 | 27300 | 27300 | 2498 | 2499 | no tool |

All timing is measured from provider-request start. HTTP headers alone are not treated as a text token. Schema byte sizes are serialized captured JSON, not component token counts. The complete [actual Responses requests sent to the model gateway](omni-actual-responses-requests.jsonl) are captured separately from the original Codex requests.

Routing is performed once before each user turn, not after every tool call. The selected plan is reused for the remaining calls of that turn. The model sees filtered schemas while Codex retains a static dispatch catalog. Adaptive gateway events, registry metadata, routing plans, selection traces and full/projected results are saved in the full capture. No registry or routing trace is silently inserted into model context.

```json
[]
```
