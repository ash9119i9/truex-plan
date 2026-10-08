import { randomUUID } from "node:crypto";
import type { ClientSession, Document } from "mongodb";
import type {
  AutomationDefinition,
  AutomationRevision,
  AutomationRun,
} from "../../../shared/automations";
import { validateAutomationRecipe } from "../../../shared/automations";
import { Store } from "../store";
import { currentTenantId } from "../tenant";
import { ApiError } from "../errors";
type Definition = AutomationDefinition & {
  _id: string;
  activeRunId?: string;
  syncError?: string;
  reviewedScopeFingerprint?: string;
  auditBlocked?: boolean;
};
type Revision = AutomationRevision & { _id: string };
export type Run = AutomationRun & {
  _id: string;
  dispatchState?: "claimed" | "accepted";
  provisionState?: "claimed" | "accepted";
  runtimeTerminal?: string;
  resultSeen?: boolean;
  blocker?: string;
  cancellationRequestedAt?: string;
  unread?: boolean;
  controlVersion: number;
  workflowRunId?: string;
  startPending?: boolean;
  helperEscaped?: boolean;
  resultWaitStartedAt?: string;
  stopAttemptedAt?: string;
  auditLost?: boolean;
  auditRecoveryPending?: boolean;
  executionDeadlineAt?: string;
  runtimeHost?: string;
  runtimeSessionId?: string;
  auditRetainedUntil?: string;
};
export interface LedgerEvent extends Document {
  _id: string;
  id: string;
  automationId: string;
  runId?: string;
  tenantId: string;
  ownerId: string;
  type: string;
  at: string;
  persistedAt: string;
  detail?: Record<string, string | number | boolean>;
}
export interface Admission {
  automationId: string;
  revision: number;
  source: "manual" | "scheduled";
  requestKey: string;
  workflowId: string;
  workflowRunId?: string;
  controlVersion?: number;
  scheduledAt?: string;
  retryOfRunId?: string;
}
const SAFE_DETAIL = new Set([
  "actor",
  "version",
  "revision",
  "status",
  "reason",
  "stopState",
  "attempt",
  "activityId",
  "workflowRunId",
  "tool",
  "phase",
  "effect",
  "method",
  "requestKind",
  "resultRef",
  "sessionId",
  "turnId",
  "lagMs",
  "durationMs",
  "count",
  "from",
  "to",
  "source",
  "auditComplete",
  "operation",
  "model",
  "configurationFingerprint",
]);
const now = () => new Date().toISOString();
const conflict = () =>
  new ApiError(
    409,
    "Automation changed; reload before applying this action",
    "AUTOMATION_CONFLICT",
  );
export class AutomationStore {
  constructor(readonly store: Store) {}
  get definitions() {
    return this.store.db.collection<Definition>("automations");
  }
  get revisions() {
    return this.store.db.collection<Revision>("automation_revisions");
  }
  get runs() {
    return this.store.db.collection<Run>("automation_runs");
  }
  get ledger() {
    return this.store.db.collection<LedgerEvent>("automation_events");
  }
  private ready = new Map<string, Promise<unknown>>();
  async indexes() {
    const key = this.store.db.databaseName;
    if (!this.ready.has(key))
      this.ready.set(
        key,
        Promise.all([
          this.definitions.createIndex({ ownerId: 1, updatedAt: -1 }),
          this.revisions.createIndex(
            { automationId: 1, revision: 1 },
            { unique: true },
          ),
          this.runs.createIndex(
            { automationId: 1, requestKey: 1 },
            { unique: true },
          ),
          this.runs.createIndex({ ownerId: 1, acceptedAt: -1, id: -1 }),
          this.runs.createIndex({ sessionId: 1 }),
          this.ledger.createIndex({ automationId: 1, runId: 1, at: 1 }),
          this.ledger.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        ]).catch((error) => {
          this.ready.delete(key);
          throw error;
        }),
      );
    await this.ready.get(key);
  }
  async transaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    await this.indexes();
    return this.store.client.withSession((session) =>
      session.withTransaction(() => work(session)),
    ) as Promise<T>;
  }
  async get(id: string, ownerId: string) {
    return this.definitions.findOne({
      _id: id,
      ownerId,
      tenantId: currentTenantId(),
    });
  }
  async revision(id: string, revision: number) {
    return this.revisions.findOne({
      automationId: id,
      revision,
      tenantId: currentTenantId(),
    });
  }
  async run(id: string, ownerId?: string) {
    return this.runs.findOne({
      _id: id,
      tenantId: currentTenantId(),
      ...(ownerId ? { ownerId } : {}),
    });
  }
  async create(ownerId: string, input: unknown) {
    const recipe = validateAutomationRecipe(input),
      id = `auto_${randomUUID()}`,
      at = now(),
      tenantId = currentTenantId();
    const definition: Definition = {
      _id: id,
      id,
      tenantId,
      ownerId,
      revision: 1,
      status: "draft",
      controlVersion: 1,
      syncState: "pending",
      createdAt: at,
      updatedAt: at,
    };
    await this.transaction(async (session) => {
      await this.definitions.insertOne(definition, { session });
      await this.revisions.insertOne(
        {
          _id: `${id}:1`,
          id: `${id}:1`,
          automationId: id,
          tenantId,
          ownerId,
          revision: 1,
          recipe,
          createdAt: at,
          createdBy: ownerId,
        },
        { session },
      );
      await this.append(
        {
          id: `${id}:created`,
          automationId: id,
          tenantId,
          ownerId,
          type: "automation.created",
          at,
          detail: { actor: ownerId, version: 1 },
        },
        session,
      );
    });
    return definition;
  }
  async edit(id: string, ownerId: string, version: number, input: unknown) {
    const recipe = validateAutomationRecipe(input);
    return this.transaction(async (session) => {
      const current = await this.definitions.findOne(
        {
          _id: id,
          ownerId,
          tenantId: currentTenantId(),
          controlVersion: version,
          status: { $ne: "archived" },
        },
        { session },
      );
      if (!current) throw conflict();
      const revision = current.revision + 1,
        at = now();
      await this.revisions.insertOne(
        {
          _id: `${id}:${revision}`,
          id: `${id}:${revision}`,
          automationId: id,
          tenantId: current.tenantId,
          ownerId,
          revision,
          recipe,
          createdAt: at,
          createdBy: ownerId,
        },
        { session },
      );
      await this.definitions.updateOne(
        { _id: id, controlVersion: version },
        {
          $set: {
            revision,
            status: "draft",
            syncState: "pending",
            updatedAt: at,
          },
          $unset: { enabledRevision: "", nextScheduledAt: "" },
          $inc: { controlVersion: 1 },
        },
        { session },
      );
      await this.append(
        {
          id: `${id}:control:${version + 1}`,
          automationId: id,
          tenantId: current.tenantId,
          ownerId,
          type: "automation.edited",
          at,
          detail: { actor: ownerId, version: version + 1, revision },
        },
        session,
      );
      return (await this.definitions.findOne({ _id: id }, { session }))!;
    });
  }
  async control(
    id: string,
    ownerId: string,
    version: number,
    action: "enable" | "pause" | "resume" | "archive",
    reviewedScopeFingerprint?: string,
  ) {
    return this.transaction(async (session) => {
      const current = await this.definitions.findOne(
        {
          _id: id,
          ownerId,
          tenantId: currentTenantId(),
          controlVersion: version,
          status: { $ne: "archived" },
        },
        { session },
      );
      if (
        !current ||
        (action === "resume" &&
          (current.status !== "paused" ||
            current.enabledRevision !== current.revision))
      )
        throw conflict();
      const status =
        action === "enable" || action === "resume"
          ? "enabled"
          : action === "archive"
            ? "archived"
            : "paused";
      const at = now();
      await this.definitions.updateOne(
        { _id: id, controlVersion: version },
        {
          $set: {
            status,
            syncState: "pending",
            updatedAt: at,
            ...(status === "enabled"
              ? {
                  enabledRevision: current.revision,
                  ...(reviewedScopeFingerprint
                    ? { reviewedScopeFingerprint }
                    : {}),
                }
              : {}),
          },
          $inc: { controlVersion: 1 },
          $unset: { nextScheduledAt: "" },
        },
        { session },
      );
      await this.append(
        {
          id: `${id}:control:${version + 1}`,
          automationId: id,
          tenantId: current.tenantId,
          ownerId,
          type: `automation.${action}`,
          at,
          detail: {
            actor: ownerId,
            version: version + 1,
            revision: current.revision,
          },
        },
        session,
      );
      return (await this.definitions.findOne({ _id: id }, { session }))!;
    });
  }
  async append(
    input: Omit<LedgerEvent, "_id" | "persistedAt">,
    session?: ClientSession,
  ) {
    if (input.tenantId !== currentTenantId())
      throw new Error("Audit tenant mismatch");
    for (const [key, value] of Object.entries(input.detail ?? {}))
      if (
        !SAFE_DETAIL.has(key) ||
        !["string", "boolean", "number"].includes(typeof value) ||
        (typeof value === "string" && value.length > 300)
      )
        throw new Error("Unsafe automation audit metadata");
    await this.ledger.updateOne(
      { _id: input.id },
      {
        $setOnInsert: {
          ...input,
          _id: input.id,
          persistedAt: now(),
          ...(!input.runId
            ? { expiresAt: new Date(Date.now() + 365 * 86400000) }
            : {}),
        },
      },
      { upsert: true, session },
    );
  }
  async admit(input: Admission): Promise<Run> {
    return this.transaction(async (session) => {
      const prior = await this.runs.findOne(
        { automationId: input.automationId, requestKey: input.requestKey },
        { session },
      );
      if (prior) {
        if (
          prior.revision !== input.revision ||
          prior.source !== input.source ||
          prior.retryOfRunId !== input.retryOfRunId
        )
          throw conflict();
        return prior;
      }
      const d = await this.definitions.findOne(
        { _id: input.automationId, tenantId: currentTenantId() },
        { session },
      );
      if (!d)
        throw new ApiError(404, "Automation not found", "AUTOMATION_NOT_FOUND");
      const r = await this.revision(d.id, input.revision);
      if (!r) throw conflict();
      const at = now();
      const stale =
        d.status !== "enabled" ||
        d.enabledRevision !== input.revision ||
        (input.controlVersion !== undefined &&
          input.controlVersion !== d.controlVersion);
      const late =
        input.source === "scheduled" &&
        (!input.scheduledAt ||
          !Number.isFinite(Date.parse(input.scheduledAt)) ||
          Date.now() - Date.parse(input.scheduledAt) >
            r.recipe.limits.latenessGraceMs);
      const reason = stale
        ? "stale_revision"
        : d.activeRunId
          ? "previous_run_active"
          : late
            ? "schedule_window_elapsed"
            : undefined;
      const id = `run_${randomUUID()}`;
      const run: Run = {
        _id: id,
        id,
        automationId: d.id,
        tenantId: d.tenantId,
        ownerId: d.ownerId,
        revision: input.revision,
        controlVersion: input.controlVersion ?? d.controlVersion,
        source: input.source,
        requestKey: input.requestKey,
        workflowId: input.workflowId,
        ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        acceptedAt: at,
        status: reason ? "skipped" : "accepted",
        ...(reason ? { outcome: "skipped", reason, completedAt: at } : {}),
        stopState: "not_started",
        auditComplete: true,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      };
      await this.runs.insertOne(run, { session });
      if (!reason)
        await this.definitions.updateOne(
          { _id: d.id },
          { $set: { activeRunId: id } },
          { session },
        );
      await this.append(
        {
          id: `${id}:accepted`,
          automationId: d.id,
          runId: id,
          tenantId: d.tenantId,
          ownerId: d.ownerId,
          type: reason ? "run.skipped" : "run.accepted",
          at,
          detail: {
            source: input.source,
            revision: input.revision,
            ...(reason ? { reason } : {}),
          },
        },
        session,
      );
      return run;
    });
  }
  async claimDispatch(id: string) {
    return this.transaction(async (session) => {
      const run = await this.runs.findOne(
        { _id: id, tenantId: currentTenantId() },
        { session },
      );
      if (
        !run ||
        run.outcome ||
        run.dispatchState ||
        run.cancellationRequestedAt ||
        run.stopState === "stop_requested"
      )
        return false;
      const control = await this.definitions.updateOne(
        {
          _id: run.automationId,
          activeRunId: id,
          status: "enabled",
          enabledRevision: run.revision,
          controlVersion: run.controlVersion,
          auditBlocked: { $ne: true },
        },
        { $inc: { admissionVersion: 1 } },
        { session },
      );
      const revision = await this.revisions.findOne(
        { automationId: run.automationId, revision: run.revision },
        { session },
      );
      const expired =
        run.executionDeadlineAt &&
        Date.now() >= Date.parse(run.executionDeadlineAt);
      const late =
        run.source === "scheduled" &&
        (!run.scheduledAt ||
          Date.now() - Date.parse(run.scheduledAt) >
            revision!.recipe.limits.latenessGraceMs);
      if (!control.matchedCount || expired || late) {
        const currentDefinition = await this.definitions.findOne(
          { _id: run.automationId },
          { session },
        );
        const reason = !control.matchedCount
          ? currentDefinition?.auditBlocked
            ? "audit_incomplete"
            : "stale_revision"
          : late
            ? "schedule_window_elapsed"
            : "execution_timeout";
        const outcome =
          reason === "execution_timeout" || reason === "audit_incomplete"
            ? "failed"
            : "skipped";
        await this.runs.updateOne(
          { _id: id },
          {
            $set: {
              status: outcome,
              outcome,
              reason,
              stopState: "not_started",
              completedAt: now(),
            },
          },
          { session },
        );
        await this.append(
          {
            id: `${id}:dispatch_expired`,
            automationId: run.automationId,
            runId: id,
            tenantId: run.tenantId,
            ownerId: run.ownerId,
            type: "run.outcome",
            at: now(),
            detail: { reason },
          },
          session,
        );
        await this.definitions.updateOne(
          { _id: run.automationId, activeRunId: id },
          { $unset: { activeRunId: "" } },
          { session },
        );
        return false;
      }
      await this.append(
        {
          id: `${id}:dispatch_claimed`,
          runId: id,
          automationId: run.automationId,
          tenantId: run.tenantId,
          ownerId: run.ownerId,
          type: "run.dispatch_claimed",
          at: now(),
          detail: { version: run.controlVersion },
        },
        session,
      );
      await this.runs.updateOne(
        { _id: id },
        {
          $set: {
            dispatchState: "claimed",
            stopState: "running",
            startedAt: now(),
          },
        },
        { session },
      );
      return true;
    });
  }
  async requestStop(id: string, reason: Run["reason"]) {
    return this.transaction(async (session) => {
      const run = await this.runs.findOne(
        { _id: id, tenantId: currentTenantId() },
        { session },
      );
      if (!run) throw new Error("Run not found");
      if (
        run.stopState === "stopped" ||
        (run.stopState === "not_started" && run.outcome)
      )
        return { run, dispatched: !!run.dispatchState, terminal: true };
      const dispatched = !!run.dispatchState;
      const at = now();
      const changes = {
        status:
          run.outcome && run.outcome !== "unknown"
            ? run.outcome
            : ("cancellation_requested" as const),
        reason: run.outcome && run.outcome !== "unknown" ? run.reason : reason,
        stopState: dispatched
          ? ("stop_requested" as const)
          : ("not_started" as const),
        ...(reason === "user_cancelled" ? { cancellationRequestedAt: at } : {}),
      };
      await this.runs.updateOne({ _id: id }, { $set: changes }, { session });
      await this.append(
        {
          id: `${id}:stop_requested:${reason}`,
          runId: id,
          automationId: run.automationId,
          tenantId: run.tenantId,
          ownerId: run.ownerId,
          type: "run.stop_requested",
          at,
          detail: { reason: reason! },
        },
        session,
      );
      // Claim and stop both write the run inside transactions: no native dispatch can race a no-start decision.
      if (!dispatched) {
        await this.runs.updateOne(
          { _id: id },
          {
            $set: {
              status: reason === "user_cancelled" ? "cancelled" : "failed",
              outcome: reason === "user_cancelled" ? "cancelled" : "failed",
              completedAt: at,
              unread: true,
            },
          },
          { session },
        );
        await this.definitions.updateOne(
          { _id: run.automationId, activeRunId: id },
          { $unset: { activeRunId: "" } },
          { session },
        );
      }
      return { run: { ...run, ...changes }, dispatched, terminal: !dispatched };
    });
  }
  async finish(
    id: string,
    changes: Pick<Run, "status" | "outcome" | "reason" | "stopState">,
  ) {
    return this.transaction(async (session) => {
      const run = await this.runs.findOne(
        { _id: id, tenantId: currentTenantId() },
        { session },
      );
      if (!run) throw new Error("Run not found");
      if (
        run.outcome &&
        run.outcome !== "unknown" &&
        run.stopState === "stopped" &&
        run.auditRetainedUntil
      )
        return run;
      const finalChanges =
        run.outcome && run.outcome !== "unknown"
          ? {
              ...changes,
              status: run.outcome,
              outcome: run.outcome,
              reason: run.reason,
            }
          : changes;
      const at = now();
      await this.runs.updateOne(
        { _id: id },
        {
          $set: {
            ...finalChanges,
            completedAt: at,
            unread: finalChanges.outcome !== "succeeded",
          },
        },
        { session },
      );
      await this.append(
        {
          id: `${id}:outcome:${finalChanges.outcome}:${finalChanges.stopState}`,
          automationId: run.automationId,
          runId: id,
          tenantId: run.tenantId,
          ownerId: run.ownerId,
          type: "run.outcome",
          at,
          detail: {
            status: finalChanges.status,
            stopState: finalChanges.stopState,
            ...(finalChanges.reason ? { reason: finalChanges.reason } : {}),
          },
        },
        session,
      );
      if (
        finalChanges.stopState === "stopped" ||
        finalChanges.stopState === "not_started"
      ) {
        const expiresAt = new Date(Date.now() + 365 * 86400000);
        await this.ledger.updateMany(
          { runId: id },
          { $set: { expiresAt } },
          { session },
        );
        await this.runs.updateOne(
          { _id: id },
          { $set: { auditRetainedUntil: expiresAt.toISOString() } },
          { session },
        );
      }
      if (
        finalChanges.stopState === "stopped" ||
        finalChanges.stopState === "not_started"
      )
        await this.definitions.updateOne(
          { _id: run.automationId, activeRunId: id },
          { $unset: { activeRunId: "" } },
          { session },
        );
      return (await this.runs.findOne({ _id: id }, { session }))!;
    });
  }
  async events(automationId: string, ownerId: string, runId?: string) {
    return this.ledger
      .find({
        automationId,
        ownerId,
        tenantId: currentTenantId(),
        ...(runId ? { runId } : {}),
      })
      .sort({ at: 1, _id: 1 })
      .limit(1000)
      .toArray();
  }
}
