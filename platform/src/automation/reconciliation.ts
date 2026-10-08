import { Store } from "../store";
import { PlatformService } from "../service";
import { AutomationService } from "./service";
import { AutomationTemporalClient } from "./temporal";
import { AutomationExecution } from "./execution";
import { withAutomationOwner } from "./activities";
import { tenantContext, policyOf, type TenantRef } from "../tenant";
import { errorFields, log } from "../../../shared/logging";

/** This loop repairs persisted intents and observations; Temporal alone owns recurrence. */
export async function reconcileAutomations(
  store: Store,
  platform: PlatformService,
  temporal: AutomationTemporalClient,
) {
  const result = {
    definitions: 0,
    pendingStarts: 0,
    unknownRuns: 0,
    failures: 0,
  };
  const tenants = new Map<string, TenantRef>(
    (await store.activeTenants()).map((tenant) => [tenant.id, tenant]),
  );
  const disabled = new Set<string>();
  // Disabled owners cannot dispatch, but their already-started executions still need evidence recovery.
  for await (const tenant of store.tenantRegistry.find({
    status: "disabled",
  })) {
    disabled.add(tenant._id);
    tenants.set(tenant._id, {
      id: tenant._id,
      dbName: tenant.dbName,
      allowedModelIds: tenant.allowedModelIds,
      allowedSkillIds: tenant.allowedSkillIds,
      ...policyOf(tenant),
    });
  }
  for (const tenant of tenants.values())
    await tenantContext.run(tenant, async () => {
      const service = new AutomationService(store, platform, temporal);
      for await (const definition of service.db.definitions.find({})) {
        try {
          if (!disabled.has(tenant.id)) {
            try {
              await service.sync(definition.id);
              result.definitions++;
            } catch (error) {
              result.failures++;
              log("warn", "automation schedule reconciliation failed", {
                tenantId: tenant.id,
                automationId: definition.id,
                ...errorFields(error),
              });
            }
          }
          for await (const run of service.db.runs.find({
            automationId: definition.id,
            $or: [
              { status: "accepted" },
              { startPending: true },
              { outcome: "unknown" },
              { status: "cancellation_requested" },
              { stopState: { $in: ["unknown", "stop_requested"] } },
            ],
          })) {
            if (
              run.outcome === "unknown" ||
              run.status === "cancellation_requested" ||
              run.stopState === "unknown" ||
              run.stopState === "stop_requested"
            ) {
              result.unknownRuns++;
              await withAutomationOwner(store, tenant.id, definition.id, (db) =>
                new AutomationExecution(db, platform).observe(run.id),
              );
            } else if (
              !disabled.has(tenant.id) &&
              !run.dispatchState &&
              run.source === "manual"
            ) {
              await temporal.start(
                {
                  tenantId: tenant.id,
                  automationId: definition.id,
                  revision: run.revision,
                  controlVersion: run.controlVersion,
                  trigger: "manual",
                  requestId: run.requestKey,
                  retryOfRunId: run.retryOfRunId,
                },
                run.workflowId,
              );
              await service.db.runs.updateOne(
                { _id: run.id },
                { $unset: { startPending: "" } },
              );
              result.pendingStarts++;
            }
          }
        } catch (error) {
          result.failures++;
          log("warn", "automation reconciliation failed", {
            tenantId: tenant.id,
            automationId: definition.id,
            ...errorFields(error),
          });
        }
      }
    });
  return result;
}
