import {
  tenantContext,
  currentTenant,
  policyOf,
  DEFAULT_TENANT_ID,
  type TenantRef,
} from "../tenant";
import { userContext, currentUser } from "../user";
import { ApiError } from "../errors";
import { Store } from "../store";
import { PlatformService } from "../service";
import { AutomationStore } from "./store";
import { AutomationExecution } from "./execution";
import type { AutomationActivities, AutomationRunReference } from "./workflows";
import { activityInfo, type Info } from "@temporalio/activity";
import { createHash } from "node:crypto";

type ActivityAttempt = Pick<
  Info,
  "activityId" | "attempt" | "workflowExecution"
>;

/** Resolve registry and stored owner inside Activities; caller never supplies credentials. */
export async function withAutomationOwner<T>(
  store: Store,
  tenantId: string,
  automationId: string,
  work: (db: AutomationStore, permitted: boolean) => Promise<T>,
): Promise<T> {
  const registry = await store.tenantRegistry.findOne({ _id: tenantId });
  if (
    !registry &&
    (tenantId !== DEFAULT_TENANT_ID || process.env.AUTH_MODE === "google")
  )
    throw new ApiError(403, "Workspace access ended", "ACCESS_REVOKED");
  const tenant: TenantRef = registry
    ? {
        id: registry._id,
        dbName: registry.dbName,
        allowedModelIds: registry.allowedModelIds,
        allowedSkillIds: registry.allowedSkillIds,
        ...policyOf(registry),
      }
    : { id: DEFAULT_TENANT_ID, dbName: store.database };
  return tenantContext.run(tenant, async () => {
    const db = new AutomationStore(store);
    const definition = await db.definitions.findOne({
      _id: automationId,
      tenantId,
    });
    if (!definition)
      throw new ApiError(404, "Automation not found", "AUTOMATION_NOT_FOUND");
    let permitted = registry?.status !== "disabled",
      role: "user" | "admin" = "user",
      email = `${definition.ownerId}@dev.local`;
    if (process.env.AUTH_MODE === "google") {
      const [account, membership] = await Promise.all([
        store.users.findOne({ _id: definition.ownerId, status: "active" }),
        store.memberships.findOne({
          userId: definition.ownerId,
          tenantId,
          status: "active",
        }),
      ]);
      permitted &&= !!account && !!membership;
      role = membership?.role ?? "user";
      email = account?.email ?? email;
    }
    return userContext.run({ id: definition.ownerId, email, role }, () =>
      work(db, permitted),
    );
  });
}
async function recheckAutomationOwner(store: Store) {
  const tenant = currentTenant(),
    user = currentUser();
  if (!tenant || !user)
    throw new ApiError(
      403,
      "Automation owner context is missing",
      "ACCESS_REVOKED",
    );
  await store.resolveTenant(tenant.id, { fresh: true });
  if (process.env.AUTH_MODE === "google") {
    const [account, membership] = await Promise.all([
      store.users.findOne({ _id: user.id, status: "active" }),
      store.memberships.findOne({
        userId: user.id,
        tenantId: tenant.id,
        status: "active",
      }),
    ]);
    if (!account || !membership)
      throw new ApiError(403, "Owner workspace access ended", "ACCESS_REVOKED");
  }
}
export function createAutomationActivities(
  store: Store,
  platform: PlatformService,
  readActivityInfo: () => ActivityAttempt = activityInfo,
): AutomationActivities {
  const recordAttempt = async (
    db: AutomationStore,
    runId: string,
    operation: keyof AutomationActivities,
  ) => {
    const info = readActivityInfo(),
      workflowRunId = info.workflowExecution?.runId;
    if (
      !workflowRunId ||
      !Number.isSafeInteger(info.attempt) ||
      info.attempt < 1
    )
      throw new Error(
        "Automation Activity has no valid native attempt identity",
      );
    const run = await db.run(runId, currentUser()!.id);
    if (!run)
      throw new ApiError(
        404,
        "Automation run not found",
        "AUTOMATION_NOT_FOUND",
      );
    const identifier = (value: string) =>
      /^[\w:./-]{1,200}$/.test(value)
        ? value
        : `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const identity = createHash("sha256")
      .update(JSON.stringify([workflowRunId, info.activityId]))
      .digest("hex");
    try {
      await db.append({
        id: `${run.id}:activity:${identity}:${info.attempt}`,
        automationId: run.automationId,
        runId: run.id,
        tenantId: run.tenantId,
        ownerId: run.ownerId,
        type: "activity.attempt",
        at: new Date().toISOString(),
        detail: {
          operation,
          activityId: identifier(info.activityId),
          workflowRunId: identifier(workflowRunId),
          attempt: info.attempt,
          phase: "started",
        },
      });
    } catch (error) {
      // A later native attempt cannot reconstruct this missing attempt receipt.
      await db
        .transaction(async (transaction) => {
          await db.runs.updateOne(
            { _id: run.id, tenantId: run.tenantId },
            { $set: { auditComplete: false, auditLost: true } },
            { session: transaction },
          );
          await db.definitions.updateOne(
            { _id: run.automationId, tenantId: run.tenantId },
            { $set: { auditBlocked: true } },
            { session: transaction },
          );
        })
        .catch(() => undefined);
      throw error;
    }
  };
  const owner = <T>(
    input: { tenantId: string; automationId: string },
    work: (
      db: AutomationStore,
      execution: AutomationExecution,
      permitted: boolean,
    ) => Promise<T>,
  ) =>
    withAutomationOwner(
      store,
      input.tenantId,
      input.automationId,
      (db, permitted) =>
        work(
          db,
          new AutomationExecution(db, platform, () =>
            recheckAutomationOwner(store),
          ),
          permitted,
        ),
    );
  return {
    admitOccurrence: (input) =>
      owner(input, async (db) => {
        const run = await db.admit({
          automationId: input.automationId,
          revision: input.revision,
          source: input.trigger,
          requestKey: input.requestId ?? input.workflowId,
          workflowId: input.workflowId,
          workflowRunId: input.workflowRunId,
          controlVersion: input.controlVersion,
          scheduledAt: input.scheduledAt,
          retryOfRunId: input.retryOfRunId,
        });
        await recordAttempt(db, run.id, "admitOccurrence");
        if (run.outcome && run.outcome !== "unknown") return null;
        const revision = await db.revision(run.automationId, run.revision);
        await db.runs.updateOne(
          { _id: run.id, executionDeadlineAt: { $exists: false } },
          {
            $set: {
              executionDeadlineAt: new Date(
                Date.now() + revision!.recipe.limits.executionTimeoutMs,
              ).toISOString(),
            },
          },
        );
        return {
          runId: run.id,
          executionTimeoutMs: revision!.recipe.limits.executionTimeoutMs,
        };
      }),
    dispatchRun: (input) =>
      owner(input, async (db, execution, permitted) => {
        await recordAttempt(db, input.runId, "dispatchRun");
        if (!permitted) {
          const existing = await db.run(input.runId);
          if (existing?.dispatchState || existing?.outcome === "unknown") {
            await execution.observe(input.runId);
            return;
          }
          await db.finish(input.runId, {
            status: "failed",
            outcome: "failed",
            reason: "access_revoked",
            stopState: "not_started",
          });
          return;
        }
        await execution.dispatch(input.runId);
      }),
    observeRun: (input) =>
      owner(input, async (db, execution) => {
        await recordAttempt(db, input.runId, "observeRun");
        return execution.observe(input.runId);
      }),
    stopRun: (input) =>
      owner(input, async (db, execution) => {
        let auditError: unknown;
        try {
          await recordAttempt(db, input.runId, "stopRun");
        } catch (error) {
          auditError = error;
        }
        await execution.stop(
          input.runId,
          input.reason === "cancelled"
            ? "user_cancelled"
            : input.reason === "execution_timeout"
              ? "execution_timeout"
              : "runtime_failure",
        );
        if (auditError) throw auditError;
      }),
  };
}
