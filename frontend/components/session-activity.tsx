"use client";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { GoalTimeline } from "./goal-timeline";
import { AgentsPanel, HelperAvatar } from "./agents-panel";
import { BudgetByTurn, InsightsPanel } from "./observability/insights-panel";
import { ChangesView } from "./changes-view";
import { PanelIcon, type PanelIconName } from "./panel-icons";
import { ScopeBar } from "./panel-scope";
import { Icon } from "./v2/icon";
import { useClock } from "./use-clock";
import type { Entry } from "@/lib/chat";
import type { PlanStep } from "@/lib/plan";
import {
  taskTitle,
  type DelegationPrefs,
  type SubAgentState,
} from "@/lib/subagents";
import {
  advancedIn,
  buildTurns,
  effectiveScope,
  formatDuration,
  formatTokens,
  helperRoster,
  helperTurns,
  liveTurn,
  planDiff,
  planVersions,
  plural,
  scopeLocked,
  selectedTurnId,
  sessionFiles,
  sessionSubLine,
  sessionTotals,
  showBackToLive,
  stepTurn,
  versionForTurn,
  versionProgress,
  type LogKind,
  type LogRow,
  type PanelTab,
  type PlanVersion,
  type RosterRow,
  type Scope,
  type TurnVM,
} from "@/lib/vm-panel";
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

// Wireframe r2 order: Activity, Goal, Agents, Plan, Insights.
export const SESSION_TABS = [
  "activity",
  "goal",
  "agents",
  "plan",
  "insights",
] as const satisfies readonly PanelTab[];
export type SessionTab = (typeof SESSION_TABS)[number];
const isTab = (v: string | undefined): v is SessionTab =>
  !!v && (SESSION_TABS as readonly string[]).includes(v);
const tabLabel = (t: SessionTab) => t[0].toUpperCase() + t.slice(1);
// The active tab carries its icon (wireframe r2 section 4).
const tabIcon: Record<SessionTab, PanelIconName> = {
  activity: "activity",
  goal: "target",
  agents: "users",
  plan: "list",
  insights: "chart",
};
const nodeKind: Record<LogKind, string> = {
  think: "k-think",
  tool: "k-tool",
  agent: "k-agent",
  plan: "k-agent",
  file: "k-file",
  err: "k-err",
};

// Helper facts shared by the work log, the roster and This turn's list.
interface HelperInfo {
  name: string;
  tone: number;
  role: string;
  run: string;
  elapsedMs: number;
}

export function SessionActivity({
  events,
  entries = [],
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
  turnId,
  onTurn,
  subAgents,
  delegation,
  onDelegation,
  open = true,
  wide = false,
  onToggleWide,
  onClose,
  onDetailChange,
  follow,
  onFollow,
}: {
  // Panel events; plan.updated and diff.updated feed plan versions and files.
  events: DomainEvent[];
  // Chat entries: turn order, prompts, thinking and which turn started a helper.
  entries?: Entry[];
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
  // Optional shared turn selection with the stream (null follows live).
  turnId?: string | null;
  onTurn?: (turnId: string | null) => void;
  subAgents?: SubAgentState;
  delegation?: DelegationPrefs;
  onDelegation?: (prefs: DelegationPrefs) => void;
  // Kept for callers; the scoped panel names turns, not the agent.
  agentName?: string;
  // False while the panel is collapsed: header buttons leave the tab order.
  open?: boolean;
  wide?: boolean;
  onToggleWide?: () => void;
  onClose?: () => void;
  // True while a helper's detail view is open (PANEL_SIZE_DEFAULT detail=max).
  onDetailChange?: (open: boolean) => void;
  // Follow activity: new goals, plans and helpers bring their tab forward.
  follow?: boolean;
  onFollow?: (on: boolean) => void;
}) {
  const [localPanel, setLocalPanel] = useState<SessionTab>("activity");
  const [detail, setDetail] = useState(false);
  // panel.scope[tab]: remembered per tab for the session.
  const [picked, setPicked] = useState<Partial<Record<PanelTab, Scope>>>({});
  const [localTurn, setLocalTurn] = useState<string | null>(null);
  const [helperOpen, setHelperOpen] = useState<string | null>(null);
  useEffect(() => {
    setPicked({});
    setLocalTurn(null);
    setHelperOpen(null);
  }, [sessionId]);

  const panel: SessionTab = isTab(tab)
    ? tab
    : tab === undefined
      ? localPanel
      : "activity";
  const setPanel = (next: SessionTab) => (onTab ?? setLocalPanel)(next);
  // A turn picked outside the panel (the stream's "Turn N" label) shows in
  // This turn scope (wireframe r2 §1, note 1). Only a new pick switches the
  // scope, so a later switch back to Session stays the user's choice.
  useEffect(() => {
    if (!turnId || scopeLocked(panel)) return;
    setPicked((p) => (p[panel] === "turn" ? p : { ...p, [panel]: "turn" }));
  }, [turnId]);
  const agents = subAgents?.agents || [];
  const skip = open ? undefined : -1;

  const live = liveTurn(events);
  const now = useClock(!!live);
  const turns = useMemo(
    () =>
      buildTurns({
        events,
        entries,
        traces,
        timings,
        agents,
        liveUsage,
        liveTurnId: live,
        now,
      }),
    [events, entries, traces, timings, agents, liveUsage, live, now],
  );
  const pickedTurn = turnId !== undefined ? turnId : localTurn;
  const selected = selectedTurnId(turns, pickedTurn, live);
  const turn = turns.find((t) => t.id === selected) ?? null;
  const scope = effectiveScope(panel, picked, !!live);
  const versions = useMemo(() => planVersions(events, plan), [events, plan]);
  const turnOf = useMemo(() => helperTurns(entries, events), [entries, events]);
  const roster = useMemo(
    () => helperRoster(agents, turns, turnOf, now, subAgents?.skewMs),
    [agents, turns, turnOf, now, subAgents?.skewMs],
  );
  const helpers = useMemo(() => {
    const info: Record<string, HelperInfo> = {};
    for (const r of roster)
      r.runs.forEach((run, i) => {
        info[run.threadId] = {
          name: r.name,
          tone: r.tone,
          role: r.role || taskTitle(run.agent.task),
          run: r.runs.length > 1 ? `run ${i + 1} of ${r.runs.length}` : "",
          elapsedMs: run.elapsedMs,
        };
      });
    return info;
  }, [roster]);
  const totals = sessionTotals(turns);

  function pickTurn(id: string | null) {
    if (turnId === undefined) setLocalTurn(id);
    onTurn?.(id);
    // The stream scrolls to the turn's first response (chat anchor).
    if (id)
      document
        .getElementById(`turn-${id}`)
        ?.scrollIntoView({ block: "nearest" });
  }
  function setScope(next: Scope, on: PanelTab = panel) {
    setPicked((p) => ({ ...p, [on]: next }));
  }
  // A turn chip in a Session view switches to This turn with that turn.
  function openTurn(id: string) {
    pickTurn(id);
    setScope("turn");
  }
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

  const runs = roster.reduce((n, r) => n + r.runs.length, 0);
  const ctx: ReactNode = scopeLocked(panel) ? (
    "Goal spans all turns"
  ) : scope !== "session" ? null : panel === "activity" ? (
    <>
      <b>{plural(totals.turns, "turn")}</b>
      {totals.since && ` · since ${totals.since}`}
    </>
  ) : panel === "agents" && roster.length ? (
    <>
      <b>{plural(roster.length, "helper")}</b> · {plural(runs, "run")}
    </>
  ) : panel === "insights" ? (
    <b>{plural(totals.turns, "turn")}</b>
  ) : null;

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
        className="tabs pn-tabs"
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
            {panel === p && <PanelIcon name={tabIcon[p]} />}
            {tabLabel(p)}
          </button>
        ))}
      </div>
      {turns.length > 0 && !(panel === "agents" && helperOpen) && (
        <ScopeBar
          scope={scope}
          locked={scopeLocked(panel)}
          onScope={(s) => setScope(s)}
          turns={turns}
          selectedId={selected}
          onPick={pickTurn}
          backToLive={showBackToLive(selected, live)}
          onLive={() => pickTurn(null)}
          ctx={ctx}
        />
      )}
      <div
        className="activity-body"
        id="session-tabpanel"
        role="tabpanel"
        aria-labelledby={`session-tab-${panel}`}
      >
        {/* Tabs remount on switch; there is no tab animation (spec). */}
        {panel === "activity" &&
          (!turns.length ? (
            <p key="activity" className="tl-empty">
              Business activity will appear here.
            </p>
          ) : scope === "turn" && turn ? (
            <ActivityTurn
              key={`activity:${turn.id}`}
              turn={turn}
              turns={turns}
              versions={versions}
              helpers={helpers}
              sessionHelpers={Object.keys(helpers).length}
              onSession={() => setScope("session")}
            />
          ) : (
            <ActivitySession
              key="activity:session"
              turns={turns}
              selectedId={selected}
              liveId={live}
              versions={versions}
              helpers={helpers}
              roster={roster}
              onTurn={openTurn}
            />
          ))}
        {panel === "goal" && (
          <div key="goal" className="pn-goal">
            <GoalTimeline
              sessionId={sessionId}
              goal={goal}
              review={goalReview}
              plan={plan}
            />
            {goal && turns.length > 0 && (
              <GoalByTurn
                goal={goal}
                turns={turns}
                traces={traces}
                liveUsage={liveUsage}
                selectedId={selected}
              />
            )}
          </div>
        )}
        {panel === "agents" && (
          <div key="agents" className="ag-tab">
            {helperOpen || !agents.length ? (
              <AgentsPanel
                sessionId={sessionId}
                agents={agents}
                previews={subAgents?.previews || {}}
                skewMs={subAgents?.skewMs}
                onDetailChange={reportDetail}
                openId={helperOpen}
                onOpenChange={setHelperOpen}
              />
            ) : scope === "turn" && turn ? (
              <AgentsTurn
                turn={turn}
                helpers={helpers}
                sessionHelpers={Object.keys(helpers).length}
                last={turn.id === turns.at(-1)?.id}
                onOpen={setHelperOpen}
                onSession={() => setScope("session")}
              />
            ) : (
              <AgentsSession
                roster={roster}
                selectedId={selected}
                helperTokens={totals.helperTokens}
                tokens={totals.tokens}
                onOpen={setHelperOpen}
              />
            )}
            {!detail && delegation && onDelegation && (
              <DelegationSettings value={delegation} onChange={onDelegation} />
            )}
          </div>
        )}
        {panel === "plan" && (
          <PlanTab
            key="plan"
            versions={versions}
            turns={turns}
            scope={scope}
            turn={turn}
            liveId={live}
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
            scope={scope}
            selectedTurnId={selected}
            onSelectTurn={pickTurn}
          />
        )}
      </div>
    </div>
  );
}

// ---- Shared pieces ----------------------------------------------------------

const tcClass = (t: TurnVM, selectedId?: string | null) =>
  `pn-tc${t.status === "live" ? " live" : t.id === selectedId ? " on" : ""}`;

function statsCell(v: ReactNode, l: string, bad = false) {
  return (
    <div key={l}>
      <span className={`v${bad ? " bad" : ""}`}>{v}</span>
      <span className="l">{l}</span>
    </div>
  );
}

function HelperLine({
  id,
  info,
  onOpen,
}: {
  id: string;
  info?: HelperInfo;
  onOpen?: (id: string) => void;
}) {
  if (!info) return null;
  const body = (
    <>
      <HelperAvatar name={info.name} tone={info.tone} />
      <span className="grow">
        <b>{info.name}</b>
        <span className="muted">
          {[info.role, info.run].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="pn-mono">{formatDuration(info.elapsedMs)}</span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      // page.tsx scrolls to and focuses this id when a chat chip opens a helper.
      id={`agent-card-${id}`}
      className={`pn-helper flat tone-${info.tone}`}
      onClick={() => onOpen(id)}
    >
      {body}
    </button>
  ) : (
    <span className={`pn-helper tone-${info.tone}`}>{body}</span>
  );
}

function LogList({
  rows,
  helpers,
}: {
  rows: LogRow[];
  helpers: Record<string, HelperInfo>;
}) {
  return (
    <ul className="log">
      {rows.map((r) => (
        <li key={r.id}>
          <span className={`node ${nodeKind[r.kind]}${r.live ? " k-live" : ""}`}>
            <PanelIcon name={r.icon} />
          </span>
          <span className="what">
            <b>{r.title}</b>
            {r.kind === "err" ? (
              (r.sub || r.ref) && (
                <span className="pn-err">
                  <span>
                    {r.sub}
                    {r.sub && r.ref && " · "}
                    {r.ref && <code>{r.ref}</code>}
                  </span>
                </span>
              )
            ) : r.helpers?.length ? (
              r.helpers.map((id) => (
                <HelperLine key={id} id={id} info={helpers[id]} />
              ))
            ) : (
              r.sub && <span>{r.sub}</span>
            )}
          </span>
          <span className="t">{r.t}</span>
        </li>
      ))}
    </ul>
  );
}

// Empty slice with a pointer to the Session scope (Board B, note 4).
function EmptySlice({
  count,
  last,
  onSession,
}: {
  count: number;
  last: boolean;
  onSession: () => void;
}) {
  return (
    <div className="pn-helper">
      <PanelIcon name="users" />
      <span className="grow">
        <span>No helpers in this turn</span>
        <button type="button" className="pn-mono" onClick={onSession}>
          {count} {last ? "earlier " : ""}in session
        </button>
      </span>
    </div>
  );
}

function TurnHeader({ turn }: { turn: TurnVM }) {
  return (
    <div className="pn-prompt">
      <span className={tcClass(turn)}>{turn.label}</span>
      {turn.steer && <PanelIcon name="steer" />}
      <q>{turn.prompt || "No message"}</q>
    </div>
  );
}

// "Plan v2 · step 3 of 4" for the version active in a turn.
function planLine(
  versions: PlanVersion[],
  turns: TurnVM[],
  turnId: string,
): string {
  const v = versionForTurn(
    versions,
    turns.map((t) => t.id),
    turnId,
  );
  if (!v) return "";
  const p = versionProgress(v);
  const step = p.current >= 0 ? p.current + 1 : p.done;
  return `Plan v${v.version}${p.total ? ` · step ${Math.max(1, step)} of ${p.total}` : ""}`;
}

// ---- Activity: This turn (Board B) -------------------------------------------

function ActivityTurn({
  turn,
  turns,
  versions,
  helpers,
  sessionHelpers,
  onSession,
}: {
  turn: TurnVM;
  turns: TurnVM[];
  versions: PlanVersion[];
  helpers: Record<string, HelperInfo>;
  sessionHelpers: number;
  onSession: () => void;
}) {
  const live = turn.status === "live";
  const line = planLine(versions, turns, turn.id);
  return (
    <div className="pn-body">
      <TurnHeader turn={turn} />
      <div className="stats" aria-label="Turn stats">
        {statsCell(
          turn.durationMs === null ? "—" : formatDuration(turn.durationMs),
          live ? "time so far" : "time",
        )}
        {statsCell(turn.tokens === null ? "—" : formatTokens(turn.tokens), "tokens")}
        {statsCell(turn.toolCalls, turn.toolCalls === 1 ? "tool" : "tools")}
        {statsCell(turn.files.length, turn.files.length === 1 ? "file" : "files")}
        {turn.errors > 0 &&
          statsCell(turn.errors, turn.errors === 1 ? "error" : "errors", true)}
      </div>
      <div className="pn-h">
        Work log
        <span className="spacer" />
        {line && <em>{line}</em>}
      </div>
      {turn.rows.length ? (
        <LogList rows={turn.rows} helpers={helpers} />
      ) : (
        <span className="pn-sub">
          {live ? "Nothing recorded yet" : "Nothing recorded for this turn"}
        </span>
      )}
      {!turn.helperIds.length && sessionHelpers > 0 && (
        <EmptySlice
          count={sessionHelpers}
          last={turn.id === turns.at(-1)?.id}
          onSession={onSession}
        />
      )}
    </div>
  );
}

// ---- Activity: Session (Board C) -----------------------------------------------

function ActivitySession({
  turns,
  selectedId,
  liveId,
  versions,
  helpers,
  roster,
  onTurn,
}: {
  turns: TurnVM[];
  selectedId: string | null;
  liveId: string | null;
  versions: PlanVersion[];
  helpers: Record<string, HelperInfo>;
  roster: RosterRow[];
  onTurn: (id: string) => void;
}) {
  const totals = sessionTotals(turns);
  const files = sessionFiles(turns);
  const sub = sessionSubLine(roster, versions, totals.helperTokens);
  // The selected turn's group starts open.
  const [openIds, setOpenIds] = useState<string[]>(
    selectedId ? [selectedId] : [],
  );
  const allOpen = turns.every((t) => openIds.includes(t.id));
  function toggle(id: string, next: boolean) {
    setOpenIds((ids) =>
      next ? [...new Set([...ids, id])] : ids.filter((x) => x !== id),
    );
  }
  return (
    <div className="pn-body">
      <div className="stats" aria-label="Session totals">
        {statsCell(totals.turns, totals.turns === 1 ? "turn" : "turns")}
        {statsCell(formatTokens(totals.tokens), "tokens")}
        {statsCell(formatDuration(totals.workingMs), "working")}
        {statsCell(totals.files, totals.files === 1 ? "file" : "files")}
        {statsCell(
          totals.errors,
          totals.errors === 1 ? "error" : "errors",
          totals.errors > 0,
        )}
      </div>
      {sub && <span className="pn-sub">{sub}</span>}
      <div className="pn-h">
        By turn
        <span className="spacer" />
        <button
          type="button"
          className="em"
          onClick={() => setOpenIds(allOpen ? [] : turns.map((t) => t.id))}
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <div className="pn-groups">
        {turns.map((t) => {
          const live = t.status === "live";
          const plan = t.planCreated
            ? `Plan v${t.planCreated}`
            : live
              ? planLine(versions, turns, t.id)
              : versions.length
                ? "No plan change"
                : "";
          return (
            <details
              key={t.id}
              className="pn-group"
              open={openIds.includes(t.id)}
              onToggle={(e) => toggle(t.id, e.currentTarget.open)}
            >
              <summary>
                <PanelIcon name="chev" className="pn-chev" />
                <span className="pn-gt">
                  <button
                    type="button"
                    className={tcClass(t)}
                    aria-label={`Show ${t.label} in This turn`}
                    onClick={(e) => {
                      e.preventDefault();
                      onTurn(t.id);
                    }}
                  >
                    {t.label}
                  </button>
                  {t.steer && <PanelIcon name="steer" />}
                  <span>{t.prompt || "No message"}</span>
                </span>
                {live ? (
                  <span className="pn-live sm">Live</span>
                ) : (
                  <span className="pn-mono">{t.clock}</span>
                )}
                <span className="pn-gm">
                  {t.tokens !== null && (
                    <span>
                      {formatTokens(t.tokens)}
                      {live ? " so far" : ""}
                    </span>
                  )}
                  {!live && t.durationMs !== null && (
                    <span>{formatDuration(t.durationMs)}</span>
                  )}
                  {plan && <span>{plan}</span>}
                  {t.helperIds.length > 0 && (
                    <span>{plural(t.helperIds.length, "helper")}</span>
                  )}
                  {t.files.length > 0 && (
                    <span>{plural(t.files.length, "file")}</span>
                  )}
                  {t.warnings > 0 && (
                    <span className="warn">{plural(t.warnings, "warning")}</span>
                  )}
                  {t.errors > 0 && (
                    <span className="bad">{plural(t.errors, "error")}</span>
                  )}
                </span>
              </summary>
              <div className="pn-gbody">
                {t.rows.length ? (
                  <LogList rows={t.rows} helpers={helpers} />
                ) : (
                  <span className="pn-sub">Nothing recorded for this turn</span>
                )}
              </div>
            </details>
          );
        })}
      </div>
      {files.length > 0 && (
        <>
          <div className="pn-h">
            Files changed across session
            <span className="spacer" />
            <em>{files.length}</em>
          </div>
          <ChangesView files={files} selectedId={selectedId} liveId={liveId} />
        </>
      )}
    </div>
  );
}

// ---- Goal: always Session, selected turn highlighted (Board D) ---------------

function GoalByTurn({
  goal,
  turns,
  traces,
  liveUsage,
  selectedId,
}: {
  goal: Goal;
  turns: TurnVM[];
  traces: TurnTrace[];
  liveUsage: TurnUsage | null;
  selectedId: string | null;
}) {
  return (
    <div className="pn-body pn-goal-turns">
      {goal.tokenBudget ? (
        <BudgetByTurn
          traces={traces}
          budget={goal.tokenBudget}
          liveUsage={liveUsage}
          selectedTurnId={selectedId}
        />
      ) : (
        <div className="pn-h">Tokens by turn</div>
      )}
      <ul className="pn-contrib">
        {turns.map((t) => (
          <li key={t.id} className={t.id === selectedId ? "on" : undefined}>
            <span className={tcClass(t, selectedId)}>{t.label}</span>
            <span>{t.prompt || "No message"}</span>
            <span className="pn-mono">
              {t.tokens === null ? "—" : formatTokens(t.tokens)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Agents (Board E) -------------------------------------------------------------

function AgentsTurn({
  turn,
  helpers,
  sessionHelpers,
  last,
  onOpen,
  onSession,
}: {
  turn: TurnVM;
  helpers: Record<string, HelperInfo>;
  sessionHelpers: number;
  last: boolean;
  onOpen: (id: string) => void;
  onSession: () => void;
}) {
  return (
    <div className="pn-body">
      <div className="pn-h">
        <PanelIcon name="users" />
        Agents · {turn.label}
        <span className="spacer" />
        <em>{plural(turn.helperIds.length, "helper")}</em>
      </div>
      {turn.helperIds.length ? (
        turn.helperIds.map((id) => (
          <HelperLine key={id} id={id} info={helpers[id]} onOpen={onOpen} />
        ))
      ) : (
        <EmptySlice count={sessionHelpers} last={last} onSession={onSession} />
      )}
    </div>
  );
}

function AgentsSession({
  roster,
  selectedId,
  helperTokens,
  tokens,
  onOpen,
}: {
  roster: RosterRow[];
  selectedId: string | null;
  helperTokens: number;
  tokens: number;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="pn-body">
      <ul className="pn-roster" aria-label="Helper roster">
        {roster.map((r) => (
          <li key={r.name} className={`tone-${r.tone}`}>
            <button
              type="button"
              // page.tsx scrolls to this id; earlier runs anchor on their chips.
              id={`agent-card-${r.runs.at(-1)!.threadId}`}
              className="pn-rrow"
              onClick={() => onOpen(r.runs.at(-1)!.threadId)}
            >
              <HelperAvatar name={r.name} tone={r.tone} />
              <span className="who">
                <b>{r.name}</b>
                <span>{r.role || taskTitle(r.runs[0].agent.task)}</span>
              </span>
              <span className="pn-mono">{formatDuration(r.elapsedMs)}</span>
              <span className="pn-turnset">
                <span className="pill sm">{plural(r.runs.length, "run")}</span>
                {r.runs.map(
                  (run) =>
                    run.turnLabel && (
                      <span
                        key={run.threadId}
                        id={
                          run === r.runs.at(-1)
                            ? undefined
                            : `agent-card-${run.threadId}`
                        }
                        className={`pn-tc${run.turnId === selectedId ? " on" : ""}`}
                      >
                        {run.turnLabel}
                      </span>
                    ),
                )}
                {r.warning && <span className="pill warn sm">{r.warning}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {helperTokens > 0 && (
        <div className="pn-kv">
          <span>Helper tokens</span>
          <b>
            {formatTokens(helperTokens)} of {formatTokens(tokens)}
          </b>
        </div>
      )}
    </div>
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

// ---- Plan: versions kept as history (Board D) ---------------------------------

function StepMark({ status }: { status: string }) {
  if (status === "completed")
    return (
      <span className="mark done" aria-hidden="true">
        <PanelIcon name="check" sm={false} />
      </span>
    );
  if (status === "inProgress")
    return <span className="spinner" aria-hidden="true" />;
  return <span className="mark" aria-hidden="true" />;
}

const statusWords: Record<string, string> = {
  completed: "done",
  inProgress: "in progress",
  pending: "pending",
};

function PlanTab({
  versions,
  turns,
  scope,
  turn,
  liveId,
  awaitingApproval,
}: {
  versions: PlanVersion[];
  turns: TurnVM[];
  scope: Scope;
  turn: TurnVM | null;
  liveId: string | null;
  awaitingApproval: boolean;
}) {
  if (!versions.length)
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
  const order = turns.map((t) => t.id);
  const label = (id?: string) => turns.find((t) => t.id === id)?.label;
  const sliced = scope === "turn" && !!turn;
  const shown = sliced
    ? versionForTurn(versions, order, turn.id)
    : versions.at(-1)!;
  const latest = versions.at(-1)!;
  const liveLabel = label(liveId ?? undefined);
  const strip = (
    <div className="pn-vers" aria-label="Plan versions">
      {versions.map((v, i) => (
        <span key={v.version} className="row" style={{ gap: 6 }}>
          {i > 0 && <PanelIcon name="chev" />}
          <span
            className={`pn-ver${v === shown ? " cur" : v !== latest ? " gone" : ""}`}
          >
            v{v.version}
            {label(v.createdTurnId) ? ` · ${label(v.createdTurnId)}` : ""}
          </span>
        </span>
      ))}
    </div>
  );
  if (!shown)
    return (
      <div className="pn-body">
        {strip}
        <span className="pn-sub">No plan was active in {turn?.label}</span>
      </div>
    );
  const p = versionProgress(shown);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const running = p.current >= 0 ? shown.steps[p.current] : undefined;
  const runningIn = running && label(stepTurn(running));
  const advanced = sliced
    ? shown.steps.filter((s) => advancedIn(s, turn.id)).length
    : 0;
  const created = label(shown.createdTurnId);
  // Superseded cards: every earlier version, or those retired in the turn.
  const retired = versions
    .filter(
      (v) =>
        v.supersededTurnId !== undefined &&
        (!sliced || v.supersededTurnId === turn.id),
    )
    .reverse();
  return (
    <div className="pn-body">
      {strip}
      <div className="row">
        <span className="ring" style={{ "--p": pct } as CSSProperties}>
          <span>
            {p.done}/{p.total}
          </span>
        </span>
        <div className="grow">
          <span className="strong">Plan v{shown.version}</span>
          <span className="pn-sub">
            {[
              created && `Created in ${created}`,
              running &&
                `step ${p.current + 1} running${runningIn ? ` in ${runningIn}` : ""}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <span role="status" aria-live="polite">
          {awaitingApproval && <span className="pill warn">Awaiting approval</span>}
        </span>
      </div>
      <ol className="pn-plan" aria-label={`Plan v${shown.version} steps`}>
        {shown.steps.map((s, i) => {
          const adv = sliced && advancedIn(s, turn.id);
          const at = label(stepTurn(s));
          const cls = adv
            ? "adv"
            : s.status === "inProgress"
              ? "run"
              : s.status === "pending"
                ? "todo"
                : "done";
          const chip =
            (adv || !sliced || s.status === "inProgress") && at
              ? s.status === "completed"
                ? `done ${at}`
                : at
              : "";
          return (
            <li
              key={i}
              className={cls}
              aria-current={s.status === "inProgress" ? "step" : undefined}
            >
              <StepMark status={s.status} />
              <span>
                {s.step}
                <span className="sr-only">, {statusWords[s.status]}</span>
              </span>
              {chip ? (
                <span
                  className={`pn-tc${s.status === "inProgress" && stepTurn(s) === liveId ? " live" : ""}`}
                >
                  {chip}
                </span>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ol>
      {sliced &&
        (advanced ? (
          <span className="pn-sub">
            Highlighted: steps that advanced in {turn.label}
          </span>
        ) : (
          shown.createdTurnId !== turn.id && (
            <span className="pn-sub">No plan change in {turn.label}</span>
          )
        ))}
      {retired.map((v) => {
        const next = versions[v.version];
        const vp = versionProgress(v);
        const diff = next && planDiff(v.steps, next.steps);
        return (
          <details key={v.version} className="pn-hist">
            <summary>
              <PanelIcon name="chev" className="pn-chev" />
              <PanelIcon name="history" />
              <b>Plan v{v.version}</b>
              <span>
                · {vp.done} of {vp.total} done
                {label(v.supersededTurnId)
                  ? ` · superseded in ${label(v.supersededTurnId)}`
                  : " · superseded"}
              </span>
            </summary>
            <div className="pn-hist-body">
              <ol className="pn-plan">
                {v.steps.map((s, i) => (
                  <li key={i}>
                    <StepMark
                      status={s.status === "inProgress" ? "pending" : s.status}
                    />
                    <span>{s.step}</span>
                    <span />
                  </li>
                ))}
              </ol>
              {diff && (
                <div
                  className="diff"
                  role="group"
                  aria-label={`Changes from Plan v${v.version} to Plan v${next.version}`}
                >
                  <div className="hd">
                    v{v.version} to v{next.version} · {diff.label}
                  </div>
                  {diff.lines.map((l, i) => (
                    <div key={i} className={l.kind}>
                      {l.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
