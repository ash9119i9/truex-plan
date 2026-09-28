"use client";
import { useState } from "react";
import { Activity } from "lucide-react";
import { GoalTimeline } from "./goal-timeline";
import { AgentsPanel } from "./agents-panel";
import { InsightsPanel } from "./observability/insights-panel";
import {
  isRunning,
  type DelegationPrefs,
  type SubAgentState,
} from "@/lib/subagents";
import type {
  DomainEvent,
  Goal,
  GoalReview,
  RateLimitView,
  TraceSummary,
  TurnTiming,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts";
export function SessionActivity({
  events,
  plan,
  timings,
  traces = [],
  traceSummary = null,
  rateLimits = null,
  liveUsage = null,
  sessionId,
  goal,
  goalReview,
  tab,
  onTab,
  subAgents,
  delegation,
  onDelegation,
}: {
  events: DomainEvent[];
  plan: { step: string; status: string }[];
  timings: TurnTiming[];
  traces?: TurnTrace[];
  traceSummary?: TraceSummary | null;
  rateLimits?: RateLimitView | null;
  liveUsage?: TurnUsage | null;
  sessionId?: string;
  goal: Goal | null;
  goalReview: GoalReview | null;
  tab?: string;
  onTab?: (tab: string) => void;
  subAgents?: SubAgentState;
  delegation?: DelegationPrefs;
  onDelegation?: (prefs: DelegationPrefs) => void;
}) {
  const [localPanel, setLocalPanel] = useState("activity");
  const panel = tab ?? localPanel;
  const setPanel = onTab ?? setLocalPanel;
  const agents = subAgents?.agents || [];
  const active = agents.filter(isRunning).length;
  return (
    <aside className="inspector">
      <div className="inspector-title">
        <Activity size={16} /> Session activity
      </div>
      <div className="tabs">
        {["activity", "agents", "goal", "plan", "insights"].map((p) => (
          <button
            key={p}
            className={panel === p ? "active" : ""}
            aria-pressed={panel === p}
            onClick={() => setPanel(p)}
          >
            {p}
            {p === "agents" && active > 0 && (
              <span className="tab-count" aria-label={`${active} running`}>
                {active}
              </span>
            )}
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
        {panel === "agents" && (
          <>
            <AgentsPanel
              sessionId={sessionId}
              agents={agents}
              previews={subAgents?.previews || {}}
              skewMs={subAgents?.skewMs}
            />
            {delegation && onDelegation && (
              <DelegationSettings value={delegation} onChange={onDelegation} />
            )}
          </>
        )}
        {panel === "goal" && (
          <GoalTimeline sessionId={sessionId} goal={goal} review={goalReview} />
        )}
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
        {panel === "insights" && (
          <InsightsPanel
            traces={traces}
            summary={traceSummary}
            rateLimits={rateLimits}
            liveUsage={liveUsage}
            timings={timings}
          />
        )}
      </div>
    </aside>
  );
}

// Applies to chats started after the change; the runtime fixes it per session.
function DelegationSettings({
  value,
  onChange,
}: {
  value: DelegationPrefs;
  onChange: (prefs: DelegationPrefs) => void;
}) {
  return (
    <fieldset className="delegation-settings">
      <legend>Delegation for new chats</legend>
      <label>
        <input
          type="radio"
          name="delegation-mode"
          checked={value.mode === "explicitRequestOnly"}
          onChange={() => onChange({ ...value, mode: "explicitRequestOnly" })}
        />
        Only when I ask
      </label>
      <label>
        <input
          type="radio"
          name="delegation-mode"
          checked={value.mode === "proactive"}
          onChange={() => onChange({ ...value, mode: "proactive" })}
        />
        Whenever it helps
      </label>
      <label className="delegation-max">
        Max helpers at once
        <select
          value={value.maxConcurrent}
          onChange={(e) =>
            onChange({ ...value, maxConcurrent: Number(e.target.value) })
          }
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}
