"use client";
import { useMemo } from "react";
import {
  elapsedMs,
  groupElapsedMs,
  isRunning,
  type SubAgentState,
} from "@/lib/subagents";
import { helperAgents, helperRows, helperTally } from "@/lib/vm-stream";
import { useClock } from "./use-clock";
import { LiveDuration } from "./live-duration";
import { StreamIcon } from "./stream-icon";

const legend = [
  ["init", "Starting"],
  ["run", "Running"],
  ["ok", "Done"],
  ["bad", "Error"],
  ["warn", "Stopped"],
  ["off", "Shut down"],
] as const;

// The helper agents one turn started (wireframe §1 board 2, pin 9): header
// with stacked tone avatars and a tally, one row per helper, status legend.
// Open goes to the helper's detail in the session panel's Agents tab.
export function HelperGroup({
  id,
  threadIds,
  state,
  onOpenAgent,
}: {
  id: string;
  threadIds: string[];
  state: SubAgentState;
  // Kept for callers; Stop now lives in the Agents tab.
  sessionId?: string;
  onOpenAgent?: (threadId: string) => void;
}) {
  const agents = useMemo(
    () => helperAgents(threadIds, state),
    [threadIds, state],
  );
  const running = agents.some(isRunning);
  const now = useClock(running);
  if (!agents.length) return null;
  const rows = helperRows(agents, state.agents);
  const tally = helperTally(rows);
  const count = `${agents.length} ${agents.length === 1 ? "helper" : "helpers"}`;
  return (
    <section
      className="st-hc helper-group"
      id={`helpers-${id}`}
      tabIndex={-1}
      aria-label="Helper agents"
    >
      <div className="st-hh">
        <StreamIcon name="users" />
        <b>{count}</b>
        <span className="st-stack" aria-hidden="true">
          {rows.map((r) => (
            <span key={r.threadId} className={`h-av tone-${r.tone}`}>
              {r.initial}
            </span>
          ))}
        </span>
        <span className="muted">{tally}</span>
      </div>
      {/* Announces count and status changes, never timer ticks. */}
      <p className="sr-only" aria-live="polite">
        {`${count} · ${tally}`}
      </p>
      {rows.map((r, i) => (
        <div key={r.threadId} className={`st-hr tone-${r.tone}`}>
          <span className="h-av" aria-hidden="true">
            {r.initial}
          </span>
          <div className="n">
            <span>
              <b>{r.name}</b>
              {r.role && ` · ${r.role}`}
            </span>
            <span className="task" title={agents[i].task || r.task}>
              {r.task}
            </span>
            {r.running && (
              <span className="st-prog" aria-hidden="true">
                <i />
              </span>
            )}
          </div>
          <div className="r">
            <span className={r.pill.tone ? `pill ${r.pill.tone}` : "pill"}>
              {r.pill.spinner && <span className="spinner" aria-hidden="true" />}
              {r.pill.icon && <StreamIcon name={r.pill.icon} sm />}
              {r.pill.label}
            </span>
            <LiveDuration
              className="st-el"
              ms={elapsedMs(agents[i], now, state.skewMs)}
            />
            {onOpenAgent && (
              <button
                type="button"
                className="st-open"
                onClick={() => onOpenAgent(r.threadId)}
                aria-label={`Open ${r.name}`}
              >
                Open
                <StreamIcon name="chev" sm />
              </button>
            )}
          </div>
        </div>
      ))}
      <div className="st-hf" aria-label="Helper status legend">
        {legend.map(([dot, label]) => (
          <span key={dot}>
            <i className={`st-dot ${dot}`} aria-hidden="true" />
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}

// Time the whole group has been active, for callers that show it elsewhere.
export { groupElapsedMs };
