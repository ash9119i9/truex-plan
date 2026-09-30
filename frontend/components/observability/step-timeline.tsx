"use client";
import { formatDuration, timelineLayout } from "@/lib/observability";
import type { TurnTrace } from "../../../shared/contracts";

// Where the time went: one lane per agent (helpers get their own), bars placed
// by start offset and duration. The step list below is the text alternative.
export function StepTimeline({ trace }: { trace: TurnTrace }) {
  const layout = timelineLayout(trace);
  if (!layout.lanes.length)
    return <p className="tc-empty">No steps were recorded for this turn.</p>;
  const steps = layout.lanes
    .flatMap((lane) => lane.steps.map((s) => ({ ...s, lane })))
    .sort((a, b) => a.startMs - b.startMs);
  return (
    <div className="tc-section">
      <div className="tc-lanes" aria-hidden="true">
        {layout.lanes.map((lane) => (
          <div className="tc-lane" key={lane.id}>
            <span className="tc-lane-name" title={lane.label}>
              {lane.label}
            </span>
            <div
              className="tc-track"
              style={{ height: lane.rows * 14 + (lane.rows - 1) * 4 }}
            >
              {lane.steps.map((s) => (
                <i
                  key={s.id}
                  className={[
                    "tc-step",
                    lane.helper ? "is-helper" : "",
                    s.slowest ? "is-slowest" : "",
                    s.status === "running" ? "is-running" : "",
                    s.status === "failed" || s.status === "declined"
                      ? "is-failed"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    left: `${s.left}%`,
                    width: `${s.width}%`,
                    top: s.row * 18,
                  }}
                  title={`${s.label} · ${formatDuration(s.durationMs)}`}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="tc-lane">
          <span />
          <div className="tc-axis">
            <span>0s</span>
            <span>{formatDuration(layout.spanMs)}</span>
          </div>
        </div>
      </div>
      <ol className="tc-steps" aria-label="Steps in order">
        {steps.map((s) => (
          <li key={s.id} className={s.slowest ? "is-slowest" : ""}>
            <span className="tc-step-name">
              {s.label}
              {s.lane.helper && (
                <span className="tc-step-agent"> · {s.lane.label}</span>
              )}
            </span>
            <span className="tc-step-time">
              {s.status === "running"
                ? "Running…"
                : s.status === "failed"
                  ? `Failed after ${formatDuration(s.durationMs)}`
                  : s.status === "declined"
                    ? "Declined"
                    : formatDuration(s.durationMs)}
              {s.slowest && <span className="tc-tag">Slowest</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
