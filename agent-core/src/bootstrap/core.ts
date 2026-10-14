import { join, resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { log } from "../../../shared/logging";
import { BusinessRuntime } from "../runtime/business-runtime";
import { ThreadManager } from "../threads/manager";
import { startWorkspaceSweeper } from "../tools/workspace/sweeper";

export function createCoreServices() {
  const root = resolve(process.env.PROJECT_ROOT || "..");
  const pin = JSON.parse(readFileSync(join(root, "codex.lock.json"), "utf8"));
  const binary = resolve(root, pin.binary);
  // No PATH lookup or external CODEX_BIN override: runtime must be the project pin.
  const home = join(
    resolve(process.env.CODEX_HOME || join(root, ".runtime/codex")),
    "business-v1",
  );
  mkdirSync(home, { recursive: true });
  mkdirSync(
    resolve(process.env.AGENT_WORKSPACE || join(root, ".runtime/workspace")),
    { recursive: true },
  );
  const client = new BusinessRuntime(
    binary,
    home,
    Number(process.env.RPC_TIMEOUT_MS || 30000),
  );
  const manager = new ThreadManager(
    client,
    home,
    Number(process.env.MAX_THREADS || 20),
    Number(process.env.REPLAY_LIMIT || 500),
    Number(process.env.REQUEST_TIMEOUT_MS || 120000),
  );
  const stopSweeper = startWorkspaceSweeper(join(home, "business-workspaces"));
  client.on("diagnostic", (line) =>
    log("debug", "codex runtime stderr", {
      line: manager.redactor.clean(line),
    }),
  );
  client.on("protocolError", (message) =>
    log("warn", "codex protocol error", { error: message }),
  );
  return { client, manager, home, pin, stopSweeper };
}
