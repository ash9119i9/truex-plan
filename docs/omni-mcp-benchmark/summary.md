# Normal MCP vs our Uber-style implementation — short report

**Result:** For our tested 14-tool Qlik connector, normal MCP used fewer total input tokens and fewer model calls. Uber-style projection reduced data size, but its discovery steps increased overall input.

We tested the same model and three sequential messages in one fresh thread per approach: “Hi bro ?” → “Can you list down the apps in the qlik ?” → “What is the capital of india ?”. The comparison uses completed runs with identical timeout controls.

| Aspect | Normal MCP | Uber-style discovery + required field selection |
|---|---|---|
| Platform behavior | Exposes attached connector tools directly | Platform builds a catalog; exposes four discovery/invocation tools |
| User configuration | No new tool allowlist requested | No end-user tool allowlist; model selects response fields |
| Qlik execution | get_apps → answer | Discover server → discover tools → get schema → invoke → answer |
| Tool schemas per model request | 39: 14 Qlik + 25 native | 29: 4 gateway + same 25 native |
| Total model calls | 4 | 7 |
| Reported input tokens | **48,560** | **69,235 — 42.6% more** |
| Reported output tokens | 1,126 | 1,072 |
| Reported total tokens | **49,686** | **70,307 — 41.5% more** |
| Sum of turn durations | 29.24 seconds | 41.53 seconds; one-run observation |
| Qlik response | Full fields | Selected names, GUIDs, streams and pagination |
| Measured projection | None | **22,444 → 6,278 bytes; 72% smaller** |
| Returned data | 50 apps; 1,324 matches, more pages | Same page size and pagination coverage; all 50 source names/GUIDs/streams preserved |
| India question input | 14,924 tokens | **12,696 tokens — 14.9% fewer** |
| Retained history | Full tool result and previous replies | Discovery results, selected schema, projected tool result and previous replies |
| Credentials and approval | Connector authentication handled by Codex MCP client | Upstream credentials stay in AgentCore; authenticated local gateway; invocation approval scoped to one call |
| Implementation | Existing path | Added outside Codex; operator-controlled experiment; direct remains default |

**Why total usage increased:** Three extra discovery calls resent system instructions, the remaining 25 native schemas and growing conversation history. Smaller individual payloads did not compensate for those additional requests.

**Optional projection trial:** Without mandatory field selection, the model omitted projection. That arm used 71,601 input tokens (+47.4%) and seven calls. Requiring fields enabled actual projection, but explicit ["*"] can still request a complete result when needed.

**Quality and limits:** Every primary request completed with HTTP 200; all arms answered New Delhi. No arm fetched all 1,324 apps. The normal MCP answer incorrectly claimed 28 returned rows although the tool returned 50. Compact responses do not guarantee accurate or complete summaries. This is one live three-message workload; source reloads and model variability limit generalization. Earlier timeout attempts are preserved separately and excluded from these totals. Some tool-call outputs were reported as zero tokens; cache/reasoning counters and monetary rates were unavailable, so these are reported usage counts, not verified invoices.

**Validation:** 207 AgentCore tests passed; AgentCore and platform builds passed. Raw Codex input, model requests, responses, approvals and tool results are captured with credentials redacted. The pinned Codex repository, production environment files and database records were unchanged.

**Recommendation:** Keep normal MCP as the default for this workload. Retain projection and test ways to apply it without additional discovery rounds. Re-evaluate full incremental discovery for larger catalogs or longer conversations, using total conversation usage and answer correctness as the acceptance criteria.

[Complete benchmark and raw-payload links](comparison.md) · [Implementation documentation](../OMNI_MCP_GATEWAY.md)
