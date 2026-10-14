import "dotenv/config";
import { log } from "../../shared/logging";
import { createCoreServices } from "./bootstrap/core";
import { registerCoreShutdown } from "./bootstrap/shutdown";
import { createCoreApp } from "./http/app";

const services = createCoreServices();
const app = createCoreApp(services);
const server = app.listen(
  Number(process.env.PORT || 4100),
  process.env.HOST || "127.0.0.1",
  () =>
    log("info", "agent-core listening", {
      port: Number(process.env.PORT || 4100),
    }),
);
registerCoreShutdown(services, server);
