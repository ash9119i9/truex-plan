import { createAgentCoreBridge } from "./agentcore/bridge";
import { ConfigError, loadConfig, type AdapterConfig } from "./config";
import { RuntimeManager } from "./runtime/manager";
import { createAdapterServer } from "./server";

// Structured one-line logs. Fields are identifiers, codes and timings only;
// message text, prompts and tokens are never logged.
function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
  );
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  if (config.mode === "agentcore") return runAgentCore(config);

  const manager = new RuntimeManager(config, log);
  const server = createAdapterServer({
    token: config.token,
    limits: config.limits,
    manager,
    stateDir: config.stateDir,
    log,
    allowLoopbackMcp: config.allowLoopbackMcp,
  });
  server.listen(config.port, config.host, () =>
    log("listening", { host: config.host, port: config.port }),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("draining", { signal, ...manager.stats });
    await manager.drain(config.drainMs);
    server.close();
    server.closeAllConnections();
    log("stopped", {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// RUNTIME_MODE=agentcore: the AgentCore contract on HOST:PORT; the adapter
// starts behind it on the first invocation (src/agentcore/bridge.ts).
function runAgentCore(config: AdapterConfig): void {
  const bridge = createAgentCoreBridge(config, log);
  bridge.server.listen(config.port, config.host, () =>
    log("listening", {
      mode: "agentcore",
      host: config.host,
      port: config.port,
    }),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("draining", { signal, ...bridge.stats });
    await bridge.shutdown();
    log("stopped", {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
