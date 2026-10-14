import type { Server } from "node:http";
import { errorFields, log } from "../../../shared/logging";
import type { createCoreServices } from "./core";

export function registerCoreShutdown(
  { manager, client, stopSweeper }: ReturnType<typeof createCoreServices>,
  server: Server,
) {
  process.on("unhandledRejection", (reason) =>
    log("error", "unhandled rejection", errorFields(reason)),
  );
  process.on("uncaughtException", (error) => {
    log("error", "uncaught exception", errorFields(error));
    process.exit(1);
  });
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      manager.draining = true;
      const deadline =
        Date.now() + Number(process.env.DRAIN_TIMEOUT_MS || 30000);
      while (
        [...manager.threads.values()].some((t) => t.state.kind !== "idle") &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 100));
      stopSweeper();
      manager.close();
      client.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    });
}
