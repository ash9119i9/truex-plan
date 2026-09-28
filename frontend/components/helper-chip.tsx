"use client";
import {
  formatDuration,
  groupElapsedMs,
  isRunning,
  type SubAgentState,
} from "@/lib/subagents";
import { useClock } from "./use-clock";

// Sits above the composer while helpers run, so the count and time stay in
// view after their block scrolls away.
export function HelperChip({
  state,
  onView,
}: {
  state: SubAgentState;
  onView: () => void;
}) {
  const running = state.agents.filter(isRunning);
  const now = useClock(running.length > 0);
  if (!running.length) return null;
  const label = `${running.length} ${running.length === 1 ? "helper" : "helpers"} running`;
  return (
    <div className="helper-chip">
      {/* Announces the count only; the ticking timer stays silent. */}
      <span className="visually-hidden" aria-live="polite">
        {label}
      </span>
      <span className="helper-chip-dot" aria-hidden />
      <span aria-hidden>
        {label} ·{" "}
        <time>
          {formatDuration(groupElapsedMs(running, now, state.skewMs))}
        </time>
      </span>
      <button type="button" className="link-button" onClick={onView}>
        View
      </button>
    </div>
  );
}
