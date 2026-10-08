import type { AutomationRun } from "../../../shared/automations";
import {
  formatAutomationTime,
  type AutomationRunDetail,
} from "@/lib/automations";

export function AutomationRunTiming({
  run,
  zone,
}: {
  run: AutomationRun;
  zone: string;
}) {
  return (
    <dl className="automation-facts">
      <div>
        <dt>Scheduled</dt>
        <dd>{formatAutomationTime(run.scheduledAt, zone)}</dd>
      </div>
      <div>
        <dt>Accepted</dt>
        <dd>{formatAutomationTime(run.acceptedAt, zone)}</dd>
      </div>
      <div>
        <dt>Agent dispatch</dt>
        <dd>{formatAutomationTime(run.startedAt, zone)}</dd>
      </div>
      <div>
        <dt>Completed</dt>
        <dd>{formatAutomationTime(run.completedAt, zone)}</dd>
      </div>
      <div>
        <dt>Dispatch lag</dt>
        <dd>
          {run.startedAt && run.scheduledAt
            ? `${Math.max(0, (Date.parse(run.startedAt) - Date.parse(run.scheduledAt)) / 1000)} seconds`
            : "—"}
        </dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>
          {run.startedAt && run.completedAt
            ? `${Math.max(0, (Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000)} seconds`
            : "—"}
        </dd>
      </div>
      <div>
        <dt>Recipe</dt>
        <dd>
          Revision {run.revision} ·{" "}
          {run.source === "manual" ? "Run now" : "Scheduled"}
          {run.retryOfRunId ? " · linked retry" : ""}
        </dd>
      </div>
      <div>
        <dt>Runtime termination</dt>
        <dd>{run.stopState.replaceAll("_", " ")}</dd>
      </div>
    </dl>
  );
}

export function AutomationRunRecord({
  detail,
  onSession,
}: {
  detail: AutomationRunDetail;
  onSession: (id: string) => void;
}) {
  const run = detail.run;
  const zone = detail.recipe.trigger.timeZone;
  return (
    <>
      {detail.plan && (
        <>
          <h3>Recorded task progress</h3>
          {detail.plan.explanation && <p>{detail.plan.explanation}</p>}
          <ol className="automation-preview">
            {detail.plan.steps.map((step, index) => (
              <li key={index}>
                {step.step} — {step.status.replaceAll("_", " ")}
              </li>
            ))}
          </ol>
        </>
      )}
      <h3>Output</h3>
      {detail.output ? (
        <>
          <pre className="automation-output">{detail.output.text}</pre>
          <button
            className="automation-button"
            onClick={() => onSession(detail.output!.sessionId)}
          >
            Open run conversation
          </button>
        </>
      ) : (
        <p className="automation-muted">
          No authorized result has been saved yet.
        </p>
      )}
      <h3>Execution timeline</h3>
      {detail.eventsTruncated && (
        <p className="automation-warning" role="status">
          This view shows the first 1,000 persisted events. More events exist;
          the visible timeline is a partial page of the audit.
        </p>
      )}
      {detail.events.length ? (
        <ol className="automation-timeline">
          {detail.events.map((event) => (
            <li key={event.id}>
              <strong>{event.type.replace(/[._]/g, " ")}</strong>
              <time dateTime={event.at}>
                {formatAutomationTime(event.at, zone)}
              </time>
              <dl>
                {Object.entries(event.detail)
                  .filter(
                    ([, value]) =>
                      typeof value === "string" ||
                      typeof value === "number" ||
                      typeof value === "boolean",
                  )
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>
                        {key.replace(/([A-Z])/g, " $1").replaceAll("_", " ")}
                      </dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
              </dl>
            </li>
          ))}
        </ol>
      ) : (
        <p className="automation-muted">No persisted events are available.</p>
      )}
      <details>
        <summary>Recipe and execution references</summary>
        <pre className="automation-output">{detail.recipe.prompt}</pre>
        <dl className="automation-facts">
          <div>
            <dt>Run</dt>
            <dd>{run.id}</dd>
          </div>
          <div>
            <dt>Workflow</dt>
            <dd>{run.workflowId}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{run.sessionId ?? "—"}</dd>
          </div>
          <div>
            <dt>Root turn</dt>
            <dd>{run.turnId ?? "—"}</dd>
          </div>
          {run.retryOfRunId && (
            <div>
              <dt>Retried run</dt>
              <dd>{run.retryOfRunId}</dd>
            </div>
          )}
        </dl>
      </details>
    </>
  );
}
