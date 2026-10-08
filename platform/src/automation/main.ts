import "reflect-metadata";
import "dotenv/config";
import { Client, Connection } from "@temporalio/client";
import { authMode } from "../user";
import { Store } from "../store";
import { PlatformService } from "../service";
import { errorFields, log } from "../../../shared/logging";
import { createAutomationActivities } from "./activities";
import { temporalSettings } from "./connection";
import { reconcileAutomations } from "./reconciliation";
import { AutomationTemporalClient } from "./temporal";
import { createAutomationWorker } from "./worker";

export async function runAutomationWorker(): Promise<void> {
  if (process.env.AUTOMATIONS_ENABLED !== "on")
    throw new Error("Automation worker requires AUTOMATIONS_ENABLED=on");
  const mode = authMode();
  if (
    process.env.NODE_ENV === "production" &&
    mode === "dev" &&
    process.env.ALLOW_DEV_TENANT !== "on"
  )
    throw new Error(
      "Production automation worker cannot use implicit development authorization",
    );
  const settings = await temporalSettings();
  const store = new Store();
  let platform: PlatformService | undefined;
  let connection: Connection | undefined;
  let resources: Awaited<ReturnType<typeof createAutomationWorker>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciliation: Promise<unknown> | undefined;
  const shutdown = () => {
    if (timer) clearInterval(timer);
    resources?.worker.shutdown();
  };
  try {
    await store.connect();
    if (!(await store.supportsTransactions()))
      throw new Error("Automations require MongoDB replica-set transactions");
    platform = new PlatformService(store);
    connection = await Connection.connect(settings.connection);
    const temporal = new AutomationTemporalClient(
      new Client({ connection, namespace: settings.namespace }),
      settings.taskQueue,
    );
    resources = await createAutomationWorker({
      ...settings,
      activities: createAutomationActivities(store, platform),
    });
    // The runtime evidence path persists before acknowledgment independently of browsers.
    platform.startIngestion();
    const reconcile = () => {
      if (!reconciliation)
        reconciliation = reconcileAutomations(store, platform!, temporal)
          .then((result) =>
            log("info", "automation reconciliation completed", result),
          )
          .catch((error) =>
            log(
              "error",
              "automation reconciliation failed",
              errorFields(error),
            ),
          )
          .finally(() => {
            reconciliation = undefined;
          });
    };
    reconcile();
    timer = setInterval(reconcile, 10_000);
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    log("info", "automation worker started", {
      namespace: settings.namespace,
      taskQueue: settings.taskQueue,
    });
    await resources.worker.run();
  } finally {
    if (timer) clearInterval(timer);
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    await reconciliation;
    platform?.stop();
    await resources?.close();
    await connection?.close();
    await store.client.close();
  }
}
if (require.main === module)
  void runAutomationWorker().catch((error) => {
    log("error", "automation worker stopped", errorFields(error));
    process.exitCode = 1;
  });
