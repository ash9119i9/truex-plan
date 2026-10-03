# Live omni-required MCP V2 benchmark

Captured 2026-10-03T12:36:03.147Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | hi this is ashok ? | 1 | 8581 | 112 | 4233 | completed |
| 2 | What is the capital of India ? | 1 | 8696 | 56 | 3433 | completed |
| 3 | what are the Qlik apps ? | 4 | 35763 | 157 | 72363 | completed |
| 4 | What is the capital of tamilnadu ? | 1 | 9243 | 51 | 3628 | completed |
| 5 | Explain this qlik app T_DCF_BANKREC_P | 2 | 18749 | 178 | 37311 | completed |
| **Total known usage** | | **9** | **81032** | **554** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 29 | 8581 | 112 | 4049 |
| 2 | 2 | 29 | 8696 | 56 | 3204 |
| 3 | 3 | 29 | 8762 | 12 | 2348 |
| 4 | 3 | 29 | 8876 | 0 | 2320 |
| 5 | 3 | 29 | 8986 | 48 | 3577 |
| 6 | 3 | 29 | 9139 | 97 | 3789 |
| 7 | 4 | 29 | 9243 | 51 | 3545 |
| 8 | 5 | 29 | 9310 | 24 | 2538 |
| 9 | 5 | 29 | 9439 | 154 | 4603 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: hi this is ashok ?

Status: completed. Thread: `01a101c3-bb49-7161-9b75-5df502790bf7`.

Hi Ashok, nice to meet you.

I'm your Truex assistant. I can help with things like:

- Answering questions and summarizing documents you share with me
- Pulling and analyzing data from connected business systems (I currently have a Qlik connector available)
- Researching current information from the web
- Creating downloadable documents (Word, Excel, PowerPoint, PDF)
- Building interactive visuals or charts for things we discuss

What would you like to work on?

Tool exchanges:

```json
[]
```

### Turn 2: What is the capital of India ?

Status: completed. Thread: `01a101c3-bb49-7161-9b75-5df502790bf7`.

The capital of India is New Delhi.

[truex-suggestions]
- What's the population of New Delhi?
- Can you show data from our Qlik connector?
- What else can you help me with?
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 3: what are the Qlik apps ?

Status: completed. Thread: `01a101c3-bb49-7161-9b75-5df502790bf7`.

I'll check the Qlik connector for available apps.
The Qlik connector is configured, but the tool discovery call timed out, so I wasn't able to retrieve the list of Qlik apps just now. Let me try once more before concluding it's unavailable.
The Qlik connector is configured, but its tools are currently unavailable, both discovery attempts timed out. I don't have evidence of a list of Qlik apps to share right now.

Want me to try again, or is there something else I can help with in the meantime?

[truex-suggestions]
- Try the Qlik connector again?
- What else can you help me with?
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01CMrW79vy5Zcx2p6sPTBrpo",
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
    "durationMs": 5
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01FQPh5h5JrNgQRpywRGHFkB",
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
    "durationMs": 30011
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01XaRo9zAfgsJeDeZQZWXpoM",
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
    "durationMs": 30005
  }
]
```

### Turn 4: What is the capital of tamilnadu ?

Status: completed. Thread: `01a101c3-bb49-7161-9b75-5df502790bf7`.

The capital of Tamil Nadu is Chennai.

[truex-suggestions]
- What is the capital of Karnataka?
- Try the Qlik connector again?
- What else can you help me with?
[/truex-suggestions]

Tool exchanges:

```json
[]
```

### Turn 5: Explain this qlik app T_DCF_BANKREC_P

Status: completed. Thread: `01a101c3-bb49-7161-9b75-5df502790bf7`.

I need to check the Qlik connector for details on that specific app. Let me try discovery again.
I tried again, but the Qlik connector's tools are still timing out on discovery. The connector is configured, but I can't currently reach its tools to look up "T_DCF_BANKREC_P" or any app details.

I don't have any other source for this information — I can't guess at what this app contains without pulling it from Qlik. Want me to try once more, or would you like to share any details about it yourself (e.g., from a document) that I could summarize?

[truex-suggestions]
- Try the Qlik connector again?
- What else can you help me with?
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_011jxtF32t6B439JGNjSBtMV",
    "server": "omni",
    "tool": "discover_tools",
    "status": "failed",
    "arguments": {
      "server": "qlik",
      "query": "app details"
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
    "durationMs": 30006
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
| 1 | 1 | 29 | 29 | 27300 | 27300 | 2610 | 2611 | no tool |
| 2 | 2 | 29 | 29 | 27300 | 27300 | 2509 | 2510 | no tool |
| 3 | 3 | 29 | 29 | 27300 | 27300 | 1931 | 1932 | 2343 |
| 4 | 3 | 29 | 29 | 27300 | 27300 | 2013 | no text | 2318 |
| 5 | 3 | 29 | 29 | 27300 | 27300 | 2295 | 2295 | 3574 |
| 6 | 3 | 29 | 29 | 27300 | 27300 | 2405 | 2405 | no tool |
| 7 | 4 | 29 | 29 | 27300 | 27300 | 2955 | 2955 | no tool |
| 8 | 5 | 29 | 29 | 27300 | 27300 | 1690 | 1690 | 2536 |
| 9 | 5 | 29 | 29 | 27300 | 27300 | 2802 | 2802 | no tool |

All timing is measured from provider-request start. HTTP headers alone are not treated as a text token. Schema byte sizes are serialized captured JSON, not component token counts. The complete [actual Responses requests sent to the model gateway](omni-actual-responses-requests.jsonl) are captured separately from the original Codex requests.

Routing is performed once before each user turn, not after every tool call. The selected plan is reused for the remaining calls of that turn. The model sees filtered schemas while Codex retains a static dispatch catalog. Adaptive gateway events, registry metadata, routing plans, selection traces and full/projected results are saved in the full capture. No registry or routing trace is silently inserted into model context.

```json
[]
```
