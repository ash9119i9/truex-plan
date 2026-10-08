import type { DomainEvent, Session } from "../../../shared/contracts";
import type { AutomationReasonCode } from "../../../shared/automations";
import { AutomationStore, type Run } from "./store";
import { currentTenantId } from "../tenant";
const BLOCKERS: Record<string, AutomationReasonCode> = {
  approval_required: "approval_required",
  human_action_required: "input_required",
  delegation_prohibited: "human_review_required",
  dependency_unavailable: "dependency_unavailable",
  access_revoked: "access_revoked",
};
export function projectAutomationEvidence(
  run: Run,
  session: Session,
  event: DomainEvent,
): Partial<Run> | null {
  const policy = session.automationPolicy,
    correlation = event.data?.automationPolicy;
  if (
    !policy ||
    policy.runId !== run.id ||
    policy.automationId !== run.automationId ||
    policy.revision !== run.revision ||
    session._id !== run.sessionId ||
    event.threadId !== session.threadId ||
    !event.turnId ||
    (run.turnId && event.turnId !== run.turnId) ||
    correlation?.runId !== run.id ||
    correlation?.revision !== run.revision ||
    correlation?.automationId !== policy.automationId ||
    correlation?.promptRef !== policy.promptRef
  )
    return null;
  const changes: Partial<Run> = { turnId: event.turnId };
  if (event.type === "automation.blocked") {
    changes.blocker = BLOCKERS[event.data.reason] ?? "human_review_required";
    if (event.data.reason === "delegation_prohibited")
      changes.helperEscaped = true;
  }
  if (event.data.auditIncomplete === true) {
    changes.auditComplete = false;
    changes.auditLost = true;
  }
  if (
    event.type === "message.final" &&
    typeof event.data.text === "string" &&
    event.data.text.trim()
  ) {
    changes.resultSeen = true;
    changes.resultRef = {
      id: `${session._id}:assistant:${event.turnId}:${event.data.messageIndex ?? event.itemId}`,
      kind: "result",
      ownerId: run.ownerId,
      tenantId: run.tenantId,
    };
  }
  if (
    event.type === "turn.completed" &&
    event.data.terminationEvidence === "runtime" &&
    !run.runtimeTerminal &&
    event.data.turn?.id === event.turnId &&
    ["completed", "failed", "interrupted"].includes(event.data.turn?.status)
  ) {
    changes.runtimeTerminal = event.data.turn?.status;
    changes.stopState = "stopped";
  }
  return changes;
}
export async function ingestAutomationEvidence(
  db: AutomationStore,
  session: Session,
  event: DomainEvent,
) {
  if (!session.automationPolicy) return;
  await db.transaction(async (transaction) => {
    // Re-read under the transaction on every retry: a concurrent ingester may
    // already have bound this run's root or captured its terminal status.
    const run = await db.runs.findOne(
      { _id: session.automationPolicy!.runId, tenantId: currentTenantId() },
      { session: transaction },
    );
    if (!run) throw new Error("Automation evidence has no run identity");
    const evidenceId = `${run.id}:runtime:${event.cursor}`;
    if (await db.ledger.findOne({ _id: evidenceId }, { session: transaction }))
      return;
    const changes = projectAutomationEvidence(run, session, event);
    if (!changes) return;
    const detail: Record<string, string | number | boolean> = {
      turnId: event.turnId!,
      revision: run.revision,
    };
    if (changes.blocker) detail.reason = changes.blocker;
    if (
      event.type === "automation.blocked" ||
      event.type === "automation.stop_requested"
    ) {
      const identifier = (value: unknown) =>
        typeof value === "string" && /^[\w:./-]{1,200}$/.test(value)
          ? value
          : undefined;
      const actor = identifier(event.data.actor),
        method = identifier(event.data.method);
      if (actor) detail.actor = actor;
      if (method) detail.method = method;
      if (event.data.decision === "denied") detail.status = "denied";
      if (["requested", "unconfirmed"].includes(event.data.termination))
        detail.stopState = event.data.termination;
    }
    if (event.type === "automation.tool") {
      if (typeof event.data.tool === "string")
        detail.tool = event.data.tool.slice(0, 200);
      if (typeof event.data.phase === "string")
        detail.phase = event.data.phase.slice(0, 50);
      if (typeof event.data.status === "string")
        detail.status = event.data.status.slice(0, 50);
      if (typeof event.data.effects === "string")
        detail.effect = event.data.effects.slice(0, 50);
    }
    if (changes.runtimeTerminal) detail.status = changes.runtimeTerminal;
    if (event.type === "plan.updated")
      detail.count = Array.isArray(event.data.plan)
        ? event.data.plan.length
        : 0;
    const root = await db.runs.updateOne(
      {
        _id: run.id,
        $or: [{ turnId: { $exists: false } }, { turnId: event.turnId }],
      },
      { $set: changes },
      { session: transaction },
    );
    if (!root.matchedCount)
      throw new Error("Automation root identity changed during ingestion");
    if (changes.auditLost)
      await db.definitions.updateOne(
        { _id: run.automationId, tenantId: run.tenantId },
        { $set: { auditBlocked: true } },
        { session: transaction },
      );
    await db.append(
      {
        id: evidenceId,
        runId: run.id,
        automationId: run.automationId,
        tenantId: run.tenantId,
        ownerId: run.ownerId,
        type: event.type,
        at: event.at,
        detail,
      },
      transaction,
    );
  });
}

/** A failed persistence segment keeps dispatch blocked until its records replay. */
export async function markAutomationAuditFailure(
  db: AutomationStore,
  session: Session,
): Promise<boolean> {
  const policy = session.automationPolicy;
  if (!policy) return false;
  return db.transaction(async (transaction) => {
    const run = await db.runs.findOne(
      {
        _id: policy.runId,
        automationId: policy.automationId,
        tenantId: currentTenantId(),
        sessionId: session._id,
      },
      { session: transaction },
    );
    if (!run) throw new Error("Automation audit failure has no run identity");
    await db.runs.updateOne(
      { _id: run.id },
      { $set: { auditComplete: false, auditRecoveryPending: true } },
      { session: transaction },
    );
    await db.definitions.updateOne(
      { _id: run.automationId, tenantId: run.tenantId },
      { $set: { auditBlocked: true } },
      { session: transaction },
    );
    return true;
  });
}

/** Repair only replayable gaps, retaining every permanent or unrelated audit block. */
export async function repairAutomationAudit(
  db: AutomationStore,
  session: Session,
): Promise<boolean> {
  const policy = session.automationPolicy;
  if (!policy) return false;
  return db.transaction(async (transaction) => {
    const run = await db.runs.findOne(
      {
        _id: policy.runId,
        automationId: policy.automationId,
        tenantId: currentTenantId(),
        sessionId: session._id,
      },
      { session: transaction },
    );
    if (!run || !run.auditRecoveryPending || run.auditLost) return false;
    await db.runs.updateOne(
      { _id: run.id, auditLost: { $ne: true } },
      { $set: { auditComplete: true }, $unset: { auditRecoveryPending: "" } },
      { session: transaction },
    );
    const remaining = await db.runs.countDocuments(
      {
        automationId: run.automationId,
        tenantId: run.tenantId,
        $or: [{ auditLost: true }, { auditRecoveryPending: true }],
      },
      { session: transaction },
    );
    if (!remaining)
      await db.definitions.updateOne(
        { _id: run.automationId, tenantId: run.tenantId },
        { $unset: { auditBlocked: "" } },
        { session: transaction },
      );
    return true;
  });
}
