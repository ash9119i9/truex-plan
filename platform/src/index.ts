import "reflect-metadata";
import "dotenv/config";
import { errorFields, log } from "../../shared/logging";
import { main } from "./app/bootstrap";

process.on("unhandledRejection", (reason) =>
  log("error", "unhandled rejection", errorFields(reason)),
);
process.on("uncaughtException", (error) => {
  log("error", "uncaught exception", errorFields(error));
  process.exit(1);
});
main().catch((error) => {
  log("error", "platform failed to start", errorFields(error));
  process.exit(1);
});
