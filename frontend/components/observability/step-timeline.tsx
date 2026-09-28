"use client";
import { formatDuration, timelineLayout } from "@/lib/observability";
import type { TurnTrace } from "../../../shared/contracts";

// Where the time went: one lane per agent (helpers get their own), bars placed
// by start offset and duration. The step list below is the text alternative.
export function StepTimeline({ trace }: { trace: TurnTrace }) {
  const layout = timelineLayout(trace);
  if (!layout.lanes.length)
    return <p className="obs-empty">No steps were recorded for this turn.</p>;
  const steps = layout.lanes
    .flatMap((lane) => lane.steps.map((s) => ({ ...s, lane })))
    .sort((a, b) => a.startMs - b.startMs);
  return (
    <div className="obs-timeline">
      <div className="obs-timeline-chart" aria-hidden="true">
        {layout.lanes.map((lane) => (
          <div className="obs-lane" key={lane.id}>
            <span className="obs-lane-label" title={lane.label}>
              {lane.label}
            </span>
            <div
              className="obs-lane-track"
              style={{ height: lane.rows * 14 + (lane.rows - 1) * 4 }}
            >
              {lane.steps.map((s) => (
                <i
                  key={s.id}
                  className={[
                    "obs-step",
                    lane.helper ? "helper" : "",
                    s.slowest ? "slowest" : "",
                    s.status === "running" ? "running" : "",
                    s.status === "failed" || s.status === "declined"
                      ? "failed"
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
        <div className="obs-lane">
          <span />
          <div className="obs-axis">
            <span>0</span>
            <span>{formatDuration(layout.spanMs)}</span>
          </div>
        </div>
      </div>
      <ol className="obs-steps" aria-label="Steps in order">
        {steps.map((s) => (
          <li key={s.id} className={s.slowest ? "slowest" : ""}>
            <span className="obs-step-name">
              {s.label}
              {s.lane.helper && (
                <span className="obs-step-agent"> · {s.lane.label}</span>
              )}
            </span>
            <span className="obs-step-time">
              {s.status === "running"
                ? "Running…"
                : s.status === "failed"
                  ? `Failed after ${formatDuration(s.durationMs)}`
                  : s.status === "declined"
                    ? "Declined"
                    : formatDuration(s.durationMs)}
              {s.slowest && <span className="obs-tag">Slowest</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
