# Agent token profile

Generated: 2026-10-03T00:24:57.227Z

| Setting | Value |
| --- | --- |
| Agent | agent_ea6007a6-aae5-4e50-824c-1480256bfeea |
| Input mode | documents |
| Last stage | turn-wait |
| Tenant | default |
| Owner (user MCP selection) | None — tenant connectors only |
| Model | claude-sonnet-5 |
| Thread | 01a0ff26-56ac-7790-874a-712ad30933a1 |
| Turn | 01a0ff26-571f-7ba0-8e7f-bd659cd02446 |
| Outcome | completed |
| Duration (ms) | 7159 |
| Usage coverage | 1/1 captured HTTP attempts |

## Overall provider-reported usage

| Metric | Tokens | Meaning |
| --- | --- | --- |
| Input overall | 7949 | Sum across measured model calls; repeated context counts again |
| Cached input | 0 | Subset of input overall |
| Uncached input | 7949 | Input minus cached input |
| Output overall | 103 | Includes reasoning where the provider reports it |
| Reasoning output | 0 | Subset of output overall; omitted provider detail defaults to zero |
| Other output | 103 | Output minus reasoning; includes reply and tool calls |
| Total | 8052 | Input plus output; cached/reasoning subsets are not added again |

These are reported counts at the Codex Responses boundary. Missing usage is unavailable, not zero. Partial coverage is a lower bound, not a complete run total. Gateway routes may translate/normalize upstream usage and prompts. Failed/retried attempts can consume tokens without returning usage. No cost estimate is made.

## Model calls and retries

| HTTP attempt | Status | Input | Cached | Output | Reasoning | Total | Visible input estimate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 7949 | 0 | 103 | 0 | 8052 | 9486 |

## Input split — ranked optimization targets

| Component | Occurrences | Characters | Estimated tokens | % of visible estimate |
| --- | --- | --- | --- | --- |
| Tool schema: multi_agent_v1 | 1 | 10072 | 2518 | 26.5% |
| Instructions (platform + Codex runtime) | 1 | 8740 | 2185 | 23.0% |
| developer instructions | 1 | 4106 | 1027 | 10.8% |
| Tool schema: update_goal | 1 | 1940 | 485 | 5.1% |
| Tool schema: request_user_input | 1 | 1366 | 342 | 3.6% |
| Tool schema: create_document | 1 | 1223 | 306 | 3.2% |
| Tool schema: search_files | 1 | 818 | 205 | 2.2% |
| Tool schema: edit_file | 1 | 786 | 197 | 2.1% |
| Tool schema: write_file | 1 | 776 | 194 | 2.0% |
| Tool schema: create_goal | 1 | 760 | 190 | 2.0% |
| Tool schema: update_plan | 1 | 733 | 184 | 1.9% |
| Tool schema: list_mcp_resource_templates | 1 | 717 | 180 | 1.9% |
| Tool schema: read_file | 1 | 687 | 172 | 1.8% |
| Tool schema: append_file | 1 | 675 | 169 | 1.8% |
| Tool schema: create_visualization | 1 | 635 | 159 | 1.7% |
| Tool schema: export_workspace_file | 1 | 635 | 159 | 1.7% |
| Tool schema: list_mcp_resources | 1 | 628 | 157 | 1.7% |
| Tool schema: read_mcp_resource | 1 | 526 | 132 | 1.4% |
| Tool schema: list_files | 1 | 528 | 132 | 1.4% |
| Tool schema: delete_file | 1 | 457 | 115 | 1.2% |
| Tool schema: read_conversation_file | 1 | 443 | 111 | 1.2% |
| Tool schema: get_goal | 1 | 281 | 71 | 0.7% |
| Tool schema: conversation_files | 1 | 244 | 61 | 0.6% |
| User messages / environment context | 1 | 137 | 35 | 0.4% |

Section estimates use ceil(JavaScript string length / 4), including visible JSON wrappers. They are rough size indicators, especially for SAP identifiers, code and non-English text; they are NOT exact tokenizer counts, billing attribution, or a reconciliation to provider totals. Hidden server context, images/audio, framing and gateway-added content cannot be attributed here. The user/context group includes Codex environment messages. Tool schemas are listed separately by name. Skill bodies only count if Codex loads them into a request.

## Visible output split (estimates, not billing counts)

| Attempt | Component | Characters | Estimated tokens |
| --- | --- | --- | --- |
| 1 | Assistant messages | 579 | 145 |

Only completed wire output items are counted here, including JSON wrappers. Hidden reasoning cannot be measured from text. Use the provider reasoning counter above; do not add visible estimates to reported output totals.

## AgentCore trace cross-check

| Source | Input | Cached | Output | Reasoning | Total |
| --- | --- | --- | --- | --- | --- |
| Main turn | 7949 | 0 | 103 | 0 | 8052 |
| Helper agents | n/a | n/a | n/a | n/a | n/a |

The proxy observes requests using this provider configuration, including helpers that inherit it. Runtime traces are shown separately and are not added to proxy totals. Other provider overrides and gateway-internal requests are outside capture coverage.

## Platform configuration inventory (before AgentCore enrichment)

| Component | Characters | Estimated tokens |
| --- | --- | --- |
| Base instructions + connector instructions | 1372 | 343 |
| Attached connector names (configuration only) | 20 | 5 |

This inventory is not added to the wire split: these components may already appear there, or may remain runtime configuration/files rather than model input.

## Where to optimize first

1. **Tool schema: multi_agent_v1**: approximately 2518 visible tokens across 1 occurrences.
2. **Instructions (platform + Codex runtime)**: approximately 2185 visible tokens across 1 occurrences.
3. **developer instructions**: approximately 1027 visible tokens across 1 occurrences.
4. **Tool schema: update_goal**: approximately 485 visible tokens across 1 occurrences.
5. **Tool schema: request_user_input**: approximately 342 visible tokens across 1 occurrences.

Compare the first call with later calls to identify repeated instruction/schema cost and growing tool-result/history cost. Narrow attached connectors and verbose schemas, load skill bodies only when needed, and reduce oversized tool results before shortening the user request. Measure cached input separately: it still occupies context. Reasoning and tool-call output may explain output beyond the visible reply. Re-run the same message after one change to compare measured totals.

## Agent response

Hi, I'm your Truex assistant. I can help with:

- Answering questions and summarizing documents you share with me
- Researching current information via web search, with sourced links
- Creating downloadable documents (PDF, Word, Excel, PowerPoint)
- Building interactive visuals and explainers within our conversation
- Pulling and explaining business data through connected systems like Qlik, when relevant

What would you like help with today?

Raw provider payloads, authorization headers, connector credentials and skill bodies are not saved. Response text is privacy-masked, but reports can still contain business-sensitive information.
