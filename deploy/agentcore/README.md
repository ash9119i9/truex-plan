# AgentCore runtime image

The existing `agent-core/src/index.ts` remains the local HTTP entrypoint on
port 4100. `agent-core/src/agentcore.ts` is the Bedrock AgentCore HTTP
entrypoint on port 8080. Both use the same running local service, so thread,
tool, approval, document, and Codex behavior stays the same. The image also
starts `model-gateway` on loopback port 4200.

Build from the repository root after `npm run codex:setup` has fetched and
verified the pinned source. The builder must support ARM64, either natively or
through an installed emulator:

```sh
docker buildx build --platform linux/arm64 --load \
  -f deploy/agentcore/Dockerfile -t truex-agentcore:local .
```

The runtime needs `MODEL_GATEWAY_SECRET` (at least 32 characters), `MONGO_URI`,
`CATALOG_MONGO_DB`, and network access to the model providers and MongoDB. A
model profile that stores `apiKeySecretArn` also needs an execution role with
`secretsmanager:GetSecretValue` for that secret. Set `MODEL_GATEWAY_URL` in the
platform to `http://127.0.0.1:4200`; the platform passes that URL to Codex,
which resolves it inside the AgentCore container. The platform does not need
to connect to that localhost address itself.

Mount persistent storage at `/data` for Codex history, thread markers,
documents, workspaces, and durable event records. Reuse one AgentCore
`runtimeSessionId` for all requests in a conversation. AgentCore's default
container filesystem is ephemeral; session storage and other filesystem
options are described in the [AWS documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html).

## Invocation contract

Send JSON to `POST /invocations` through `InvokeAgentRuntime`:

```json
{
  "method": "POST",
  "path": "/threads",
  "body": { "model": "...", "modelProvider": "...", "config": {} }
}
```

The adapter allows the same thread routes that the local service exposes. An
optional `requestId` field forwards the platform's request ID to that service.
For JSON responses it returns `{ "status": 201, "body": { ... } }`; `status`
is the local service's HTTP status. This envelope preserves application errors
without AgentCore rewriting them. For an event subscription, send:

```json
{
  "method": "GET",
  "path": "/threads/<thread-id>/events",
  "cursor": "<last-event-id>"
}
```

That invocation streams the local SSE frames directly. The adapter closes a
stream after 55 minutes so the caller can reconnect with the last event ID,
within AgentCore's [streaming duration limit](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html).
`GET /ping` checks both internal services and returns `HealthyBusy` while a
turn is running. Only port 8080 is exposed to AgentCore. The platform needs
an `InvokeAgentRuntime` transport and stable session IDs before this image can
serve the deployed application.
