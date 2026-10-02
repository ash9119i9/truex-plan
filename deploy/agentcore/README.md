# AgentCore runtime image

The existing `agent-core/src/index.ts` remains the local HTTP entrypoint on
port 4100. `agent-core/src/agentcore.ts` is the Bedrock AgentCore HTTP
entrypoint on port 8080. Both use the same running local service, so thread,
tool, approval, document, and Codex behavior stays the same. The image also
starts `model-gateway` on loopback port 4200.

## Prebuilt Codex binary

The runtime image uses a prebuilt Codex executable. It builds the Node services
without compiling Rust or requiring a host checkout of `vendor/codex`.

Place these two files from a trusted artifact producer in
`deploy/agentcore/bin/`:

- `codex`: a Linux ARM64 ELF executable that runs on Debian Bookworm.
- `codex.json`: its revision, platform, and SHA-256 checksum:

```json
{
  "revision": "4a942885c8b4745757a9f86ad2075e16c42483c5",
  "platform": "linux/arm64",
  "sha256": "<SHA-256 of the codex executable>"
}
```

The revision must match `codex.lock.json`. The manifest records the producer's
build revision; the producer must establish that the executable came from that
source. A version string alone cannot establish the Git revision. The image
build checks the ELF architecture, manifest revision, and checksum, then runs
`codex --version` as the runtime user to catch incompatible shared libraries.
These local artifact files are ignored by Git.

Validate the artifact from the repository root:

```sh
node deploy/agentcore/verify-binary.mjs \
  deploy/agentcore/bin/codex deploy/agentcore/bin/codex.json codex.lock.json
```

Build the runtime image from the repository root. The builder must support
ARM64, either natively or through an installed emulator:

```sh
docker buildx build --platform linux/arm64 --load \
  -f deploy/agentcore/Dockerfile -t truex-agentcore:local .
```

## Build the Codex artifact once

If no compatible artifact exists, build one with the separate artifact
Dockerfile. It fetches and verifies the exact source in `codex.lock.json`,
compiles the ARM64 release executable, and exports both artifact files:

```sh
docker buildx build --platform linux/arm64 \
  --build-arg CODEX_BUILD_JOBS=1 \
  -f deploy/agentcore/Dockerfile.codex \
  --output type=local,dest=deploy/agentcore/bin .
```

Prefer a native ARM64 builder for compilation. Increase `CODEX_BUILD_JOBS`
when the builder has enough memory. Keep the resulting executable and manifest
in artifact storage and reuse them for application image builds. Rebuild the
artifact when the pinned Codex revision changes.

The artifact builder installs the Rust toolchain in its own cached layer and
uses persistent BuildKit cache mounts for Cargo downloads, Git dependencies,
and compilation output. Retries on the same builder can reuse that work after
an interrupted compilation. Keep the same Docker builder and avoid pruning its
cache while building. Cache eviction or moving to another builder can still
require a full compilation. An already running build uses the Dockerfile it
loaded at startup; this change applies to the next build invocation.

The finished executable is copied out of the compilation cache before export,
so both artifact files are available in `deploy/agentcore/bin/` only after the
artifact build completes successfully. Application image builds then use
`deploy/agentcore/Dockerfile` to reuse the artifact.

For an executable from an existing trusted build of the pinned revision, copy
it to `deploy/agentcore/bin/codex` and generate the sidecar once:

```sh
node deploy/agentcore/verify-binary.mjs --write-manifest \
  deploy/agentcore/bin/codex deploy/agentcore/bin/codex.json codex.lock.json
```

This records the supplied lock revision; it cannot determine the source
revision from an arbitrary executable. The binary must already have a known
build origin. If an image build is already compiling the required ARM64 Codex,
let it finish unless you have a verified replacement artifact ready. Removing
the compile stage does not provide that artifact.

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
