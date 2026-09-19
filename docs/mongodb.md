# MongoDB configuration

Database: **truex**. The application reads configuration; it never inserts default agents or model profiles on startup. `.env` contains connection/service settings, not model credentials.

## Agent — `truex_agents`

Example in mongosh notation; IDs below are illustrative, not existing records.

```js
{
  _id: ObjectId("000000000000000000000001"),
  name: "My assistant",
  description: "Your description",
  systemPrompt: "Your instructions",
  modelProfileId: "000000000000000000000002",
  mcpProfileIds: ["000000000000000000000003"],
  sandbox: "read-only",
  approvalPolicy: "never",
  enabled: true
}
```

`modelProfileId` and MCP references may be strings or ObjectIds. `description`, `systemPrompt`, `sandbox`, `approvalPolicy` and `mcpProfileIds` may be omitted. Defaults are an empty description, generic helpful-assistant instructions, read-only sandbox, never approvals, and no MCP servers. `enabled: false` hides an agent. Unknown application-specific fields are preserved and ignored; for example, `browserUseCloud` does not itself configure a browser integration.

## Model — `truex_models`

```js
{
  _id: ObjectId("000000000000000000000002"),
  provider: "Your provider",
  modelName: "your-model-id",
  baseUrl: "https://provider.example/v1",
  apiKey: "<provider credential stored only in this document>",
  wireApi: "responses",
  reasoningEffort: "medium",
  enabled: true
}
```

The existing lowercase `apikey` spelling also works. Use one spelling consistently; if both exist, `apiKey` takes precedence. Missing `wireApi` means `responses`. This Codex revision explicitly removed Chat Completions support: declaring `wireApi: "chat"` is a configuration error, and changing the string alone will not make a chat-only endpoint implement Responses. Choose a provider/model that supports the Responses API. `reasoningEffort` is optional; `serviceTier: "auto"` is omitted from runtime overrides. Disabled models are unavailable for sessions.

## MCP — `truex_mcp`

```js
{
  _id: ObjectId("000000000000000000000003"),
  name: "my-mcp",
  transport: "http",
  url: "https://mcp.example/mcp",
  apiKey: "<MCP credential stored only in this document>",
  auth: {kind: "header", headerName: "x-api-key"},
  capabilities: {connectTimeoutMs: 30000, requestTimeoutMs: 120000},
  enabled: true
}
```

For bearer authentication use `auth: {kind: "bearer"}`. For no authentication use `auth: {kind: "none"}`. HTTP credentials are translated into runtime `http_headers`; timeout milliseconds become seconds. A stdio profile uses `transport: "stdio"`, `command`, optional `args` and `env`. A profile may alternatively contain a raw runtime `config` object.

Servers explicitly referenced by an agent connect for that thread. `autoConnect` is not used as a second gate for explicitly attached servers. Disabled or missing referenced MCP profiles produce a readable configuration error. Capability-discovery flags such as `tools` and `resources` are metadata; they are not presented as runtime authorization controls.

## Operational data

`truex.sessions` stores routing, status, audit and timing metadata; `truex.messages` stores user messages and authoritative assistant finals. The application does not reuse or migrate existing `truex_runs` or `truex_conversations` schemas.

Public agent summaries project out both credential spellings. No API exposes raw model/MCP documents. Diagnostic events and advanced capability responses pass through credential redaction. Do not commit real sample documents containing credentials; `a.json` is ignored locally for that reason.
