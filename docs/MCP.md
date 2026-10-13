# MCP

TRUEX configures MCP. The pinned Codex app-server connects to the MCP servers,
lists their tools, offers them to the model, runs the calls and handles the
results. TRUEX presents the conversation. There is no TRUEX MCP gateway, router
or model relay between Codex and an MCP server.

```text
Browser -> Platform -> Agent Core -> pinned Codex app-server -> MCP server
            auth        restricts       initialize, tools/list,
            tenant      config,         model tool catalog,
            attachments approvals       tools/call, results
```

## Configuration lifecycle

1. A user (own connectors) or tenant admin (tenant connectors) saves an HTTP
   profile in `truex_mcp` and attaches it to an agent (`agentIds`). Profiles are
   managed in Connected tools or through `/api/mcp`, `/api/tenant/mcp` and
   `/api/agents/:id/(tenant-)mcp`. Names are `A-Za-z0-9-` words joined by single
   underscores (Codex names tools `mcp__<server>__<tool>`). A tenant name
   shadows a user connector of the same name.
2. When a conversation is created or resumed, `PlatformService.configuration`
   loads the **conversation owner's** enabled, attached connectors plus the
   tenant's, re-checks each URL (SSRF/DNS policy, `MCP_ALLOWED_PRIVATE_HOSTS`,
   `MCP_REQUIRE_HTTPS`) and writes one native entry per connector:

   ```json
   "mcp_servers.btp": {
     "url": "https://…/mcp",
     "http_headers": { "Authorization": "Bearer …" },
     "startup_timeout_sec": 30,
     "tool_timeout_sec": 120,
     "default_tools_approval_mode": "prompt"
   }
   ```

   Timeouts appear only when the profile sets them (Codex defaults: 30 s
   startup, 300 s per tool call). `default_tools_approval_mode: "prompt"` is set
   only when approval modes are enabled, so Agent Core can decide each call.
3. Agent Core (`BusinessRuntime`) accepts only these keys per server: `url`,
   `http_headers`, `startup_timeout_sec`, `tool_timeout_sec`,
   `default_tools_approval_mode`, `enabled_tools`, `disabled_tools`, `enabled`.
   Anything else (`command`, `env_http_headers`, `bearer_token_env_var`,
   `env_vars`, `http_headers_helper`, `required`, …) is refused with
   `CONNECTOR_POLICY`, because those keys read this process's environment or run
   local commands. The entry is otherwise passed to Codex unchanged.
4. Credentials live only in the runtime configuration. They are not in
   summaries, SSE events, prompts or logs (`Redactor` removes known values).

## Discovery, selection and execution

All native Codex:

- `initialize` and a paginated `tools/list` run when the thread starts or
  resumes. The first turn waits for the result; a failed server contributes no
  tools and the turn goes on without them.
- Each tool is offered as a function in a namespace `mcp__<server>`. Tool names,
  descriptions and input schemas are the server's own. The server's
  `instructions` become the namespace description.
- The model picks a tool; Codex validates the call, asks for approval when the
  policy requires it, sends `tools/call` once, and passes the result back to the
  model. A timed-out or failed call is reported to the model and is not
  replayed. Codex adds `_meta` (call id, thread/turn metadata) to `tools/call`.
- Resource tools (`list_mcp_resources`, `read_mcp_resource`, …) are also native.

## Approvals

Codex asks through `request_user_input`; the existing approval UI answers.
Without approval modes, Codex's own policy decides (a tool annotated
`readOnlyHint: true` does not ask; an unannotated one does). With approval
modes, every call is asked of Agent Core, which asks the user (`ask`), allows
tools annotated read-only (`readOnly`), or allows all (`auto`). "Allow for this
chat" covers one server and tool only. An unanswered tool question is never
allowed. Annotations are server-supplied; a server that mislabels a write tool
as read-only will have it allowed in `readOnly` and `auto` modes.

## Runtime refresh

`mcpFingerprint` (hash of all `mcp_servers.*` entries) is sent on resume. For an
idle conversation a changed fingerprint reloads the thread, so rotated
credentials, a changed URL or a detached connector apply to the next turn
(tested). While a turn is running the reload is queued until the turn ends, so
an in-flight tool call keeps its connection. A reload runs `initialize` and
`tools/list` again.

## Transports

Streamable HTTP(S) with a static header (none, bearer, or a named header).
Command (stdio) connectors, legacy SSE and MCP OAuth login are not available.
Platform checks every resolved address against private ranges on save and on
each build; the connection itself is made by Codex, which resolves the host
again and has its own redirect handling. Restrict egress from the runtime too.

## Model providers

MCP execution does not depend on the provider. What the model sees does:

- Responses providers receive the namespaces as is.
- Chat, Anthropic and Gemini routes go through `model-gateway`, which flattens
  `mcp__server` + `tool` to `mcp__server__tool` (at most 64 characters; longer
  names get a hash suffix), and puts each namespace description (the server's
  instructions) in the system prompt. `tool_search` and other OpenAI-only tools
  are not offered to those providers.
- Codex defers MCP tools behind `tool_search` only when its model metadata says
  the model supports it. The pinned binary logs "Model metadata for `<model>`
  not found" for custom providers and falls back to metadata without
  `tool_search`, so tools are listed directly.

## Configure `mata-r/btp`

Create it as a tenant or user connector (Connected tools, or `POST /api/mcp`):

```json
{
  "name": "btp",
  "transport": "http",
  "url": "<btp MCP URL>",
  "auth": { "kind": "header", "headerName": "<header the server expects>" },
  "apiKey": "<credential>",
  "capabilities": { "connectTimeoutMs": 30000, "requestTimeoutMs": 120000 }
}
```

Use `{ "kind": "bearer" }` for `Authorization: Bearer`. The URL, header and
credential are not in this repository. Attach it to the agent, then start a new
conversation (or send a message in an idle one to pick up the change).

## Verify parity with standalone Codex

`platform/scripts/diagnose-mcp-parity.ts` records what Codex shows the model for
one server, without calling a model or running a tool, and diffs two records.
Run from the repository root; secrets are read from environment variables.

```sh
# TRUEX path: pinned Codex through BusinessRuntime, platform instruction text
BTP_KEY=… platform/node_modules/.bin/tsx platform/scripts/diagnose-mcp-parity.ts \
  truex --name btp --url <btp MCP URL> --header-env BTP_KEY --header-name <header> \
  --out truex.json

# Standalone path: start the capture endpoint, run your normal Codex with its
# own config.toml (same model, same mcp_servers.btp) against it, then Ctrl-C
platform/node_modules/.bin/tsx platform/scripts/diagnose-mcp-parity.ts serve --out standalone.json
#   codex exec -c model_provider=capture \
#     -c 'model_providers.capture={name="capture",base_url="<printed URL>",wire_api="responses",experimental_bearer_token="probe"}' "List what you can do."

platform/node_modules/.bin/tsx platform/scripts/diagnose-mcp-parity.ts compare truex.json standalone.json
```

The report lists startup status, the server's tools with schema fingerprints, and
the model-facing catalog (namespace description, tool names, descriptions,
schema fingerprints, whether `tool_search` is offered). `compare` separates
differences caused by the MCP server's catalog from host context: model,
reasoning effort, instruction length, other tools. Differing tool choice with a
matching catalog is a model, instruction or tool-set difference, not MCP
transport. Then compare real behavior with read-only prompts; never use a
write or destructive BTP/SAP tool for verification.

Differences to expect between TRUEX and a standalone Codex (observed with the
pinned binary against a local server; the MCP catalogs matched):

| Area | TRUEX | Standalone Codex |
|---|---|---|
| Instructions | Persona, business rules, platform MCP text, agent role | Codex defaults (about 20 KB in the observed run) |
| Other tools | Document, workspace, goal, plan, helper-agent tools; no shell, patch or image tools | Shell, patch, image tools |
| Model | Profile model through the provider or the model gateway | Whatever the CLI is configured with |
| Reasoning, truncation | From the profile and Codex's metadata for the model | From the CLI's configuration |

## Troubleshooting

| Symptom | Check |
|---|---|
| Agent says tools are unavailable | `mcp_servers.<name>` startup status `failed` in the Agent Core log (`mcp server failed to start`, URL removed) or the `mcp.status` event; then URL reachability from the runtime, header name and credential |
| 422 `CONNECTOR_POLICY` | The entry used a key outside the allowed list, or a command |
| 422 `INVALID_MCP_CONFIGURATION` | URL fails the SSRF/HTTPS policy, or invalid name/auth/timeouts |
| `MCP_MIGRATION_REQUIRED` | Agent still lists legacy `mcpProfileIds`; see `MCP_AGENTCORE_FIX.md` |
| Tool call times out | `requestTimeoutMs` on the profile (default 300 s native) |
| Config change not picked up | The conversation is running a turn; it applies once idle |
| Different tool choice than standalone | Run the parity probe; if catalogs match the cause is model, instructions or tool set |
| Large tool results cut off | Codex truncates tool output for the model (fallback metadata: 10,000 bytes); not an MCP error |
