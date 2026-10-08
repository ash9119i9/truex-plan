"use client";
import { useEffect, useRef, useState } from "react";
import {
  canRequestAutomationCancellation,
  canRetryAutomationRun,
  cancelAutomationRun,
  getAutomationRun,
  readAutomationRun,
  repairInstruction,
  runOutcomeLabel,
  type AutomationRunDetail,
  type AutomationView,
} from "@/lib/automations";
import { userMessage, warnFailure } from "@/lib/api";
import { AutomationRunRecord, AutomationRunTiming } from "./run-record";

export function AutomationRunDetails({
  automation,
  runId,
  onClose,
  onRetry,
  onChanged,
  onSession,
}: {
  automation: AutomationView;
  runId: string;
  onClose: () => void;
  onRetry: (runId: string) => Promise<void>;
  onChanged: () => void;
  onSession: (sessionId: string) => void;
}) {
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await getAutomationRun(automation.id, runId);
        if (!live) return;
        setDetail(next);
        setLoadError("");
        if (
          !["stopped", "not_started"].includes(next.run.stopState) ||
          [
            "accepted",
            "preparing",
            "running",
            "cancellation_requested",
          ].includes(next.run.status)
        )
          timer = setTimeout(() => void load(), 5000);
      } catch (e) {
        if (live) setLoadError(userMessage(e));
      }
    }
    void load();
    void readAutomationRun(automation.id, runId)
      .then(() => {
        if (live) onChanged();
      })
      .catch((e) => warnFailure("mark automation run read", e));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [automation.id, runId, refresh, onChanged]);
  function refreshRun() {
    setError("");
    setRefresh((v) => v + 1);
  }
  async function action(cancel: boolean) {
    setBusy(true);
    setError("");
    try {
      if (cancel) {
        await cancelAutomationRun(automation.id, runId);
        setCancelConfirm(false);
        setRefresh((v) => v + 1);
        onChanged();
      } else await onRetry(runId);
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const run = detail?.run;
  const zone =
    detail?.recipe.trigger.timeZone ?? automation.recipe.trigger.timeZone;
  return (
    <section
      className="automation-panel"
      aria-labelledby="automation-run-title"
    >
      <div className="automation-heading">
        <h2 id="automation-run-title" ref={heading} tabIndex={-1}>
          Run details
        </h2>
        <button className="automation-button" onClick={onClose}>
          Close run
        </button>
      </div>
      {(error || loadError) && (
        <p role="alert" className="automation-error">
          {error || loadError}
          <button className="automation-button" onClick={refreshRun}>
            Refresh run
          </button>
        </p>
      )}
      {!detail || !run ? (
        <p role="status">Loading execution evidence…</p>
      ) : (
        <>
          <h3 className={`automation-outcome ${run.status}`}>
            {runOutcomeLabel(run)}
          </h3>
          <AutomationRunTiming run={run} zone={zone} />
          {!run.auditComplete && (
            <p className="automation-warning" role="status">
              Audit incomplete. Evidence may still be recovering; this timeline
              does not claim a complete record.
            </p>
          )}
          {["failed", "unknown", "cancelled", "skipped"].includes(
            run.status,
          ) && (
            <div className="automation-warning">
              <h3>Next permitted action</h3>
              <p>{repairInstruction(run)}</p>
              {automation.status === "enabled" && (
                <p>
                  The schedule remains enabled. Each occurrence checks current
                  access and dependencies.
                </p>
              )}
              <button
                className="automation-button"
                disabled={busy || !canRetryAutomationRun(run, automation)}
                onClick={() => void action(false)}
              >
                Start linked retry
              </button>
            </div>
          )}
          {canRequestAutomationCancellation(run) && (
            <button
              className="automation-button"
              disabled={busy}
              onClick={() => setCancelConfirm(true)}
            >
              Request cancellation
            </button>
          )}
          {cancelConfirm && canRequestAutomationCancellation(run) && (
            <div className="automation-warning" role="alert">
              <p>
                Request termination of this run? Completed actions remain.
                Cancellation is confirmed only after the runtime stops.
              </p>
              <div className="automation-actions">
                <button
                  className="automation-button"
                  disabled={busy}
                  onClick={() => void action(true)}
                >
                  Confirm cancellation request
                </button>
                <button
                  className="automation-button"
                  onClick={() => setCancelConfirm(false)}
                >
                  Keep running
                </button>
              </div>
            </div>
          )}
          <AutomationRunRecord detail={detail} onSession={onSession} />
        </>
      )}
    </section>
  );
}
