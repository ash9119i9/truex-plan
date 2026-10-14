import "dotenv/config";
import { log } from "../../shared/logging";
import { AgentCoreServices } from "./agentcore/services";
import { createAgentCoreApp } from "./agentcore/app";

export { createAgentCoreApp, type AgentCoreOptions } from "./agentcore/app";

if (require.main === module) {
  const services = new AgentCoreServices();
  const port = Number(process.env.PORT || 8080);
  const server = createAgentCoreApp({
    ensureServices: () => services.start(),
    serviceState: () => services.state,
  }).listen(port, process.env.HOST || "0.0.0.0", () =>
    log("info", "AgentCore entrypoint listening", { port }),
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await services.stop();
      server.closeAllConnections();
      process.exit(0);
    });
}
