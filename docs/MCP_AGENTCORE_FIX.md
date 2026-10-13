# MCP deployment and recovery

The platform resolves MCP profiles from MongoDB and sends `mcp_servers.*` in
the AgentCore invocation body. Deploying MCP routing code to AgentCore does
not attach a server or migrate the platform database. The runtime image does
not read the repository's `mcps.json` or `agent.json` examples.

## Missing tools from legacy attachments

Legacy configuration stores attachments in `agent.mcpProfileIds`. Current
configuration requires `truex_mcp.scope` and `truex_mcp.agentIds`. An enabled
unscoped profile is excluded from runtime configuration. The platform now
reports `MCP_MIGRATION_REQUIRED` when an agent still references such a profile.

Use the existing migration; do not add a runtime fallback that bypasses MCP
ownership. The migration assigns tenant scope to ownerless profiles, user
scope to owned profiles, moves attachments to `agentIds`, encrypts plain API
keys, and builds indexes. Old agent references remain but do not authorize
connections. Duplicate names are reported and left unscoped until resolved.

## Rollout

1. Back up each affected tenant database and retain its MCP encryption key.
   Confirm that the platform's `MONGO_URI`, `MONGO_DB`, and `CATALOG_MONGO_DB`
   name the intended deployment. Keep `MCP_ENCRYPTION_KEY` stable across
   restarts: it must be 32 bytes encoded as base64. An existing encrypted
   database requires its existing key, including any configured rotation keys.
2. Install dependencies and build this branch on the EC2 platform host:

   ```sh
   npm run install:all
   npm run build
   npm run migrate:mcp-scopes
   ```

   The migration defaults to a dry run and reads `platform/.env`. Inspect its
   scope, attachment, encryption, and duplicate-name report. Resolve duplicate
   names and missing key configuration before applying it.
3. Apply the reviewed migration on that host:

   ```sh
   npm run migrate:mcp-scopes -- --confirm migrate-mcp-scopes
   npm run migrate:mcp-scopes
   ```

   Require an exit code of zero. A duplicate-name error can accompany partial
   progress; correct the names and rerun. The migration is idempotent. The
   follow-up dry run should report no outstanding scope, attachment, or key
   changes. Never copy the placeholder credential from `mcps.json` into a
   real database; use Connected tools to save the current credential.
4. Run the platform from this branch. Build and deploy the AgentCore image
   from the same branch using the existing deployment workflow. MCP needs no
   runtime setting: Codex connects to the configured servers itself. See
   [MCP](MCP.md).
5. Check Connected tools for the intended agent and tenant. Start a new chat
   and ask a read-only question that needs the connector. Verify that a tool
   call and its result appear in the chat. The MCP HTTP endpoint must be
   reachable from AgentCore, and the configured auth header must match the
   server. A health smoke test alone does not prove tool execution.

No deployed data or services are changed by checking out this branch. Roll
back application code independently; recovering the database requires its
backup and matching encryption keys. Retain both until verification finishes.

## Validation

The regression test reproduces silent omission before the guard and checks
that migration is required, disabled profiles remain excluded, migrated
attachments load, detachment works despite retained legacy references, and
another owner's tools remain inaccessible. The migration integration test
checks that migrated ObjectId references and decrypted Qlik/custom-header and
bearer credentials reach the platform's runtime configuration. Existing
runtime tests execute tools with the pinned binary, including approval,
denial, credential rotation and timeouts.

When running platform integration tests in a workspace with a deployment
`.env`, use `DOTENV_CONFIG_PATH=/dev/null` so test child processes use their
fixture settings. Otherwise local demo admission and `AGENTCORE_RUNTIME_ARN`
can override the test's intended local runtime and authentication setup.

The repository-wide `npm run format:check` currently reports 52 existing
files. The changed service and new regression test pass Prettier checks;
unrelated files retain their formatting.
