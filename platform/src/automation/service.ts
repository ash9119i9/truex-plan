import { createHash } from "node:crypto";
import type { AutomationRecipe } from "../../../shared/automations";
import { validateAutomationRecipe } from "../../../shared/automations";
import { Store } from "../store";
import { PlatformService } from "../service";
import { ApiError } from "../errors";
import { currentUser } from "../user";
import { currentTenantId } from "../tenant";
import { AutomationStore } from "./store";
import { automationScopeFingerprint } from "./execution";
import { AutomationTemporalClient } from "./temporal";
import { automationRunsCsv } from "./export";
const missing = () =>
  new ApiError(404, "Automation not found", "AUTOMATION_NOT_FOUND");
const owner = () => {
  const user = currentUser();
  if (!user) throw new ApiError(401, "Sign in required", "UNAUTHORIZED");
  return user.id;
};
const versionOf = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new ApiError(400, "A valid version is required", "INVALID_INPUT");
  return value as number;
};
function recipeOf(value: unknown) {
  try {
    return validateAutomationRecipe(value);
  } catch (e) {
    throw new ApiError(400, (e as Error).message, "INVALID_AUTOMATION");
  }
}
function historyFilter(query: Record<string, any>) {
  const filter: Record<string, any> = {};
  if (query.status !== undefined && query.status !== "") {
    if (
      ![
        "accepted",
        "preparing",
        "running",
        "cancellation_requested",
        "succeeded",
        "failed",
        "skipped",
        "cancelled",
        "unknown",
      ].includes(query.status)
    )
      throw new ApiError(400, "Invalid outcome filter", "INVALID_INPUT");
    filter.status = query.status;
  }
  const date: Record<string, string> = {};
  for (const [key, op] of [
    ["from", "$gte"],
    ["to", "$lte"],
  ])
    if (query[key]) {
      if (
        typeof query[key] !== "string" ||
        !Number.isFinite(Date.parse(query[key]))
      )
        throw new ApiError(400, "Invalid date filter", "INVALID_INPUT");
      date[op] = new Date(query[key]).toISOString();
    }
  if (Object.keys(date).length) filter.acceptedAt = date;
  if (query.before) {
    if (typeof query.before !== "string" || !/^run_[\w-]+$/.test(query.before))
      throw new ApiError(400, "Invalid history cursor", "INVALID_INPUT");
  }
  return filter;
}
export class AutomationService {
  readonly db: AutomationStore;
  constructor(
    readonly store: Store,
    readonly platform: PlatformService,
    readonly temporal: AutomationTemporalClient,
  ) {
    this.db = new AutomationStore(store);
  }
  async require(id: string) {
    const d = await this.db.get(id, owner());
    if (!d) throw missing();
    return d;
  }
  private async recipeAccess(recipe: AutomationRecipe) {
    if (recipe.projectId)
      await this.platform.project(recipe.projectId, "write");
    return this.platform.configuration(recipe.agentId, {
      ownerId: owner(),
      use: true,
    });
  }
  async present(d: Awaited<ReturnType<AutomationService["require"]>>) {
    const revision = await this.db.revision(d.id, d.revision);
    const latestRun = await this.db.runs
      .find({ automationId: d.id, ownerId: owner() })
      .sort({ acceptedAt: -1, _id: -1 })
      .limit(1)
      .next();
    const unreadCount = await this.db.runs.countDocuments({
      automationId: d.id,
      ownerId: owner(),
      unread: true,
    });
    return { ...d, recipe: revision!.recipe, latestRun, unreadCount };
  }
  async list() {
    const items = await this.db.definitions
      .find({
        ownerId: owner(),
        tenantId: currentTenantId(),
        status: { $ne: "archived" },
      })
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray();
    return {
      available: true,
      items: await Promise.all(items.map((d) => this.present(d))),
    };
  }
  async get(id: string) {
    return this.present(await this.require(id));
  }
  async create(input: unknown) {
    const recipe = recipeOf(input);
    await this.recipeAccess(recipe);
    const d = await this.db.create(owner(), recipe);
    return this.present(d);
  }
  async edit(id: string, body: any) {
    await this.require(id);
    const recipe = recipeOf(body?.recipe);
    await this.recipeAccess(recipe);
    const d = await this.db.edit(id, owner(), versionOf(body?.version), recipe);
    await this.sync(id).catch(() => undefined);
    return this.present((await this.db.get(id, owner()))!);
  }
  async control(id: string, body: any) {
    const before = await this.require(id),
      action = body?.action;
    if (!["enable", "pause", "resume", "archive"].includes(action))
      throw new ApiError(400, "Invalid control action", "INVALID_INPUT");
    let fingerprint: string | undefined;
    if (action === "enable" || action === "resume") {
      const r = await this.db.revision(id, before.revision);
      fingerprint = automationScopeFingerprint(
        await this.recipeAccess(r!.recipe),
      );
    }
    const d = await this.db.control(
      id,
      owner(),
      versionOf(body?.version),
      action,
      fingerprint,
    );
    await this.sync(id).catch(() => undefined);
    return this.present((await this.db.get(id, owner()))!);
  }
  async preview(body: any) {
    const recipe = recipeOf({
      name: "Preview",
      agentId: "preview",
      prompt: "preview",
      trigger: body?.trigger,
    });
    return {
      times: await this.temporal.preview(recipe.trigger),
      dstPolicy: "native",
    };
  }
  async sync(id: string) {
    const d = await this.db.definitions.findOne({
      _id: id,
      tenantId: currentTenantId(),
    });
    if (!d) throw missing();
    const r = await this.db.revision(id, d.revision);
    if (!r) throw missing();
    try {
      const result = await this.temporal.sync({
        tenantId: d.tenantId,
        automationId: d.id,
        revision: d.revision,
        controlVersion: d.controlVersion,
        enabled: d.status === "enabled",
        trigger: r.recipe.trigger,
      });
      await this.db.definitions.updateOne(
        { _id: id, controlVersion: d.controlVersion },
        {
          $set: {
            syncState:
              result.appliedVersion === d.controlVersion ? "synced" : "pending",
            appliedControlVersion: result.appliedVersion,
            ...(result.nextActionTimes[0] && d.status === "enabled"
              ? { nextScheduledAt: result.nextActionTimes[0] }
              : {}),
          },
          $unset: { syncError: "" },
        },
      );
      await this.db.append({
        id: `${id}:sync:${result.appliedVersion}`,
        automationId: id,
        tenantId: d.tenantId,
        ownerId: d.ownerId,
        type: "automation.sync_applied",
        at: new Date().toISOString(),
        detail: { version: result.appliedVersion },
      });
      if (result.missedCatchupWindow)
        await this.db.append({
          id: `${id}:missed:${result.missedCatchupWindow}`,
          automationId: id,
          tenantId: d.tenantId,
          ownerId: d.ownerId,
          type: "schedule.missed_window",
          at: new Date().toISOString(),
          detail: {
            count: result.missedCatchupWindow,
            reason: "schedule_window_elapsed",
          },
        });
    } catch (error) {
      await this.db.definitions.updateOne(
        { _id: id, controlVersion: d.controlVersion },
        {
          $set: {
            syncState: "error",
            syncError: "Schedule synchronization failed; retrying",
          },
        },
      );
      throw error;
    }
  }
  async runNow(id: string, body: any) {
    const d = await this.require(id),
      requestKey = body?.requestKey;
    if (typeof requestKey !== "string" || !/^[-\w]{1,100}$/.test(requestKey))
      throw new ApiError(
        400,
        "A valid requestKey is required",
        "INVALID_INPUT",
      );
    const prior = await this.db.runs.findOne({
      automationId: id,
      ownerId: owner(),
      requestKey,
    });
    if (prior) {
      if (
        prior.revision !== body?.revision ||
        prior.retryOfRunId !== body?.retryOfRunId
      )
        throw new ApiError(
          409,
          "Request key was used with a different recipe or retry lineage",
          "AUTOMATION_CONFLICT",
        );
      return prior;
    }
    if (d.status !== "enabled" || body?.revision !== d.enabledRevision)
      throw new ApiError(
        409,
        "Review and enable the current revision before running",
        "AUTOMATION_NOT_ENABLED",
      );
    if (
      body.retryOfRunId !== undefined &&
      (typeof body.retryOfRunId !== "string" ||
        !/^run_[\w-]+$/.test(body.retryOfRunId))
    )
      throw new ApiError(400, "A valid retry run is required", "INVALID_INPUT");
    if (body.retryOfRunId) {
      const parent = await this.db.run(body.retryOfRunId, owner());
      if (!parent || parent.automationId !== id || !parent.outcome)
        throw missing();
      if (d.activeRunId)
        throw new ApiError(
          409,
          "Previous execution remains unresolved",
          "AUTOMATION_FENCED",
        );
    }
    const workflowId = `truex-manual:${createHash("sha256").update(`${d.tenantId}:${id}:${owner()}:${requestKey}`).digest("hex")}`;
    const run = await this.db.admit({
      automationId: id,
      revision: d.enabledRevision!,
      source: "manual",
      requestKey,
      workflowId,
      controlVersion: d.controlVersion,
      retryOfRunId: body.retryOfRunId,
    });
    await this.db.append({
      id: `${run.id}:run_now`,
      automationId: id,
      runId: run.id,
      tenantId: d.tenantId,
      ownerId: d.ownerId,
      type: "automation.run_now",
      at: new Date().toISOString(),
      detail: { actor: owner(), revision: run.revision },
    });
    if (!run.outcome)
      await this.temporal
        .start(
          {
            tenantId: d.tenantId,
            automationId: id,
            revision: run.revision,
            controlVersion: d.controlVersion,
            trigger: "manual",
            requestId: requestKey,
            retryOfRunId: body.retryOfRunId,
          },
          workflowId,
        )
        .catch(async () => {
          await this.db.runs.updateOne(
            { _id: run.id },
            { $set: { startPending: true } },
          );
        });
    return run;
  }
  async history(id: string, query: Record<string, any>) {
    await this.require(id);
    const filter = historyFilter(query),
      limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(400, "Invalid page limit", "INVALID_INPUT");
    if (query.before) {
      const prior = await this.db.run(query.before, owner());
      if (!prior || prior.automationId !== id) throw missing();
      filter.$or = [
        { acceptedAt: { $lt: prior.acceptedAt } },
        { acceptedAt: prior.acceptedAt, _id: { $lt: prior.id } },
      ];
    }
    const items = await this.db.runs
      .find({
        automationId: id,
        ownerId: owner(),
        tenantId: currentTenantId(),
        ...filter,
      })
      .sort({ acceptedAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const more = items.length > limit;
    if (more) items.pop();
    return { items, nextCursor: more ? items.at(-1)!.id : undefined };
  }
  async runDetails(id: string, runId: string) {
    await this.require(id);
    const run = await this.db.run(runId, owner());
    if (!run || run.automationId !== id) throw missing();
    const r = await this.db.revision(id, run.revision);
    const output = run.resultRef
      ? await this.store.messages.findOne({
          _id: run.resultRef.id,
          sessionId: run.sessionId,
        })
      : null;
    const session = run.sessionId
      ? await this.store.sessions.findOne({
          _id: run.sessionId,
          userId: owner(),
        })
      : null;
    const eventCount = await this.db.ledger.countDocuments({
      automationId: id,
      runId,
      ownerId: owner(),
    });
    return {
      run: {
        ...run,
        auditComplete:
          run.auditComplete &&
          (!run.auditRetainedUntil ||
            Date.parse(run.auditRetainedUntil) > Date.now()),
      },
      events: await this.db.events(id, owner(), runId),
      eventsTruncated: eventCount > 1000,
      plan: session?.plan,
      recipe: r!.recipe,
      ...(output
        ? { output: { text: output.text, sessionId: run.sessionId } }
        : {}),
    };
  }
  async cancel(id: string, runId: string) {
    await this.require(id);
    const run = await this.db.run(runId, owner());
    if (!run || run.automationId !== id) throw missing();
    if (
      run.stopState === "stopped" ||
      (run.stopState === "not_started" && run.outcome)
    )
      return run;
    const requested = await this.db.transaction(async (session) => {
      const current = await this.db.runs.findOne(
        { _id: runId, automationId: id, ownerId: owner() },
        { session },
      );
      if (!current) throw missing();
      if (
        current.stopState === "stopped" ||
        (current.stopState === "not_started" && current.outcome)
      )
        return false;
      const knownOutcome = current.outcome && current.outcome !== "unknown";
      await this.db.runs.updateOne(
        { _id: runId },
        {
          $set: {
            status: knownOutcome ? current.outcome : "cancellation_requested",
            cancellationRequestedAt: new Date().toISOString(),
            ...(!knownOutcome ? { reason: "user_cancelled" } : {}),
          },
          // Only a new explicit request reopens a prior stop attempt. Background
          // observation sets this flag again before issuing one native interrupt.
          $unset: { stopAttemptedAt: "" },
        },
        { session },
      );
      await this.db.append(
        {
          id: `${run.id}:cancel`,
          automationId: id,
          runId,
          tenantId: run.tenantId,
          ownerId: run.ownerId,
          type: "automation.cancel_requested",
          at: new Date().toISOString(),
          detail: { actor: owner() },
        },
        session,
      );
      return true;
    });
    // Durable intent is also recovered by reconciliation if the workflow has
    // already closed or signaling is temporarily unavailable.
    if (requested)
      await this.temporal.cancel(run.workflowId).catch(() => undefined);
    return (await this.db.run(runId))!;
  }
  async read(id: string, runId: string) {
    await this.require(id);
    await this.db.runs.updateOne(
      { _id: runId, automationId: id, ownerId: owner() },
      { $set: { unread: false } },
    );
    return { ok: true };
  }
  async export(id: string, query: Record<string, any>) {
    await this.require(id);
    const filter = historyFilter(query);
    const runs = await this.db.runs
      .find({
        automationId: id,
        ownerId: owner(),
        tenantId: currentTenantId(),
        ...filter,
      })
      .sort({ acceptedAt: -1, _id: -1 })
      .limit(10000)
      .toArray();
    return automationRunsCsv(runs);
  }
}
