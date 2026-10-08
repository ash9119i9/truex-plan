"use client";
import { useState } from "react";
import { canRunAutomation, type AutomationView } from "@/lib/automations";

export function AutomationControls({
  automation,
  busy,
  previewReady,
  onControl,
  onRun,
  onEdit,
}: {
  automation: AutomationView;
  busy: boolean;
  previewReady: boolean;
  onControl: (action: "enable" | "pause" | "resume" | "archive") => void;
  onRun: () => void;
  onEdit: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  if (automation.status === "archived")
    return (
      <p className="automation-muted">
        Archived. History and execution evidence are retained.
      </p>
    );
  const requiresEnable = automation.enabledRevision !== automation.revision;
  return (
    <div className="automation-controls">
      {requiresEnable && (
        <label className="automation-choice">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
          />
          I reviewed this agent, prompt, scope, schedule and limits.
        </label>
      )}
      <div className="automation-actions">
        {requiresEnable || automation.status === "draft" ? (
          <button
            className="automation-button primary"
            disabled={busy || !reviewed || !previewReady}
            onClick={() => onControl("enable")}
          >
            Enable reviewed revision
          </button>
        ) : automation.status === "paused" ? (
          <button
            className="automation-button primary"
            disabled={busy}
            onClick={() => onControl("resume")}
          >
            Resume
          </button>
        ) : (
          <button
            className="automation-button"
            disabled={busy}
            onClick={() => onControl("pause")}
          >
            Pause
          </button>
        )}
        <button
          className="automation-button"
          disabled={busy || !canRunAutomation(automation)}
          onClick={onRun}
        >
          Run now
        </button>
        <button className="automation-button" disabled={busy} onClick={onEdit}>
          Edit recipe
        </button>
        <button
          className="automation-button"
          disabled={busy}
          onClick={() => setArchiveConfirm(true)}
        >
          Archive
        </button>
      </div>
      {automation.activeRunId && (
        <p role="status" className="automation-warning">
          An execution is active or unresolved. Another agent run cannot start
          until its termination is confirmed.
        </p>
      )}
      {requiresEnable && !previewReady && (
        <p className="automation-muted">
          A schedule preview is required before enabling.
        </p>
      )}
      {archiveConfirm && (
        <div className="automation-warning" role="alert">
          <p>
            Archive this automation and stop future occurrences? A current run
            continues until you request cancellation separately.
          </p>
          <div className="automation-actions">
            <button
              className="automation-button"
              disabled={busy}
              onClick={() => {
                setArchiveConfirm(false);
                onControl("archive");
              }}
            >
              Confirm archive
            </button>
            <button
              className="automation-button"
              onClick={() => setArchiveConfirm(false)}
            >
              Keep automation
            </button>
          </div>
        </div>
      )}
      <p className="automation-muted">
        Pause affects future admission. Resume does not backfill paused periods.
      </p>
    </div>
  );
}
