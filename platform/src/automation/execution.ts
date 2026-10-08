import { createHash, randomUUID } from "node:crypto";
import type { Session } from "../../../shared/contracts";
import type { AutomationReasonCode } from "../../../shared/automations";
import { POLICY_VERSION } from "../public";
import { PlatformService } from "../service";
import { ApiError } from "../errors";
import { AutomationStore, type Run } from "./store";

/** Credentials can rotate without changing reviewed execution scope. */
export function automationScopeFingerprint(config: Record<string, any>) {
  const sanitize = (value: any): any => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(
          (key) =>
            !/secret|password|token|api.?key|authorization|cookie|credential|fingerprint/i.test(
              key,
            ),
        )
        .map((key) => [key, sanitize(value[key])]),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(sanitize(config)))
    .digest("hex");
}
const reasonFor = (error: unknown): AutomationReasonCode =>
  error instanceof ApiError && error.status === 403
    ? "access_revoked"
    : "dependency_unavailable";
export class AutomationExecution {
  constructor(
    readonly db: AutomationStore,
    readonly platform: PlatformService,
    readonly authorize:
      (() => Promise<void>) | undefined = platform.dispatchGuard,
  ) {}
  private async record(
    run: Run,
    operation: string,
    detail: Record<string, string | number | boolean> = {},
  ) {
    await this.db.append({
      id: `${run.id}:${operation}`,
      runId: run.id,
      automationId: run.automationId,
      tenantId: run.tenantId,
      ownerId: run.ownerId,
      type: `run.${operation}`,
      at: new Date().toISOString(),
      detail,
    });
  }
  async dispatch(id: string) {
    let run = await this.db.run(id);
    if (!run || (run.outcome && run.outcome !== "unknown")) return;
    if (run.dispatchState) {
      await this.observe(id);
      return;
    }
    if (run.outcome === "unknown") {
      await this.observe(id);
      return;
    }
    const definition = await this.db.get(run.automationId, run.ownerId);
    const revision = await this.db.revision(run.automationId, run.revision);
    if (
      !definition ||
      !revision ||
      definition.status !== "enabled" ||
      definition.enabledRevision !== run.revision ||
      definition.controlVersion !== run.controlVersion
    ) {
      await this.db.finish(id, {
        status: "skipped",
        outcome: "skipped",
        reason: "stale_revision",
        stopState: "not_started",
      });
      return;
    }
    if (definition.auditBlocked) {
      await this.db.finish(id, {
        status: "failed",
        outcome: "failed",
        reason: "audit_incomplete",
        stopState: "not_started",
      });
      return;
    }
    let config: any;
    try {
      await this.authorize?.();
      if (revision.recipe.projectId)
        await this.platform.project(revision.recipe.projectId, "write");
      config = await this.platform.configuration(revision.recipe.agentId, {
        ownerId: run.ownerId,
        use: true,
      });
      const reviewed = (definition as any).reviewedScopeFingerprint;
      if (reviewed && reviewed !== automationScopeFingerprint(config))
        throw new ApiError(
          403,
          "Agent scope changed; review and enable a new revision",
          "AUTOMATION_SCOPE_CHANGED",
        );
      await this.record(run, "dependencies_checked", {
        status: "permitted",
        model: String(config.model ?? "unknown").slice(0, 200),
        configurationFingerprint: automationScopeFingerprint(config),
      });
    } catch (error) {
      await this.db.finish(id, {
        status: "failed",
        outcome: "failed",
        reason: reasonFor(error),
        stopState: "not_started",
      });
      return;
    }
    // Stable identity is persisted before native provision. A lost receipt is never blindly retried.
    if (!run.provisionState) {
      const sessionId = `sess_auto_${run.id}`,
        runtimeSessionId = randomUUID(),
        host = this.platform.hosts[0];
      if (!host) {
        await this.db.finish(id, {
          status: "failed",
          outcome: "failed",
          reason: "dependency_unavailable",
          stopState: "not_started",
        });
        return;
      }
      const claimed = await this.db.runs.updateOne(
        {
          _id: id,
          provisionState: { $exists: false },
          outcome: { $exists: false },
        },
        {
          $set: {
            provisionState: "claimed",
            status: "preparing",
            sessionId,
            runtimeHost: host,
            runtimeSessionId,
            model: String(config.model ?? "unknown").slice(0, 200),
            configurationFingerprint: automationScopeFingerprint(config),
          },
        },
      );
      if (!claimed.modifiedCount) return;
      const automationPolicy = {
        automationId: run.automationId,
        runId: id,
        revision: run.revision,
        promptRef: revision.id,
      };
      try {
        const thread = await this.platform.call(
          host,
          "/threads",
          "POST",
          { ...config, automationPolicy },
          runtimeSessionId,
        );
        if (typeof thread.threadId !== "string" || !thread.threadId)
          throw new Error("Missing runtime identity");
        if (
          thread.automationPolicyVersion !== 1 ||
          !Object.entries(automationPolicy).every(
            ([key, value]) => thread.automationPolicy?.[key] === value,
          )
        )
          throw new ApiError(
            422,
            "Runtime does not confirm unattended policy",
            "AUTOMATION_POLICY_UNSUPPORTED",
          );
        const session: Session = {
          _id: sessionId,
          userId: run.ownerId,
          agentId: revision.recipe.agentId,
          automationPolicy,
          runtimePolicyVersion: POLICY_VERSION,
          threadId: thread.threadId,
          agentCoreHost: host,
          agentCoreSessionId: runtimeSessionId,
          status: "active",
          cwd: config.cwd,
          createdAt: new Date().toISOString(),
          mcpFingerprint: config.mcpFingerprint,
          ...(revision.recipe.projectId
            ? { projectId: revision.recipe.projectId }
            : {}),
        };
        await this.db.store.sessions.insertOne(session);
        await this.db.runs.updateOne(
          { _id: id },
          { $set: { provisionState: "accepted" } },
        );
      } catch (error) {
        const refused = error instanceof ApiError && error.status < 500;
        await this.db.finish(id, {
          status: refused ? "failed" : "unknown",
          outcome: refused ? "failed" : "unknown",
          reason: refused ? reasonFor(error) : "receipt_lost",
          stopState: refused ? "not_started" : "unknown",
        });
        return;
      }
      run = (await this.db.run(id))!;
    }
    const session = await this.db.store.sessions.findOne({
      _id: run.sessionId,
    });
    if (!session) {
      await this.db.finish(id, {
        status: "unknown",
        outcome: "unknown",
        reason: "receipt_lost",
        stopState: "unknown",
      });
      return;
    }
    if (run.dispatchState) {
      await this.observe(id);
      return;
    }
    // Recheck control and permission after provision, immediately before submission.
    const latest = await this.db.get(run.automationId, run.ownerId);
    if (
      latest?.status !== "enabled" ||
      latest.enabledRevision !== run.revision ||
      latest.controlVersion !== run.controlVersion
    ) {
      await this.db.finish(id, {
        status: "skipped",
        outcome: "skipped",
        reason: "stale_revision",
        stopState: "not_started",
      });
      return;
    }
    try {
      await this.authorize?.();
      if (revision.recipe.projectId)
        await this.platform.project(revision.recipe.projectId, "write");
      const current = await this.platform.configuration(
        revision.recipe.agentId,
        { ownerId: run.ownerId, use: true },
      );
      if (
        latest.reviewedScopeFingerprint &&
        latest.reviewedScopeFingerprint !== automationScopeFingerprint(current)
      )
        throw new Error("Scope changed");
    } catch {
      await this.db.finish(id, {
        status: "failed",
        outcome: "failed",
        reason: "access_revoked",
        stopState: "not_started",
      });
      return;
    }
    await this.record(run, "dispatch_intent", {
      operation: id,
      sessionId: session._id,
    });
    if (!(await this.db.claimDispatch(id))) return;
    try {
      const result = await this.platform.owned(session, "/turns", "POST", {
        text: revision.recipe.prompt,
        clientId: id,
      });
      if (typeof result.turnId !== "string" || !result.turnId || result.steer)
        throw new Error("Invalid root acceptance");
      await this.db.transaction(async (transaction) => {
        const current = await this.db.runs.findOne(
          { _id: id },
          { session: transaction },
        );
        if (!current || (current.turnId && current.turnId !== result.turnId))
          throw new Error("Conflicting root receipt");
        await this.db.runs.updateOne(
          { _id: id },
          {
            $set: {
              dispatchState: "accepted",
              turnId: result.turnId,
              ...(!current.outcome &&
              !current.cancellationRequestedAt &&
              current.stopState === "running"
                ? { status: "running" as const }
                : {}),
            },
          },
          { session: transaction },
        );
      });
      await this.record(run, "dispatched", {
        sessionId: session._id,
        turnId: result.turnId,
        lagMs: run.scheduledAt ? Date.now() - Date.parse(run.scheduledAt) : 0,
      });
    } catch (error) {
      const refused = error instanceof ApiError && error.status < 500;
      await this.db.finish(id, {
        status: refused ? "failed" : "unknown",
        outcome: refused ? "failed" : "unknown",
        reason: refused ? "runtime_failure" : "receipt_lost",
        stopState: refused ? "not_started" : "unknown",
      });
    }
  }
  async observe(id: string): Promise<{ terminal: boolean }> {
    let run = await this.db.run(id);
    if (!run) throw new Error("Run not found");
    if (run.sessionId) {
      const session = await this.db.store.sessions.findOne({
        _id: run.sessionId,
      });
      if (session) await this.platform.ingest(session);
      run = (await this.db.run(id))!;
    }
    if (run.runtimeTerminal && !run.helperEscaped) {
      if (
        run.runtimeTerminal === "completed" &&
        !run.blocker &&
        !run.cancellationRequestedAt &&
        !run.resultSeen
      ) {
        if (!run.resultWaitStartedAt) {
          await this.db.runs.updateOne(
            { _id: id },
            { $set: { resultWaitStartedAt: new Date().toISOString() } },
          );
          return { terminal: false };
        }
        if (Date.now() - Date.parse(run.resultWaitStartedAt) < 30000)
          return { terminal: false };
      }
      const reason =
        (run.blocker as AutomationReasonCode | undefined) ??
        (run.cancellationRequestedAt
          ? "user_cancelled"
          : run.reason === "execution_timeout"
            ? "execution_timeout"
            : run.runtimeTerminal !== "completed"
              ? "runtime_failure"
              : !run.resultSeen || !run.resultRef
                ? "result_missing"
                : !run.auditComplete
                  ? "audit_incomplete"
                  : undefined);
      // Root completion and restricted result persistence are both necessary.
      if (
        !reason &&
        run.resultRef &&
        !(await this.db.store.messages.findOne({ _id: run.resultRef.id }))
      ) {
        // Allow final-message records arriving after completion to converge on the next poll.
        return { terminal: false };
      }
      const cancelled = reason === "user_cancelled";
      await this.db.finish(id, {
        status: cancelled ? "cancelled" : reason ? "failed" : "succeeded",
        outcome: cancelled ? "cancelled" : reason ? "failed" : "succeeded",
        reason,
        stopState: "stopped",
      });
      return { terminal: true };
    }
    if (
      !run.runtimeTerminal &&
      !run.stopAttemptedAt &&
      (run.blocker || run.cancellationRequestedAt)
    ) {
      await this.stop(
        id,
        run.cancellationRequestedAt
          ? "user_cancelled"
          : (run.blocker as AutomationReasonCode),
      );
      return { terminal: false };
    }
    if (run.outcome && run.outcome !== "unknown") return { terminal: true };
    return { terminal: false };
  }
  async stop(id: string, reason: AutomationReasonCode) {
    const stop = await this.db.requestStop(id, reason);
    if (stop.terminal) return;
    const run = stop.run;
    const session = run.sessionId
      ? await this.db.store.sessions.findOne({ _id: run.sessionId })
      : null;
    await this.db.runs.updateOne(
      { _id: id },
      { $set: { stopAttemptedAt: new Date().toISOString() } },
    );
    const stopped = session
      ? await this.platform
          .owned(session, "/interrupt", "POST")
          .catch(() => undefined)
      : undefined;
    if (
      session &&
      stopped?.terminationEvidence === "not_started" &&
      stopped.automationPolicyVersion === 1 &&
      Object.entries(session.automationPolicy!).every(
        ([key, value]) => stopped.automationPolicy?.[key] === value,
      )
    ) {
      await this.db.finish(id, {
        status: reason === "user_cancelled" ? "cancelled" : "failed",
        outcome: reason === "user_cancelled" ? "cancelled" : "failed",
        reason,
        stopState: "not_started",
      });
      return;
    }
    // Interrupt acceptance alone does not establish termination.
    const failed = [
      "approval_required",
      "input_required",
      "human_review_required",
      "dependency_unavailable",
      "access_revoked",
      "execution_timeout",
    ].includes(reason);
    await this.db.finish(id, {
      status: failed ? "failed" : "unknown",
      outcome: failed ? "failed" : "unknown",
      reason,
      stopState: "unknown",
    });
  }
}
