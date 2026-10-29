import { MongoClient } from "mongodb";
import {
  createSecretResolver,
  loadEgressConfig,
  loadTokenKeys,
} from "./config";
import { createCredentials } from "./credentials";
import { createArgumentChecker } from "./arguments";
import { createEgress } from "./egress";
import { connectorsIn, createRefreshGrant } from "./refresh-grant";
import { createCallerResolver } from "./revocation";
import { createMcpGateway } from "./server";

// The MCP gateway is its own service with its own secrets. It shares with the
// platform MCP_CALLER_TOKEN_SECRET (the platform signs caller tokens), the
// connector token keys (MCP_TOKEN_KEYS, until only the gateway holds them:
// tasks/mcp-gateway-todo.md, Task 34), and the records the revocation check
// and refresh read. Configuration comes from the environment (`.env` in dev,
// via --env-file-if-exists).

const problems: string[] = [];
const secret = process.env.MCP_CALLER_TOKEN_SECRET ?? "";
if (secret.length < 32)
  problems.push("MCP_CALLER_TOKEN_SECRET must be at least 32 characters.");
const mongoUri = process.env.MONGODB_URI ?? "";
if (!mongoUri) problems.push("MONGODB_URI is required.");
// The platform's catalog database (platform-next CATALOG_DB_NAME).
const catalogDbName = process.env.CATALOG_DB_NAME ?? "";
if (!/^truex_next_[a-z0-9_]{1,52}$/.test(catalogDbName))
  problems.push(
    'CATALOG_DB_NAME must start with "truex_next_" and use only lowercase letters, digits and underscores.',
  );
const keys = loadTokenKeys(process.env, problems);
// Loopback http servers, for fixtures in local dev only (config.ts).
const egressConfig = loadEgressConfig(process.env, problems);
const port = Number(process.env.PORT ?? 4300);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  problems.push("PORT must be an integer from 1 to 65535.");
if (problems.length > 0 || !keys) {
  console.error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

// A short server-selection timeout: an unreachable database answers callers
// with a 503 quickly instead of holding their tool calls.
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });

// One JSON line per event on stdout (CloudWatch). Fields never carry tokens
// or message bodies (server.ts).
function log(event: string, fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event, ...fields }),
  );
}

async function main() {
  await client.connect();
  const egress = createEgress(egressConfig);
  const credentials = createCredentials({
    client,
    keys: keys!,
    refresh: createRefreshGrant({
      findConnector: connectorsIn(client.db(catalogDbName)),
      resolveSecret: createSecretResolver(),
      egress,
    }),
    log,
  });
  const server = createMcpGateway({
    secret,
    resolveCaller: createCallerResolver(client, catalogDbName),
    credentials,
    egress,
    // Reviewed definitions shared by every gateway instance, keyed by hash.
    argumentChecker: createArgumentChecker({
      definitions: client
        .db(catalogDbName)
        .collection("truex_mcp_tool_definitions"),
      log,
    }),
    log,
  });
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () =>
    console.log(`mcp-gateway listening on ${host}:${port}`),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Open streams end with the process; Codex retries a dropped MCP stream.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  console.error(
    `mcp-gateway failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
