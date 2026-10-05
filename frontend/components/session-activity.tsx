"use client";
import {
  Activity,
  memo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { GoalTimeline } from "./goal-timeline";
import { AgentsPanel } from "./agents-panel";
import { InsightsPanel } from "./observability/insights-panel";
import { PlanSteps } from "./plan-steps";
import { Icon, type IconName } from "./v2/icon";
import { planProgress, type PlanStep } from "@/lib/plan";
import { errorReasons, turnFailure } from "@/lib/goal-errors";
import { formatDuration } from "@/lib/observability";
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

// Spec order: Activity, Agents, Goal, Plan, Insights.
export const SESSION_TABS = [
  "activity",
  "agents",
  "goal",
  "plan",
  "insights",
] as const;
export type SessionTab = (typeof SESSION_TABS)[number];
const isTab = (v: string | undefined): v is SessionTab =>
  !!v && (SESSION_TABS as readonly string[]).includes(v);
const tabLabel = (t: SessionTab) => t[0].toUpperCase() + t.slice(1);

// How many timeline rows show before "View all".
const RECENT_LIMIT = 8;

export function SessionActivity({
  events,
  plan,
  awaitingApproval = false,
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
  agentName,
  open = true,
  wide = false,
  onToggleWide,
  onClose,
  onDetailChange,
  onViewTurn,
  follow,
  onFollow,
}: {
  events: DomainEvent[];
  plan: PlanStep[];
  awaitingApproval?: boolean;
  timings: TurnTiming[];
  traces?: TurnTrace[];
  traceSummary?: TraceSummary | null;
  rateLimits?: RateLimitView | null;
  liveUsage?: TurnUsage | null;
  sessionId?: string;
  goal: Goal | null;
  goalReview: GoalReview | null;
  // A SessionTab id; plain strings are accepted so existing state still fits.
  tab?: SessionTab | string;
  onTab?: (tab: SessionTab) => void;
  subAgents?: SubAgentState;
  delegation?: DelegationPrefs;
  onDelegation?: (prefs: DelegationPrefs) => void;
  // Shown as the live meta while working ("Qlik Analyst" in the spec).
  agentName?: string;
  // False while the panel is collapsed: header buttons leave the tab order.
  open?: boolean;
  wide?: boolean;
  onToggleWide?: () => void;
  onClose?: () => void;
  // True while a helper's detail view is open (PANEL_SIZE_DEFAULT detail=max).
  onDetailChange?: (open: boolean) => void;
  onViewTurn?: (turnId: string) => Promise<boolean>;
  // Follow activity: new goals, plans and helpers bring their tab forward.
  follow?: boolean;
  onFollow?: (on: boolean) => void;
}) {
  const [localPanel, setLocalPanel] = useState<SessionTab>("activity");
  const [detail, setDetail] = useState(false);
  const panel: SessionTab = isTab(tab)
    ? tab
    : tab === undefined
      ? localPanel
      : "activity";
  const setPanel = (next: SessionTab) => (onTab ?? setLocalPanel)(next);
  const agents = subAgents?.agents || [];
  const active = agents.filter(isRunning).length;
  const progress = planProgress(plan);
  const goalRunning = goal?.status === "active";
  const skip = open ? undefined : -1;

  function reportDetail(next: boolean) {
    setDetail(next);
    onDetailChange?.(next);
  }
  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = SESSION_TABS.indexOf(panel);
    const next =
      e.key === "ArrowRight"
        ? SESSION_TABS[(i + 1) % SESSION_TABS.length]
        : e.key === "ArrowLeft"
          ? SESSION_TABS[(i - 1 + SESSION_TABS.length) % SESSION_TABS.length]
          : e.key === "Home"
            ? SESSION_TABS[0]
            : e.key === "End"
              ? SESSION_TABS[SESSION_TABS.length - 1]
              : null;
    if (!next) return;
    e.preventDefault();
    setPanel(next);
    document.getElementById(`session-tab-${next}`)?.focus();
  }

  return (
    <div className="session-panel">
      <div className="p-head">
        <Icon name="pulse" size={15} />
        <h2 className="p-title">Session activity</h2>
        {onFollow && (
          <button
            type="button"
            className="icon-btn ghost p-follow"
            aria-pressed={!!follow}
            aria-label="Follow activity"
            title={follow ? "Following activity" : "Follow activity"}
            tabIndex={skip}
            onClick={() => onFollow(!follow)}
          >
            <Icon name="spark" size={14} />
          </button>
        )}
        {onToggleWide && (
          <button
            type="button"
            className="icon-btn ghost p-size"
            aria-pressed={wide}
            aria-label={wide ? "Shrink panel" : "Expand panel"}
            title={wide ? "Shrink panel" : "Expand panel"}
            tabIndex={skip}
            onClick={onToggleWide}
          >
            <Icon name={wide ? "shrink" : "expand"} size={14} />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="Close panel"
            title="Close panel"
            tabIndex={skip}
            onClick={onClose}
          >
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
      <div
        className="tabs"
        role="tablist"
        aria-label="Session activity"
        onKeyDown={onTabKey}
      >
        {SESSION_TABS.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            id={`session-tab-${p}`}
            aria-selected={panel === p}
            aria-controls="session-tabpanel"
            tabIndex={open && panel === p ? 0 : -1}
            className={`tab${panel === p ? " is-active" : ""}`}
            onClick={() => setPanel(p)}
          >
            {tabLabel(p)}
            {p === "agents" && agents.length > 0 && (
              <span
                className={`tab-count${active ? " is-live" : ""}`}
                aria-label={
                  active
                    ? `${active} running`
                    : `${agents.length} helper${agents.length === 1 ? "" : "s"}`
                }
              >
                {active || agents.length}
              </span>
            )}
            {p === "goal" && goalRunning && (
              <span className="tab-dot" role="img" aria-label="running" />
            )}
            {p === "plan" && plan.length > 0 && (
              <span
                className="tab-count"
                aria-label={`${progress.done} of ${progress.total} steps done`}
              >
                {progress.done}/{progress.total}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        className="activity-body"
        id="session-tabpanel"
        role="tabpanel"
        aria-labelledby={`session-tab-${panel}`}
      >
        <Activity mode={open ? "visible" : "hidden"}>
          <VisibleDetails open={open}>
            {/* Non-activity tabs remount on switch (spec). */}
            {panel === "activity" && (
              <ActivityTab
                events={events}
                plan={plan}
                timings={timings}
                goalRunning={goalRunning}
                awaitingApproval={awaitingApproval}
                agentName={agentName}
              />
            )}
            {panel === "agents" && (
              <div key="agents" className="ag-tab">
                <AgentsPanel
                  sessionId={sessionId}
                  agents={agents}
                  previews={subAgents?.previews || {}}
                  skewMs={subAgents?.skewMs}
                  onDetailChange={reportDetail}
                />
                {!detail && delegation && onDelegation && (
                  <DelegationSettings
                    value={delegation}
                    onChange={onDelegation}
                  />
                )}
              </div>
            )}
            {panel === "goal" && (
              <GoalTimeline
                key="goal"
                sessionId={sessionId}
                goal={goal}
                review={goalReview}
                plan={plan}
                onViewTurn={onViewTurn}
              />
            )}
            {panel === "plan" && (
              <PlanPanel
                key="plan"
                plan={plan}
                awaitingApproval={awaitingApproval}
              />
            )}
            {panel === "insights" && (
              <InsightsPanel
                key="insights"
                traces={traces}
                summary={traceSummary}
                rateLimits={rateLimits}
                liveUsage={liveUsage}
                timings={timings}
                agents={agents}
                skewMs={subAgents?.skewMs}
              />
            )}
          </VisibleDetails>
        </Activity>
      </div>
    </div>
  );
}

// The authoritative props remain live in SessionActivity. Hidden panes keep
// their local disclosure state and pause effects, but do not project new bodies.
// Reopening renders the latest props, rather than a stale display snapshot.
const VisibleDetails = memo(
  function VisibleDetails({
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) {
    return children;
  },
  (_previous, next) => !next.open,
);

// ---- Activity tab ----------------------------------------------------------

function ActivityTab({
  events,
  plan,
  timings,
  goalRunning,
  awaitingApproval,
  agentName,
}: {
  events: DomainEvent[];
  plan: PlanStep[];
  timings: TurnTiming[];
  goalRunning: boolean;
  awaitingApproval: boolean;
  agentName?: string;
}) {
  const [all, setAll] = useState(false);
  // A turn is running from turn.started until its turn.completed.
  let startedAt = -1;
  let lastDone = -1;
  events.forEach((e, i) => {
    if (e.type === "turn.started") startedAt = i;
    if (e.type === "turn.completed") lastDone = i;
  });
  const running = startedAt > lastDone;
  const progress = planProgress(plan);
  const pct = progress.total
    ? Math.round((progress.done / progress.total) * 100)
    : null;
  const liveLabel = running
    ? events
        .slice(startedAt + 1)
        .filter((e) => e.type === "activity.updated" && e.data?.label)
        .at(-1)?.data.label
    : undefined;
  const currentStep =
    progress.current >= 0 ? plan[progress.current]?.step : undefined;
  const last = lastDone >= 0 ? events[lastDone] : null;
  const lastMs = last ? turnMs(last, events, timings) : null;
  const recent = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type !== "turn.started")
    .reverse();
  const shown = all ? recent : recent.slice(0, RECENT_LIMIT);

  return (
    <>
      <div className="live-head">
        <span className={`pulse${running ? "" : " idle"}`} aria-hidden="true" />
        <span className="live-title" role="status">
          {running ? "Working" : "Idle"}
        </span>
        <span className="live-meta">
          {running
            ? goalRunning
              ? "Goal in progress"
              : agentName || "Assistant"
            : "Waiting for a request"}
        </span>
      </div>
      {running ? (
        <div className="live-card">
          <div className="live-row">
            <span className="tile">
              <Icon name={goalRunning ? "target" : "doc"} size={16} />
            </span>
            <div className="grow">
              <span className="strong">
                {currentStep || liveLabel || "Working on your request"}
              </span>
              <span className="muted sm">
                {awaitingApproval
                  ? "Waiting for your approval"
                  : currentStep
                    ? `Step ${progress.current + 1} of ${progress.total}${liveLabel ? ` · ${liveLabel}` : ""}`
                    : "Started " + timeLabel(events[startedAt]?.at)}
              </span>
            </div>
            {pct !== null && <span className="live-pct">{pct}%</span>}
          </div>
          {pct !== null && (
            <div
              className="bar"
              role="progressbar"
              aria-label="Plan progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <span style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      ) : (
        last && (
          <div className="live-card">
            <div className="live-row">
              <span className="tile">
                <Icon name={completedIcon(last)} size={16} />
              </span>
              <div className="grow">
                <span className="strong">
                  Last run: {eventLabel(last).toLowerCase()}
                </span>
                <span className="muted sm">
                  {lastMs !== null
                    ? `${last.data.turn?.status === "completed" ? "Completed" : "Ended"} in ${formatDuration(lastMs)}`
                    : `Finished ${timeLabel(last.at)}`}
                  {progress.total
                    ? ` · ${progress.done} of ${progress.total} steps`
                    : ""}
                </span>
              </div>
              {pct !== null && <span className="live-pct">{pct}%</span>}
            </div>
            {pct !== null && (
              <div
                className="bar"
                role="progressbar"
                aria-label="Plan progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <span style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )
      )}
      <div className="section-head">
        <span className="eyebrow">Recent</span>
        {recent.length > RECENT_LIMIT && (
          <button
            type="button"
            className="link"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? "Show less" : "View all"}
          </button>
        )}
      </div>
      {shown.length ? (
        <ol className="timeline" aria-label="Recent activity">
          {shown.map(({ e, i }) => {
            const ms =
              e.type === "turn.completed" ? turnMs(e, events, timings) : null;
            const bad = isFailure(e);
            return (
              <li className="tl-row" key={`${e.seq}:${i}`}>
                <span className={`tl-dot${bad ? " is-bad" : ""}`}>
                  <Icon name={eventIcon(e)} size={14} />
                </span>
                <div className="tl-body">
                  <span className="tl-title">{eventLabel(e)}</span>
                  {(ms !== null || e.type.startsWith("subagent.")) && (
                    <span className="tl-meta">
                      {ms !== null ? formatDuration(ms) : "Helper agent"}
                    </span>
                  )}
                </div>
                <time className="tl-time" dateTime={e.at}>
                  {timeLabel(e.at)}
                </time>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="tl-empty">Business activity will appear here.</p>
      )}
    </>
  );
}

// Time of a finished turn: its timing record, else started→completed events.
function turnMs(e: DomainEvent, events: DomainEvent[], timings: TurnTiming[]) {
  const timing = e.turnId && timings.find((t) => t.turnId === e.turnId);
  if (timing && Number.isFinite(timing.totalMs)) return timing.totalMs;
  const start = events.find(
    (x) => x.type === "turn.started" && x.turnId && x.turnId === e.turnId,
  );
  const ms = start ? Date.parse(e.at) - Date.parse(start.at) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function isFailure(e: DomainEvent) {
  return (
    (e.type === "turn.completed" && e.data.turn?.status === "failed") ||
    (e.type === "error" && e.data?.willRetry !== true)
  );
}

function eventLabel(e: DomainEvent): string {
  if (e.type === "turn.started") return "Working on your request";
  if (e.type === "turn.completed")
    return e.data.turn?.status === "failed"
      ? failedLabel(e.data.turn?.error)
      : e.data.turn?.status === "interrupted"
        ? "Request stopped"
        : e.data.turn?.status === "completed"
          ? "Request finished"
          : "Request ended";
  if (e.type === "error")
    return e.data?.willRetry === true ? "Retrying…" : failedLabel(e.data);
  if (e.type === "subagent.spawned") return "Started a helper";
  if (e.type === "subagent.completed") return "Helper finished";
  if (e.type === "subagent.status") return "Helper status changed";
  return e.data?.label || "Activity";
}

function completedIcon(e: DomainEvent): IconName {
  const status = e.data.turn?.status;
  return status === "failed"
    ? "x"
    : status === "interrupted"
      ? "stop"
      : status === "completed"
        ? "check"
        : "pulse";
}

// Spec timeline icons, matched to the platform's plain-words labels.
function eventIcon(e: DomainEvent): IconName {
  if (e.type === "turn.completed") return completedIcon(e);
  if (e.type === "error") return e.data?.willRetry === true ? "pulse" : "x";
  if (e.type.startsWith("subagent.")) return "bot";
  const label = String(e.data?.label || "").toLowerCase();
  if (/visual|chart|diagram/.test(label)) return "chart";
  if (/web|search|internet/.test(label)) return "globe";
  if (/spreadsheet|table|data/.test(label)) return "table";
  if (/document|file|source/.test(label)) return "doc";
  if (/business service|connected|tool/.test(label)) return "plug";
  return "pulse";
}

// "4:53 PM" today, "Yesterday", else "Sep 3".
function timeLabel(at?: string) {
  const t = at ? new Date(at) : null;
  if (!t || Number.isNaN(t.getTime())) return "";
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(t)) / 86_400_000);
  if (diff === 0)
    return t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  return t.toLocaleDateString([], { month: "short", day: "numeric" });
}

// "Request failed", refined by the platform's reason when it sends one.
function failedLabel(error: unknown) {
  const failure = turnFailure(error);
  if (!failure || failure.reason === "other") return "Request failed";
  const { label, hint } = errorReasons[failure.reason];
  return hint
    ? `Request failed: ${label}. ${hint}`
    : `Request failed: ${label}`;
}

// ---- Agents tab: delegation ------------------------------------------------

// Applies to chats started after the change; the runtime fixes it per session.
function DelegationSettings({
  value,
  onChange,
}: {
  value: DelegationPrefs;
  onChange: (prefs: DelegationPrefs) => void;
}) {
  return (
    <fieldset className="delegation">
      <legend>Delegation for new chats</legend>
      <label className="delegation-opt">
        <input
          type="radio"
          name="delegation-mode"
          checked={value.mode === "explicitRequestOnly"}
          onChange={() => onChange({ ...value, mode: "explicitRequestOnly" })}
        />
        Only when I ask
      </label>
      <label className="delegation-opt">
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

// ---- Plan tab (5a) ---------------------------------------------------------

function PlanPanel({
  plan,
  awaitingApproval,
}: {
  plan: PlanStep[];
  awaitingApproval: boolean;
}) {
  const progress = planProgress(plan);
  if (!plan.length)
    return (
      <div className="empty-tab">
        <span className="tile lg">
          <Icon name="target" size={20} />
        </span>
        <span className="strong">No plan yet</span>
        <span className="muted sm">
          When the assistant breaks a request into steps, they appear here.
        </span>
      </div>
    );
  const pct = Math.round((progress.done / progress.total) * 100);
  return (
    <section className="pl" aria-labelledby="plan-panel-title">
      <div className="pl-head">
        <h3 id="plan-panel-title">Plan</h3>
        {/* Announced as steps finish or approval is needed. */}
        <span role="status" aria-live="polite">
          {awaitingApproval ? (
            <span className="ag-chip is-warn">Awaiting approval</span>
          ) : (
            <span className="muted sm">{progress.label}</span>
          )}
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label="Plan progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <PlanSteps plan={plan} />
    </section>
  );
}
