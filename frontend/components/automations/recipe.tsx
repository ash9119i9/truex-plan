"use client";
import { useEffect, useRef, useState } from "react";
import {
  formatAutomationTime,
  previewAutomation,
  triggerLabel,
  type AutomationView,
} from "@/lib/automations";
import { userMessage } from "@/lib/api";
import { AutomationControls } from "./controls";

export function AutomationRecipeSummary({
  automation,
  agentName,
  projectName,
  busy,
  onControl,
  onRun,
  onEdit,
}: {
  automation: AutomationView;
  agentName?: string;
  projectName?: string;
  busy: boolean;
  onControl: (action: "enable" | "pause" | "resume" | "archive") => void;
  onRun: () => void;
  onEdit: () => void;
}) {
  const [times, setTimes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    let live = true;
    setTimes([]);
    setError("");
    void previewAutomation(automation.recipe.trigger)
      .then((result) => {
        if (live) setTimes(result.times);
      })
      .catch((e) => {
        if (live) setError(userMessage(e));
      });
    return () => {
      live = false;
    };
    // Refreshing the read model preserves the preview for this immutable revision.
  }, [automation.id, automation.revision, retry]);
  return (
    <section className="automation-panel">
      <div className="automation-heading">
        <h2 ref={heading} tabIndex={-1}>
          {automation.recipe.name}
        </h2>
        <span className={`automation-state ${automation.status}`}>
          {automation.status}
        </span>
      </div>
      <p className="automation-muted">
        Revision {automation.revision} ·{" "}
        {agentName ?? "Selected agent unavailable"}
      </p>
      <p>{triggerLabel(automation.recipe.trigger)}</p>
      <p className="automation-muted">
        Project:{" "}
        {projectName ??
          (automation.recipe.projectId
            ? "Selected project unavailable"
            : "No project")}
        . Runs use your current permitted connections.
      </p>
      <details>
        <summary>Reviewed prompt and limits</summary>
        <pre className="automation-output">{automation.recipe.prompt}</pre>
        <p>
          Maximum run time:{" "}
          {automation.recipe.limits.executionTimeoutMs / 60_000} minutes.
          Lateness grace: {automation.recipe.limits.latenessGraceMs / 60_000}{" "}
          minutes.
        </p>
      </details>
      {error ? (
        <p role="alert" className="automation-error">
          {error}
          <button
            className="automation-button"
            onClick={() => setRetry((v) => v + 1)}
          >
            Retry preview
          </button>
        </p>
      ) : times.length ? (
        <div className="automation-upcoming">
          <h3>Next five executions</h3>
          <ol>
            {times.map((time) => (
              <li key={time}>
                {formatAutomationTime(time, automation.recipe.trigger.timeZone)}
              </li>
            ))}
          </ol>
          {automation.recipe.trigger.kind === "calendar" && (
            <p className="automation-muted">
              Daylight saving gaps are skipped. Repeated local times may execute
              twice.
            </p>
          )}
        </div>
      ) : (
        <p role="status" className="automation-muted">
          Loading schedule preview…
        </p>
      )}
      <AutomationControls
        key={`${automation.id}:${automation.revision}`}
        automation={automation}
        busy={busy}
        previewReady={times.length === 5}
        onControl={onControl}
        onRun={onRun}
        onEdit={onEdit}
      />
    </section>
  );
}
