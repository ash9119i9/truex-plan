"use client";
import { useState } from "react";
import { Activity } from "lucide-react";
import type { DomainEvent, TurnTiming } from "../../shared/contracts";
export function SessionActivity({
  events,
  plan,
  timings,
}: {
  events: DomainEvent[];
  plan: { step: string; status: string }[];
  timings: TurnTiming[];
}) {
  const [panel, setPanel] = useState("activity");
  return (
    <aside className="inspector">
      <div className="inspector-title">
        <Activity size={16} /> Session activity
      </div>
      <div className="tabs">
        {["activity", "plan", "timings"].map((p) => (
          <button
            key={p}
            className={panel === p ? "active" : ""}
            onClick={() => setPanel(p)}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="inspector-content">
        {panel === "activity" &&
          (events.length ? (
            events.map((e, i) => (
              <div className="event" key={i}>
                <span>
                  {e.type === "turn.started"
                    ? "Working on your request"
                    : e.type === "turn.completed"
                      ? e.data.turn?.status === "failed"
                        ? "Request failed"
                        : e.data.turn?.status === "interrupted"
                          ? "Request stopped"
                          : "Request finished"
                      : e.data.label}
                </span>
                <time>{e.at ? new Date(e.at).toLocaleTimeString() : ""}</time>
              </div>
            ))
          ) : (
            <p className="muted">Business activity will appear here.</p>
          ))}
        {panel === "plan" && (
          <>
            <h3>Plan</h3>
            {plan.length ? (
              plan.map((p, i) => (
                <div className="plan-item" key={i}>
                  <input
                    type="checkbox"
                    readOnly
                    checked={p.status === "completed"}
                  />
                  <span>{p.step}</span>
                </div>
              ))
            ) : (
              <p className="muted">Your agent’s plan will appear here.</p>
            )}
          </>
        )}
        {panel === "timings" && (
          <>
            <h3>Response timings</h3>
            <p className="muted">
              Average total:{" "}
              {timings.length
                ? (
                    timings.reduce((s, t) => s + t.totalMs, 0) /
                    timings.length /
                    1000
                  ).toFixed(2) + "s"
                : "—"}
            </p>
            {timings.map((t, i) => (
              <div className="timing" key={t.turnId}>
                <b>Turn {i + 1}</b>
                <span>
                  {" "}
                  · {t.status}
                  {t.nonStreaming ? " · non-streaming" : ""}
                </span>
                <div className="timing-bar">
                  <i
                    style={{
                      width: `${((t.ttftMs || 0) / (t.totalMs || 1)) * 100}%`,
                    }}
                  />
                  <i
                    style={{
                      width: `${(t.streamMs / (t.totalMs || 1)) * 100}%`,
                    }}
                  />
                  <i
                    style={{
                      width: `${(t.finalizeMs / (t.totalMs || 1)) * 100}%`,
                    }}
                  />
                </div>
                <small>
                  First output{" "}
                  {t.ttftMs === null ? "—" : (t.ttftMs / 1000).toFixed(2) + "s"}{" "}
                  · stream {(t.streamMs / 1000).toFixed(2)}s · total{" "}
                  {(t.totalMs / 1000).toFixed(2)}s
                </small>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
