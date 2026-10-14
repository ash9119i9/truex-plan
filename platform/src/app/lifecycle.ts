import type { INestApplication } from "@nestjs/common";
import { Store } from "../persistence/store";
import { PlatformService } from "./platform-service";
import { errorFields, log } from "../../../shared/logging";

export function registerShutdown(
  app: INestApplication,
  service: PlatformService,
  store: Store,
) {
  let stopping = false;

  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      log("info", "platform stopping", { signal });
      service.stop();
      setTimeout(() => {
        log("error", "platform shutdown timed out; forcing exit");
        process.exit(1);
      }, 10000).unref();
      // Stop taking requests before the store they depend on goes away.
      app
        .close()
        .then(() => store.client.close())
        .then(() => process.exit(0))
        .catch((error) => {
          log("error", "platform shutdown failed", errorFields(error));
          process.exit(1);
        });
    });
}
