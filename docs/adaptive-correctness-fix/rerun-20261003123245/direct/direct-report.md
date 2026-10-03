# Live direct MCP V2 benchmark

Captured 2026-10-03T12:34:10.248Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | hi this is ashok ? | 1 | 7953 | 111 | 5051 | completed |
| 2 | What is the capital of India ? | 1 | 8067 | 47 | 2426 | completed |
| 3 | what are the Qlik apps ? | 3 | 24965 | 148 | 9664 | completed |
| 4 | What is the capital of tamilnadu ? | 1 | 8630 | 43 | 2220 | completed |
| 5 | Explain this qlik app T_DCF_BANKREC_P | 2 | 17580 | 127 | 5835 | completed |
| **Total known usage** | | **8** | **67195** | **476** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 25 | 7953 | 111 | 4745 |
| 2 | 2 | 25 | 8067 | 47 | 2313 |
| 3 | 3 | 25 | 8125 | 12 | 2910 |
| 4 | 3 | 25 | 8314 | 39 | 3476 |
| 5 | 3 | 25 | 8526 | 97 | 3051 |
| 6 | 4 | 25 | 8630 | 43 | 2117 |
| 7 | 5 | 25 | 8690 | 16 | 2463 |
| 8 | 5 | 25 | 8890 | 111 | 3111 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: hi this is ashok ?

Status: completed. Thread: `01a101c2-02fa-73f1-b263-73609b5ca587`.

Hi Ashok, good to meet you.

I'm your Truex assistant. I can help with things like:

- Answering questions and summarizing documents you share with me
- Pulling and explaining business data through connected sources (I currently have a Qlik connector available)
- Researching current information from the web
- Creating downloadable documents (Word, Excel, PowerPoint, PDF)
- Building interactive charts or visualizations when helpful

What would you like to work on?

Tool exchanges:

```json
[]
```

### Turn 2: What is the capital of India ?

Status: completed. Thread: `01a101c2-02fa-73f1-b263-73609b5ca587`.

The capital of India is New Delhi.

[truex-suggestions]
- What is the population of New Delhi?
- Can you tell me more about India's government structure?
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 3: what are the Qlik apps ?

Status: completed. Thread: `01a101c2-02fa-73f1-b263-73609b5ca587`.

I'll check the Qlik connector for available apps.
The Qlik connector is configured for this agent, but I wasn't able to connect to it just now — the connection attempt timed out during startup. Let me retry.
The Qlik connector is configured for this session, but it's currently unavailable — both attempts to connect timed out during the handshake, so I can't retrieve the list of Qlik apps right now. This isn't something I can work around by searching elsewhere, since that data only exists in Qlik.

You could try again in a bit, or let me know if you'd like me to attempt the connection once more.

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_017b3Nekn3wLASH7JD4Yv949",
    "server": "qlik",
    "tool": "list_mcp_resource_templates",
    "status": "failed",
    "arguments": {
      "server": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": null,
    "result": null,
    "error": {
      "message": "resources/templates/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    },
    "durationMs": 0
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01NinHjkPKTXEGEA9WKKh6iY",
    "server": "qlik",
    "tool": "list_mcp_resources",
    "status": "failed",
    "arguments": {
      "server": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": null,
    "result": null,
    "error": {
      "message": "resources/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    },
    "durationMs": 0
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01JR6xCfAvPYGaq8KXnbvBC8",
    "server": "qlik",
    "tool": "list_mcp_resource_templates",
    "status": "failed",
    "arguments": {
      "server": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": null,
    "result": null,
    "error": {
      "message": "resources/templates/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    },
    "durationMs": 0
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01CqtfKarGUh2ZfUVrzDRssj",
    "server": "qlik",
    "tool": "list_mcp_resources",
    "status": "failed",
    "arguments": {
      "server": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": null,
    "result": null,
    "error": {
      "message": "resources/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    },
    "durationMs": 0
  }
]
```

### Turn 4: What is the capital of tamilnadu ?

Status: completed. Thread: `01a101c2-02fa-73f1-b263-73609b5ca587`.

The capital of Tamil Nadu is Chennai.

[truex-suggestions]
- What is the population of Chennai?
- Can you try connecting to Qlik again?
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 5: Explain this qlik app T_DCF_BANKREC_P

Status: completed. Thread: `01a101c2-02fa-73f1-b263-73609b5ca587`.

Let me try the Qlik connector again to look up that app.
The Qlik connector is still timing out on the handshake, so I can't retrieve details on **T_DCF_BANKREC_P** right now. I don't have information about this app from any other source, and I can't substitute a web search or guess at its contents since it's private Qlik data.

This looks like a persistent connection issue rather than something a retry will fix. Would you like me to try once more, or would you prefer to check back later?

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01J1HH8UHCiQWfZzJkMLgRBQ",
    "server": "qlik",
    "tool": "list_mcp_resources",
    "status": "failed",
    "arguments": {
      "server": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": null,
    "result": null,
    "error": {
      "message": "resources/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    },
    "durationMs": 0
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01FPUNd66MZ5cJSqGV4RRXnU",
    "server": "qlik",
    "tool": "list_mcp_resource_templates",
    "status": "failed",
    "arguments": {
      "server": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": null,
    "result": null,
    "error": {
      "message": "resources/templates/list failed: failed to get client: MCP startup failed: timed out handshaking with MCP server after 29.999754041s"
    },
    "durationMs": 0
  }
]
```

## Payload and observability files

- [All redacted wire requests, provider SSE events, runtime events, traces and gateway events](direct-capture.json)
- [Exact JSON-RPC messages written to Codex stdin](direct-codex-input.jsonl)
- [Exact Responses bodies generated by Codex](direct-responses-requests.jsonl)
- [Exact Anthropic request bodies sent upstream](direct-provider-requests.jsonl)

The Codex `turn/start` RPC contains the new message; Codex maintains thread history and expands it into model requests. Payloads retain full instructions, schemas, history and tool results. Credentials and connector HTTP headers are redacted. Runtime MCP events show real tool results; gateway events quantify projection. No estimated component breakdown is substituted for measured billing.

## Run conditions and limits

The configuration builder loads model and MCP profiles read-only from MongoDB and uses the supplied scenario agent. Explicit connector documents are normalized into that scenario without writes to tenant configuration. Native tools remain unchanged. MCP startup is awaited before the greeting. The harness approves only the requested Qlik listing and read-only operations for the named-app explanation, plus discovery and a turn-5 plan confirmation. Approval answers are captured. It refuses writes and unrelated approval prompts. Calls capped at 48, timeout 600000 ms per turn. Sequential real-world A/B trials are sensitive to model variability and live source changes; one run is directional evidence, not a statistical performance guarantee.

## Actual model-boundary selection and first-token timing

Arm: **direct**. Effective projection: **required**.

| Call | Turn | Codex schemas before filter | Schemas sent | Schema JSON bytes before | Schema JSON bytes after | First provider body byte ms | First text delta ms | First tool block ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 25 | 25 | 24952 | 24952 | 3196 | 3198 | no tool |
| 2 | 2 | 25 | 25 | 24952 | 24952 | 1598 | 1598 | no tool |
| 3 | 3 | 25 | 25 | 24952 | 24952 | 1974 | 1974 | 2906 |
| 4 | 3 | 25 | 25 | 24952 | 24952 | 2078 | 2078 | 3474 |
| 5 | 3 | 25 | 25 | 24952 | 24952 | 1548 | 1549 | no tool |
| 6 | 4 | 25 | 25 | 24952 | 24952 | 1514 | 1514 | no tool |
| 7 | 5 | 25 | 25 | 24952 | 24952 | 1684 | 1685 | 2458 |
| 8 | 5 | 25 | 25 | 24952 | 24952 | 1494 | 1495 | no tool |

All timing is measured from provider-request start. HTTP headers alone are not treated as a text token. Schema byte sizes are serialized captured JSON, not component token counts. The complete [actual Responses requests sent to the model gateway](direct-actual-responses-requests.jsonl) are captured separately from the original Codex requests.

Routing is performed once before each user turn, not after every tool call. The selected plan is reused for the remaining calls of that turn. The model sees filtered schemas while Codex retains a static dispatch catalog. Adaptive gateway events, registry metadata, routing plans, selection traces and full/projected results are saved in the full capture. No registry or routing trace is silently inserted into model context.

```json
[]
```
