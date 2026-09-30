"use client";
import { Icon } from "@/components/v2/icon";
import { Shell, Panel } from "@/components/v2/shell";
import { Sidebar, convoTime } from "@/components/v2/sidebar";
import { Topbar } from "@/components/v2/topbar";
import { Hero } from "@/components/v2/hero";
import { SearchPalette } from "@/components/v2/search-palette";
import {
  Composer,
  HELD_PLACEHOLDER,
  PLACEHOLDERS,
  STOPPING_PLACEHOLDER,
  SlashMenu,
  useRotatingPlaceholder,
} from "@/components/v2/composer";
import { FloatingDock } from "@/components/v2/floating-dock";
import { Popover } from "@/components/v2/popover";
import { AgentCard, AgentMenu } from "@/components/v2/agent-menu";
import { ConnectedCarts } from "@/components/connected-tools";
import { SessionBanner, SessionLockbar } from "@/components/v2/session-banner";
import { ErrorToast } from "@/components/v2/toast";
import {
  cartState,
  errorToast,
  sessionHealth,
  type McpServerInput,
} from "@/lib/vm-chrome";
import { streamError } from "@/lib/vm-stream";
import { AgentDialog } from "@/components/v2/agent-dialog";
import { tintOf } from "@/lib/agent-look";
import { UserMenu } from "@/components/v2/user-menu";
import { fitPanel, PANEL_W, CHAT_MIN, type PanelSize } from "@/lib/fit-panel";
import { useFollowActivity } from "@/lib/use-follow-activity";
import { useHotkeys } from "@/lib/use-hotkeys";
import { useTheme } from "@/lib/use-theme";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMessages } from "@/components/chat-messages";
import {
  applyChatEvent,
  addApprovals,
  historyEntries,
  mergeHistoryEntries,
  type Entry,
} from "@/lib/chat";
import { SessionActivity } from "@/components/session-activity";
import { McpSettings } from "@/components/mcp-settings";
import { AssistantTools } from "@/components/assistant-tools";
import { RequestDock } from "@/components/request-card";
import { applyPlanEvent, awaitingApproval, type PlanStep } from "@/lib/plan";
import { Sheet } from "@/components/sheet";
import { GoalBar } from "@/components/goal-bar";
import { awaitingReview, budgetHelp, goalCommand } from "@/lib/goal";
import { BudgetField } from "@/components/budget-field";
import { SmoothTextarea } from "@/components/smooth-textarea";
import { turnFailure, type TurnFailure } from "@/lib/goal-errors";
import { type ConversationFile } from "../../shared/assistant-capabilities";
import {
  api,
  ApiRequestError,
  base,
  errorRef,
  getTraces,
  listAgents,
  userMessage,
  warnFailure,
  type ErrorRef as ErrorRefValue,
} from "@/lib/api";
import {
  applySubAgentEvent,
  defaultDelegation,
  emptySubAgents,
  loadDelegation,
  rehydrate,
  saveDelegation,
  type DelegationPrefs,
  type SubAgentState,
} from "@/lib/subagents";
import { AgentsPanel } from "@/components/agents-panel";
import { SessionMenu, useProjects } from "@/components/project-sidebar";
import { createSessionBody, draftProject } from "@/lib/projects";
import { HelperChip } from "@/components/helper-chip";
import { transport } from "@/lib/transport";
import { ApprovalModePicker } from "@/components/approval-mode-picker";
import {
  approvalModesOff,
  loadApprovalModes,
  modePicker,
  setApprovalMode,
} from "@/lib/approval-mode";
import {
  applyObservabilityEvent,
  emptyObservability,
  mergeTraces,
  type ObservabilityState,
} from "@/lib/observability";
import { PrivacyNote } from "@/components/observability/privacy-note";
import { parseChatInput, suggestCommands } from "@/lib/slash-commands";
import type {
  AgentSummary,
  ApprovalMode,
  ApprovalModesConfig,
  PublicSession,
  DomainEvent,
  Goal,
  GoalReview,
  PendingRequest,
  TraceSummary,
  TurnTiming,
} from "../../shared/contracts";
import { agentHandle } from "../../shared/contracts";
// The public payload includes the alpha approval mode when it is enabled.
type Session = PublicSession;
export default function Home() {
  const [agents, setAgents] = useState<AgentSummary[]>([]),
    [agentId, setAgentId] = useState(""),
    [sessions, setSessions] = useState<Session[]>([]),
    [session, setSession] = useState<Session | null>(null);
  // Alpha approval modes. A choice made before the chat exists is kept here
  // and sent once the session is created.
  const [approvalModes, setApprovalModes] =
      useState<ApprovalModesConfig>(approvalModesOff),
    [draftMode, setDraftMode] = useState<ApprovalMode | null>(null),
    [modeError, setModeError] = useState(""),
    draftModeRef = useRef<ApprovalMode | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]),
    [events, setEvents] = useState<DomainEvent[]>([]),
    [pending, setPending] = useState<PendingRequest[]>([]);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [timings, setTimings] = useState<TurnTiming[]>([]);
  const [observability, setObservability] =
      useState<ObservabilityState>(emptyObservability),
    [traceSummary, setTraceSummary] = useState<TraceSummary | null>(null);
  const [text, setText] = useState(""),
    [error, setErrorText] = useState(""),
    // Code and request id of the error in the banner, when it has them.
    [errorDetail, setErrorDetail] = useState<ErrorRefValue | null>(null),
    [notice, setNotice] = useState(""),
    [commandOpen, setCommandOpen] = useState(false),
    [commandIndex, setCommandIndex] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [running, setRunning] = useState(false),
    [status, setStatus] = useState("Not connected"),
    // Bumped by "Retry" to open a fresh stream after it disconnected.
    [streamKey, setStreamKey] = useState(0),
    [slowReconnect, setSlowReconnect] = useState(false),
    // Codex is retrying the turn on its own after a transient error.
    [retrying, setRetrying] = useState(false),
    [sessionsFailed, setSessionsFailed] = useState(false),
    [health, setHealth] = useState<any>(null),
    [panel, setPanel] = useState<"mcp" | "tools" | "agents" | null>(null),
    [inspectorTab, setInspectorTab] = useState("activity"),
    [subAgents, setSubAgents] = useState<SubAgentState>(emptySubAgents),
    [delegation, setDelegation] = useState<DelegationPrefs>(defaultDelegation),
    [mcpVersion, setMcpVersion] = useState(0),
    [goal, setGoal] = useState<Goal | null>(null),
    [goalReview, setGoalReview] = useState<GoalReview | null>(null),
    [documents, setDocuments] = useState<ConversationFile[]>([]),
    // Why the last turn failed, shown with a stopped goal.
    [failure, setFailure] = useState<TurnFailure | null>(null),
    [goalMode, setGoalMode] = useState(false),
    [goalBudget, setGoalBudget] = useState<number | null>(null),
    [goalBudgetValid, setGoalBudgetValid] = useState(true),
    // The project a new chat will be created in (from a project's "+").
    [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  // Both panels start collapsed; the user opens them from the header.
  const [panels, setPanels] = useState({ sidebar: false, activity: false }),
    [panelSizes, setPanelSizes] = useState<
      Record<"list" | "detail", PanelSize>
    >({ list: "min", detail: "max" }),
    [helperOpen, setHelperOpen] = useState(false),
    [vw, setVw] = useState(1440),
    [paletteOpen, setPaletteOpen] = useState(false),
    [pop, setPop] = useState<null | "agent" | "agent-card" | "user">(null),
    [agentDialogOpen, setAgentDialogOpen] = useState(false),
    [composerFocused, setComposerFocused] = useState(false),
    [shellReady, setShellReady] = useState(false);
  const agentBtn = useRef<HTMLButtonElement>(null),
    userBtn = useRef<HTMLButtonElement>(null),
    pillRef = useRef<HTMLButtonElement>(null);
  // Turn chrome for the topbar pill: when the running turn started, a send
  // waiting for its turn, and a stop waiting for the turn to settle.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null),
    [sendPending, setSendPending] = useState(false),
    [stopping, setStopping] = useState(false),
    // Latest mcp.status per server name for this session.
    [mcpStatusByName, setMcpStatusByName] = useState<
      Record<
        string,
        Pick<McpServerInput, "status" | "failureReason" | "toolCount">
      >
    >({}),
    // The turn selected in the chat and the session panel, shared by both.
    [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const resetTurnChrome = () => {
    setTurnStartedAt(null);
    setSendPending(false);
    setStopping(false);
    setMcpStatusByName({});
    setSelectedTurnId(null);
  };
  // Follow activity: a new goal, plan or helper brings its tab forward.
  // Auto-opening uses the list size and never pushes an open sidebar out.
  const follow = useFollowActivity({
    panelOpen: panels.activity,
    vw,
    fitsOpen:
      !panels.sidebar ||
      fitPanel(vw, PANEL_W[panelSizes.list], CHAT_MIN[panelSizes.list], true, true)
        .sidebar,
    tab: inspectorTab,
    showTab: (tab, open) => {
      setInspectorTab(tab);
      if (open) setPanels((p) => ({ ...p, activity: true }));
    },
  });
  useEffect(() => {
    // Crossing into drawer widths (≤900) closes both panels, as on first load,
    // so shrinking the window doesn't leave a drawer covering the chat.
    let wide = innerWidth > 900;
    const onResize = () => {
      setVw(innerWidth);
      if (wide && innerWidth <= 900)
        setPanels({ sidebar: false, activity: false });
      wide = innerWidth > 900;
    };
    setVw(innerWidth);
    // Enable panel transitions only after the first fit, so load doesn't animate.
    requestAnimationFrame(() => setShellReady(true));
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  const scroll = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null),
    following = useRef(true),
    generation = useRef(0),
    sessionRef = useRef<Session | null>(null),
    seen = useRef(new Set<string>()),
    sending = useRef(false),
    commandAttempt = useRef<{
      sessionId: string;
      text: string;
      clientId: string;
    } | null>(null);
  // Setting a message always replaces the reference of the previous error.
  const setError = (message: string, detail: ErrorRefValue | null = null) => {
    setErrorText(message);
    setErrorDetail(message ? detail : null);
  };
  const reportError = (e: unknown) => setError(userMessage(e), errorRef(e));
  const refreshSessions = () =>
    api("/api/sessions")
      .then((list) => {
        setSessions(list);
        setSessionsFailed(false);
      })
      .catch((e) => {
        warnFailure("session list", e);
        setSessionsFailed(true);
      });
  const projects = useProjects(refreshSessions);
  const picker = modePicker(approvalModes, session, draftMode);
  const pendingProject = session
    ? null
    : draftProject(draftProjectId, projects.projects);
  // Mirror goal changes into the conversation list without a refetch.
  const syncSessionGoal = (id: string, next: Goal | null) =>
    setSessions((old) =>
      old.map((s) =>
        s._id === id
          ? {
              ...s,
              goal: next
                ? { objective: next.objective, status: next.status }
                : undefined,
            }
          : s,
      ),
    );
  const open = useCallback(async (id: string) => {
    const token = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setCommandOpen(false);
    setDraftProjectId(null);
    setModeError("");
    try {
      const data = await api("/api/sessions/" + id);
      if (token !== generation.current) return;
      sessionRef.current = data.session;
      setSession(data.session);
      setAgentId(data.session.agentId);
      following.current = true;
      const saved = addApprovals(
        historyEntries(data.messages),
        data.approvals || [],
      );
      setEntries(
        data.snapshot
          ? applyChatEvent(saved, {
              type: "snapshot",
              data: data.snapshot,
            } as DomainEvent)
          : saved,
      );
      setEvents([]);
      resetTurnChrome();

      seen.current.clear();
      setPending(data.snapshot?.pending || []);
      setSubAgents(rehydrate(emptySubAgents, data.snapshot?.subAgents || []));
      // The saved plan stays available when agent-core is unreachable.
      setPlan(data.snapshot?.plan || data.plan?.steps || []);
      setGoal(data.snapshot?.goal || null);
      setGoalReview(data.goalReview || null);
      setFailure(null);
      setTimings(data.snapshot?.timings || []);
      setObservability(
        data.snapshot
          ? applyObservabilityEvent(emptyObservability, {
              type: "snapshot",
              data: data.snapshot,
            } as DomainEvent)
          : emptyObservability,
      );
      setTraceSummary(null);
      void getTraces(id)
        .then((traceData) => {
          if (token !== generation.current) return;
          setObservability((old) => ({
            ...old,
            traces: mergeTraces(old.traces, traceData?.traces),
          }));
          setTraceSummary(traceData?.summary || null);
        })
        .catch((e) => warnFailure("traces", e));
      void api(`/api/sessions/${id}/timings`)
        .then((timingData) => {
          if (token === generation.current)
            setTimings((old) => [
              ...new Map(
                [...timingData.turns, ...old].map((t: TurnTiming) => [
                  t.turnId,
                  t,
                ]),
              ).values(),
            ]);
        })
        .catch((e) => warnFailure("timings", e));

      setRunning(!!data.snapshot && data.snapshot.state.kind !== "idle");
      if (data.recoveryError)
        setError(data.recoveryError, data.recoveryErrorRef ?? null);
      history.replaceState(null, "", "?session=" + id);
    } catch (e) {
      if (token === generation.current) reportError(e);
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }, []);
  // Browser-only preference; read after mount so server and client render match.
  useEffect(() => setDelegation(loadDelegation()), []);
  useEffect(() => {
    let live = true;
    void loadApprovalModes().then((config) => live && setApprovalModes(config));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    fetch(base + "/healthz", { signal: AbortSignal.timeout(10000) })
      .then((r) => {
        if (!r.ok) throw new Error(`Health check returned HTTP ${r.status}`);
        return r.json();
      })
      .then(setHealth)
      .catch((e) => {
        warnFailure("health check", e);
        setHealth({ ok: false });
      });
    api("/api/agents")
      .then((data) => {
        setAgents(data);
        setAgentId(data[0]?.id || "");
      })
      .catch(reportError)
      .finally(() => setLoading(false));
    void refreshSessions();
    const id = new URLSearchParams(location.search).get("session");
    if (id) void open(id);
  }, [open]);
  useEffect(() => {
    if (!session) return;
    const id = session._id;
    follow.reset();
    const reloadTranscript = () => {
      const token = generation.current;
      void api("/api/sessions/" + id)
        .then((data) => {
          if (token !== generation.current || sessionRef.current?._id !== id)
            return;
          setEntries((old) =>
            addApprovals(
              mergeHistoryEntries(data.messages, old),
              data.approvals || [],
            ),
          );
        })
        .catch((e) => {
          if (token === generation.current) reportError(e);
        });
    };
    // Reload what the stream may have missed, as the platform asks on resync.
    const resync = () => {
      reloadTranscript();
      void listAgents(id)
        .then((list) => {
          if (sessionRef.current?._id === id && Array.isArray(list))
            setSubAgents((old) => rehydrate(old, list));
        })
        .catch((e) => warnFailure("helper agents", e));
    };
    setRetrying(false);
    return transport.subscribe(
      id,
      (event) => {
        if (sessionRef.current?._id !== id) return;
        if (event.type !== "snapshot" && event.cursor) {
          if (seen.current.has(event.cursor)) return;
          seen.current.add(event.cursor);
          if (seen.current.size > 2000)
            seen.current.delete(seen.current.values().next().value!);
        }
        follow.onEvent(event);
        if (
          [
            "activity.updated",
            "subagent.spawned",
            "subagent.status",
            "subagent.completed",
            "turn.started",
            "turn.completed",
            "plan.updated",
            "diff.updated",
            "error",
          ].includes(event.type)
        )
          setEvents((old) => [...old.slice(-499), event]);
        const d = event.data;
        setEntries((old) => applyChatEvent(old, event));
        setSubAgents((old) => applySubAgentEvent(old, event));
        setObservability((old) => applyObservabilityEvent(old, event));
        setPlan((old) => applyPlanEvent(old, event));
        switch (event.type) {
          case "snapshot":
            setPending(d.pending);
            setRunning(d.state.kind !== "idle");
            if (d.state.kind === "idle") {
              setTurnStartedAt(null);
              setStopping(false);
            }
            setGoal(d.goal || null);
            syncSessionGoal(id, d.goal || null);
            setTimings((old) => [
              ...new Map(
                [...old, ...(d.timings || [])].map((t: TurnTiming) => [
                  t.turnId,
                  t,
                ]),
              ).values(),
            ]);

            reloadTranscript();
            break;
          case "resync.required":
            resync();
            break;
          case "turn.started":
            setRunning(true);
            setTurnStartedAt(Date.now());
            setSendPending(false);
            setFailure(null);
            setRetrying(false);

            break;
          case "goal.updated":
            setGoal(d.goal);
            syncSessionGoal(id, d.goal);
            // A goal that is no longer complete invalidates an earlier review.
            if (d.goal.status !== "complete") setGoalReview(null);
            break;
          case "goal.cleared":
            setGoal(null);
            syncSessionGoal(id, null);
            setGoalReview(null);
            break;
          case "turn.completed":
            setRunning(false);
            setTurnStartedAt(null);
            setSendPending(false);
            setStopping(false);
            setRetrying(false);
            if (d.turn?.error?.message) {
              const turnId = d.turn.id ?? event.turnId;
              setError(d.turn.error.message, {
                ...(typeof d.turn.error.code === "string"
                  ? { code: d.turn.error.code }
                  : {}),
                ...(typeof turnId === "string" ? { turnId } : {}),
              });
            }
            setFailure(turnFailure(d.turn?.error));
            if (d.timing)
              setTimings((old) => [
                ...old.filter((t) => t.turnId !== d.timing.turnId),
                d.timing,
              ]);
            break;
          case "mcp.status":
            if (typeof d?.name === "string")
              setMcpStatusByName((old) => ({
                ...old,
                [d.name]: {
                  status: d.status ?? null,
                  failureReason: d.failureReason ?? null,
                  toolCount:
                    typeof d.toolCount === "number" ? d.toolCount : null,
                },
              }));
            break;
          case "approval.requested":
            setPending((old) => [
              ...old.filter((p) => p.requestId !== d.requestId),
              d as PendingRequest,
            ]);
            break;
          case "approval.resolved":
            setPending((old) => old.filter((p) => p.requestId !== d.requestId));
            break;
          case "error":
            // Codex retries transient failures itself; only a final error
            // is a failure.
            if (d.willRetry === true) {
              setRetrying(true);
              break;
            }
            setRetrying(false);
            setSendPending(false);
            setError(d.message || "The request could not be completed.", {
              ...(typeof d.code === "string" ? { code: d.code } : {}),
              ...(typeof d.turnId === "string" ? { turnId: d.turnId } : {}),
            });
            setFailure(turnFailure(d));
            break;
        }
      },
      setStatus,
      {
        onResync: resync,
        onFailure: (f) =>
          setError(f.message, { code: f.code, requestId: f.requestId }),
      },
    );
  }, [session?._id, streamKey]);
  // A stream stuck reconnecting for a while gets a hint in the header.
  useEffect(() => {
    setSlowReconnect(false);
    if (status !== "Reconnecting") return;
    const timer = setTimeout(() => setSlowReconnect(true), 30000);
    return () => clearTimeout(timer);
  }, [status]);
  // The completion card lists documents made during the goal, so they are
  // loaded once the goal is ready for review.
  const reviewing = awaitingReview(goal, goalReview);
  useEffect(() => {
    setDocuments([]);
    if (!session?._id || !reviewing) return;
    let active = true;
    api(`/api/sessions/${session._id}/documents`)
      .then((data) => active && setDocuments(data.files || []))
      .catch((e) => warnFailure("documents", e));
    return () => {
      active = false;
    };
  }, [session?._id, reviewing]);
  useEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);
  useEffect(() => {
    if (following.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "instant",
      });
  }, [entries, pending]);
  // A plain new chat clears any project; a project's "+" passes its id.
  function startDraft(projectId: string | null = null) {
    generation.current++;
    setDraftProjectId(projectId);
    setText("");
    setNotice("");
    setCommandOpen(false);
    sessionRef.current = null;
    following.current = true;
    setSession(null);
    draftModeRef.current = null;
    setDraftMode(null);
    setModeError("");
    setEntries([]);
    setEvents([]);
    resetTurnChrome();

    setPending([]);
    setSubAgents(emptySubAgents);
    setPlan([]);
    setTimings([]);
    setObservability(emptyObservability);
    setTraceSummary(null);
    setGoal(null);
    setGoalReview(null);
    setFailure(null);

    setError("");
    setRunning(false);
    setBusy(false);
    setStatus("Not connected");
    seen.current.clear();
    history.replaceState(null, "", location.pathname);
    composer.current?.focus();
  }
  // Opens the session panel on the Agents tab; with a helper given, its card
  // is brought into view once rendered.
  function openAgents(threadId?: string) {
    follow.manual();
    setInspectorTab("agents");
    setPanels((p) => ({ ...p, activity: true }));
    if (threadId)
      setTimeout(() => {
        const card = document.getElementById(`agent-card-${threadId}`);
        card?.scrollIntoView({ block: "nearest" });
        card?.focus();
      }, 50);
  }
  // The chip jumps back to the newest helper block in the chat.
  function viewHelpers() {
    const blocks = document.querySelectorAll<HTMLElement>(".helper-group");
    const block = blocks[blocks.length - 1];
    if (!block) return openAgents();
    following.current = false;
    block.scrollIntoView({ block: "center" });
    block.focus({ preventScroll: true });
  }
  // Keep the open conversation's projectId in step with sidebar moves.
  function updateCurrentProject(updated: Session) {
    if (sessionRef.current?._id !== updated._id) return;
    const next = { ...sessionRef.current, projectId: updated.projectId };
    sessionRef.current = next;
    setSession(next);
  }
  function changeDelegation(next: DelegationPrefs) {
    setDelegation(next);
    saveDelegation(next);
  }
  // Optimistic: show the new mode at once and roll back if platform refuses.
  async function changeApprovalMode(
    mode: ApprovalMode,
    target: Session | null = sessionRef.current,
  ) {
    setModeError("");
    if (!target) {
      draftModeRef.current = mode;
      setDraftMode(mode);
      return;
    }
    const previous = target.approvalMode;
    const apply = (value: ApprovalMode | undefined) => {
      if (sessionRef.current?._id !== target._id) return;
      const next = { ...sessionRef.current, approvalMode: value };
      sessionRef.current = next;
      setSession(next);
    };
    apply(mode);
    try {
      apply(await setApprovalMode(target._id, mode));
    } catch (e) {
      apply(previous);
      if (sessionRef.current?._id === target._id)
        setModeError(
          e instanceof ApiRequestError && e.status === 422
            ? "Autopilot is not available right now."
            : `Could not change the approval mode. ${userMessage(e)}`,
        );
    }
  }
  async function ensureSession(): Promise<Session> {
    if (sessionRef.current) return sessionRef.current;
    const token = generation.current;
    const projectId = draftProject(draftProjectId, projects.projects)?._id;
    const created: Session = await api(
      "/api/sessions",
      createSessionBody(agentId, delegation, projectId),
    );
    if (token !== generation.current) return created;
    sessionRef.current = created;
    setSession(created);
    history.replaceState(null, "", "?session=" + created._id);
    const chosen = draftModeRef.current;
    draftModeRef.current = null;
    setDraftMode(null);
    // Settle the chosen mode before the first message so its turn uses it.
    if (chosen && chosen !== created.approvalMode)
      await changeApprovalMode(chosen, created);
    if (projectId) {
      projects.expand(projectId);
      projects.refreshAll();
    } else void refreshSessions();
    return created;
  }
  async function send(value = text) {
    if (
      sending.current ||
      !value.trim() ||
      busy ||
      (!sessionRef.current && !agentId)
    )
      return;
    sending.current = true;
    const token = generation.current;
    const clientId = crypto.randomUUID(),
      id = clientId;
    following.current = true;
    setText("");
    setError("");
    setEntries((old) => [
      ...old,
      {
        kind: "message",
        id,
        role: "user",
        text: value,
        delivery: "pending",
        at: new Date().toISOString(),
      },
    ]);
    // A steer joins the running turn, so there is no turn to wait for.
    if (!running) setSendPending(true);
    try {
      if (!sessionRef.current) setBusy(true);
      const active = await ensureSession();
      if (token !== generation.current) return;
      const result = await transport.send(active._id, value, clientId);
      if (token !== generation.current) return;
      void refreshSessions();
      setEntries((old) =>
        old.map((e) =>
          e.kind === "message" && e.id === id
            ? {
                ...e,
                delivery: "accepted",
                turnId: result.turnId,
                steer: result.steer,
              }
            : e,
        ),
      );
    } catch (e) {
      if (token !== generation.current) return;
      setSendPending(false);
      reportError(e);
      setEntries((old) =>
        old.map((e) =>
          e.kind === "message" && e.id === id
            ? { ...e, delivery: "unknown" }
            : e,
        ),
      );
    } finally {
      sending.current = false;
      if (token === generation.current) setBusy(false);
    }
  }

  // A follow-up shows in the composer for a moment, then sends like a typed
  // message. Any unsent draft comes back afterwards.
  const suggesting = useRef(false);
  function askSuggestion(question: string) {
    if (suggesting.current || sending.current || busy || running) return;
    suggesting.current = true;
    const token = generation.current,
      draft = text;
    setCommandOpen(false);
    setNotice("");
    setText(question);
    composer.current?.focus();
    setTimeout(() => {
      void (async () => {
        try {
          if (token !== generation.current) return;
          await send(question);
          if (draft.trim() && token === generation.current) setText(draft);
        } finally {
          suggesting.current = false;
        }
      })();
    }, 350);
  }

  const commandSuggestions = commandOpen ? suggestCommands(text) : [];
  function selectCommand(name: string) {
    setText(`${name} `);
    setCommandOpen(false);
    setCommandIndex(0);
    composer.current?.focus();
  }
  async function submitInput() {
    if (
      busy ||
      sending.current ||
      !text.trim() ||
      (!sessionRef.current && !agentId)
    )
      return;
    const selected = commandSuggestions[commandIndex];
    // Completing a partial name never executes a command.
    if (selected && selected.name !== text.toLowerCase()) {
      selectCommand(selected.name);
      return;
    }
    if (goalMode && !goalBudgetValid) {
      setNotice(budgetHelp);
      return;
    }
    const parsed = goalMode
      ? goalCommand(text, goalBudget)
      : parseChatInput(text);
    // Setting an objective edits an existing goal in place, so a new goal
    // from the composer clears the old one first and starts fresh.
    const replaceGoal = goalMode && !!goal;
    if (
      goalMode &&
      goal &&
      goal.status !== "complete" &&
      !window.confirm("Replace the current goal with this one?")
    )
      return;
    const input =
      parsed.kind === "help" && sessionRef.current
        ? { kind: "command" as const, method: "help", params: {}, success: "" }
        : parsed;
    if (input.kind === "message") {
      setCommandOpen(false);
      setNotice("");
      await send(input.text);
      return;
    }
    setCommandOpen(false);
    if (input.kind === "panel") {
      setText("");
      setNotice("");
      if (input.panel === "agents") openAgents();
      else setPanel(input.panel);
      return;
    }
    if (input.kind === "invalid") {
      setNotice(input.message);
      return;
    }
    if (input.kind === "help") {
      setNotice(
        "Commands: /goal [objective|show|pause|resume|budget <tokens>|clear], /fork, /compact, /model <identifier>, /effort <level>, /archive, /unarchive, /tools, /mcp. Use // to send a literal command as a question.",
      );
      setText("");
      return;
    }
    if (running) {
      setNotice(
        "Wait for the current response to finish or press Stop before running a command. Your draft is saved.",
      );
      return;
    }
    let active = sessionRef.current;
    if (!active) {
      // A goal can open a conversation; other commands need an existing one.
      const objective =
        input.method === "thread/goal/set" ? input.params.objective : undefined;
      if (typeof objective !== "string" || !objective.trim()) {
        setNotice(
          "Start a conversation with a message before using this command. Your draft is saved.",
        );
        return;
      }
      try {
        setBusy(true);
        active = await ensureSession();
      } catch (e) {
        reportError(e);
        setBusy(false);
        return;
      }
    }
    const token = generation.current;
    const commandText = text;
    const previous = commandAttempt.current;
    const clientId =
      previous?.sessionId === active._id && previous.text === text
        ? previous.clientId
        : crypto.randomUUID();
    commandAttempt.current = { sessionId: active._id, text, clientId };
    following.current = true;
    setEntries((old) =>
      old.some((entry) => entry.id === clientId)
        ? old
        : [
            ...old,
            {
              kind: "message",
              id: clientId,
              role: "user",
              text: commandText,
              delivery: "pending",
              at: new Date().toISOString(),
              command: {
                method: input.method,
                params: input.params,
                state: "running",
              },
            },
          ],
    );
    sending.current = true;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      if (replaceGoal)
        await api(`/api/sessions/${active._id}/capabilities`, {
          method: "thread/goal/clear",
          params: {},
        });
      const result = await api(`/api/sessions/${active._id}/capabilities`, {
        method: input.method,
        params: input.params,
        command: { clientId, text: commandText },
      });
      if (token !== generation.current) return;
      const saved = historyEntries([result.commandMessage])[0];
      setEntries((old) =>
        old.map((entry) => (entry.id === clientId ? saved : entry)),
      );
      if (["succeeded", "failed"].includes(result.commandMessage.command.state))
        commandAttempt.current = null;
      const record = result.commandMessage.command;
      if (
        record.state === "succeeded" &&
        record.method.startsWith("thread/goal/")
      ) {
        setGoal(record.result?.goal ?? null);
        syncSessionGoal(active._id, record.result?.goal ?? null);
        if (record.method !== "thread/goal/get") setGoalReview(null);
        if (record.method === "thread/goal/set") {
          setGoalMode(false);
          setGoalBudget(null);
        }
      }
      if (result.commandMessage.command.state === "succeeded") setText("");
      void refreshSessions();
    } catch (e) {
      if (token === generation.current) {
        setEntries((old) =>
          old.map((entry) =>
            entry.id === clientId && entry.kind === "message"
              ? {
                  ...entry,
                  delivery: "unknown",
                  command: {
                    ...entry.command!,
                    state: "unknown",
                    error:
                      "Connection interrupted. Refresh the conversation to check the saved result before trying again.",
                  },
                }
              : entry,
          ),
        );
        reportError(e);
      }
    } finally {
      sending.current = false;
      if (token === generation.current) setBusy(false);
    }
  }
  const agent = agents.find((a) => a.id === agentId);
  // Fill the composer from a panel or starter; focus after the sheet closes.
  function startGoal(template = "") {
    setPanel(null);
    setGoalMode(true);
    setCommandOpen(false);
    setText(template);
    setTimeout(() => {
      const el = composer.current;
      el?.focus();
      el?.setSelectionRange(template.length, template.length);
    }, 0);
  }
  function applyPrompt(prompt: string) {
    if (prompt.trim() === "/goal") return startGoal();
    setPanel(null);
    setText(prompt);
    setCommandOpen(prompt.startsWith("/"));
    setTimeout(() => composer.current?.focus(), 0);
  }
  const empty = !session && !entries.length;
  const { isDark, toggle: toggleTheme } = useTheme();
  const rotatingPlaceholder = useRotatingPlaceholder(
    empty && !composerFocused && !text && !goalMode,
  );
  // Session panel sizing (spec Layout §2): each mode remembers its own size.
  const panelMode = inspectorTab === "agents" && helperOpen ? "detail" : "list";
  const panelSize = panelSizes[panelMode];
  const fit = fitPanel(
    vw,
    PANEL_W[panelSize],
    CHAT_MIN[panelSize],
    panels.sidebar,
    panels.activity,
  );
  const sidebarShown = panels.sidebar && fit.sidebar;
  // Opening the sidebar wins: the panel shrinks to min if that fits, else closes.
  function toggleSidebar() {
    if (sidebarShown) return setPanels((p) => ({ ...p, sidebar: false }));
    const fits = (s: PanelSize) =>
      fitPanel(vw, PANEL_W[s], CHAT_MIN[s], true, true).sidebar;
    if (panels.activity && !fits(panelSize)) {
      if (panelSize === "max" && fits("min"))
        setPanelSizes((s) => ({ ...s, [panelMode]: "min" }));
      else setPanels((p) => ({ ...p, activity: false }));
    }
    setPanels((p) => ({ ...p, sidebar: true }));
  }
  function toggleActivity() {
    if (panels.activity) follow.dismiss();
    setPanels((p) => ({ ...p, activity: !p.activity }));
  }
  function newChat() {
    if (!busy) startDraft();
  }
  useHotkeys({
    "mod+k": () => setPaletteOpen((o) => !o),
    "mod+b": toggleSidebar,
    "mod+.": toggleActivity,
    "mod+j": newChat,
  });
  const togglePop = (next: "agent" | "agent-card" | "user") =>
    setPop((cur) => (cur === next ? null : next));
  // The list refreshes with the server-generated title; the open session may not.
  const crumbTitle = session
    ? sessions.find((s) => s._id === session._id)?.title ||
      session.title ||
      "Untitled conversation"
    : entries.length
      ? "New conversation"
      : "";
  const stateText =
    session && status === "Reconnecting"
      ? slowReconnect
        ? "still reconnecting…"
        : "reconnecting…"
      : session && status === "Disconnected"
        ? "disconnected"
        : retrying
          ? "retrying…"
          : running
            ? goal?.status === "active"
              ? "working on goal"
              : "working"
            : "ready";
  function stopTurn() {
    setStopping(true);
    void (async () => {
      const id = session!._id;
      try {
        // An active goal restarts on its own once the thread is
        // idle, so pause it before stopping the turn.
        if (goal?.status === "active") {
          const data = await api(`/api/sessions/${id}/capabilities`, {
            method: "thread/goal/set",
            params: { status: "paused" },
          });
          setGoal(data.goal);
          syncSessionGoal(id, data.goal);
        }
        await transport.interrupt(id).catch((e) => {
          // The turn already ended, so there is nothing to stop.
          if (!(e instanceof ApiRequestError && e.status === 409)) throw e;
          setStopping(false);
        });
      } catch (e) {
        setStopping(false);
        reportError(e);
      }
    })();
  }
  const chatHealth = sessionHealth(session);
  const orphaned = chatHealth?.kind === "orphaned";
  const held = pending.length > 0;
  const toolIssues = Object.entries(mcpStatusByName).filter(([name, s]) =>
    ["auth", "failed"].includes(cartState({ id: name, name, ...s })),
  ).length;
  const projectName = session
    ? session.projectId
      ? projects.projects.find((p) => p._id === session.projectId)?.name
      : null
    : pendingProject?.name;
  // Turn number: one per distinct turn the user started.
  const turnCount = new Set(
    entries.flatMap((e) =>
      e.kind === "message" && e.role === "user" && e.turnId ? [e.turnId] : [],
    ),
  ).size;
  // Turn errors render inline in the stream; everything else is a toast.
  const turnError = !!errorDetail?.turnId;
  const focusComposerAtEnd = (value: string) =>
    setTimeout(() => {
      const el = composer.current;
      el?.focus();
      el?.setSelectionRange(value.length, value.length);
    }, 0);
  const composerForm = (
    <form
      className="composer-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submitInput();
      }}
    >
      <Composer
        hero={empty}
        goalMode={goalMode}
        onGoalToggle={() => (goalMode ? setGoalMode(false) : startGoal(text))}
        onGoalCancel={() => setGoalMode(false)}
        busy={running}
        stopping={stopping}
        held={held}
        canSend={!!text.trim() && !busy && (!!session || !!agentId)}
        onStop={stopTurn}
        requests={
          session && pending.length ? (
            <RequestDock
              pending={pending}
              plan={plan}
              onAnswer={async (requestId, value) => {
                await transport.answer(session._id, requestId, value);
              }}
              onRequestChanges={(steps) => {
                const quoted = `Please change the plan:\n${steps
                  .map((s, i) => `> ${i + 1}. ${s.step}`)
                  .join("\n")}\n\n`;
                setCommandOpen(false);
                setText(quoted);
                focusComposerAtEnd(quoted);
              }}
            />
          ) : undefined
        }
        slash={
          commandSuggestions.length ? (
            <SlashMenu
              commands={commandSuggestions}
              activeIndex={commandIndex}
              onPick={selectCommand}
            />
          ) : undefined
        }
        stopTitle={
          goal?.status === "active"
            ? "Pause the goal and stop the current response"
            : "Stop the current response"
        }
        onFocusChange={setComposerFocused}
        above={
          <>
            {pendingProject && (
              <div className="composer-project" role="status">
                <Icon name="folder" size={13} />
                <span>
                  New chat in <strong>{pendingProject.name}</strong>
                </span>
                <button
                  type="button"
                  className="icon-btn ghost"
                  onClick={() => setDraftProjectId(null)}
                  aria-label={`Don't add to ${pendingProject.name}`}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            )}
            <PrivacyNote draft={text} />
          </>
        }
        below={
          <>
            <span id="composer-hint" className="sr-only">
              Type / for commands. Enter to send, Shift + Enter for a new line.
            </span>
            {notice && (
              <div className="composer-notice" role="status">
                {notice}
              </div>
            )}
            {modeError && (
              <div
                id="approval-mode-error"
                className="composer-notice approval-mode-error"
                role="alert"
              >
                {modeError}
              </div>
            )}
          </>
        }
        budget={
          <BudgetField
            variant="chip"
            initial={goalBudget}
            onChange={({ tokens, valid }) => {
              setGoalBudget(tokens);
              setGoalBudgetValid(valid);
            }}
          />
        }
        chips={
          <>
            {picker && (
              <ApprovalModePicker
                picker={picker}
                errorId={modeError ? "approval-mode-error" : undefined}
                onChange={(mode) => void changeApprovalMode(mode)}
              />
            )}
          </>
        }
      >
        <SmoothTextarea
          ref={composer}
          aria-label={goalMode ? "Goal" : "Message"}
          aria-describedby="composer-hint"
          aria-controls={
            commandSuggestions.length ? "chat-commands" : undefined
          }
          aria-haspopup="listbox"
          aria-expanded={commandSuggestions.length > 0}
          aria-activedescendant={
            commandSuggestions.length
              ? `chat-command-${commandIndex}`
              : undefined
          }
          placeholder={
            chatHealth?.kind === "orphaned"
              ? chatHealth.placeholder
              : stopping
                ? STOPPING_PLACEHOLDER
                : held
                  ? HELD_PLACEHOLDER
                  : goalMode
              ? "Describe the outcome you want. The assistant works until it’s done."
              : running
                ? "Add a thought to steer the current turn…"
                : empty
                  ? rotatingPlaceholder
                  : PLACEHOLDERS[0]
          }
          value={text}
          disabled={busy || (!session && !agentId) || orphaned}
          onChange={(e) => {
            setText(e.target.value);
            setCommandOpen(!goalMode && e.target.value.startsWith("/"));
            setCommandIndex(0);
            if (notice) setNotice("");
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape") {
              if (goalMode && !commandSuggestions.length) setGoalMode(false);
              setCommandOpen(false);
              return;
            }
            if (
              commandSuggestions.length &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey
            ) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const direction = e.key === "ArrowDown" ? 1 : -1;
                setCommandIndex(
                  (index) =>
                    (index + direction + commandSuggestions.length) %
                    commandSuggestions.length,
                );
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                selectCommand(commandSuggestions[commandIndex].name);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submitInput();
            }
          }}
        />
      </Composer>
    </form>
  );
  return (
    <Shell className={shellReady ? "is-ready" : undefined}>
      <Panel kind="sidebar" open={sidebarShown} label="Conversations">
        <Sidebar
          sessions={sessions}
          activeId={session?._id}
          onOpen={(id) => void open(id)}
          onNew={newChat}
          onSearch={() => setPaletteOpen(true)}
          onAgents={() => setPop("agent")}
          onSettings={() => setPanel("mcp")}
          busy={busy}
          loadError={sessionsFailed ? "Couldn’t refresh" : null}
          onRetry={() => void refreshSessions()}
          renderRowMenu={(s) => (
            <SessionMenu
              session={s}
              state={projects}
              disabled={busy}
              onUpdated={updateCurrentProject}
            />
          )}
        />
      </Panel>
      <main className="stage">
        <Topbar
          sidebarShown={sidebarShown}
          title={crumbTitle}
          agentName={loading ? "Loading agents…" : agent?.name || "No agent"}
          stateText={stateText}
          busy={running}
          turn={{
            running,
            starting: sendPending && !running,
            stopping,
            pendingCount: pending.length,
            sessionStatus: session?.status,
            startedAt: turnStartedAt,
          }}
          toolIssues={toolIssues}
          project={projectName}
          turnChip={running && turnCount ? `T${turnCount}` : null}
          pillOpen={pop === "agent-card"}
          pillRef={pillRef}
          onStatusClick={() => togglePop("agent-card")}
          popover={
            <Popover
              bare
              className="ch-pop"
              open={pop === "agent-card"}
              onClose={() => setPop(null)}
              ignoreRef={pillRef}
              aria-label="Agent details"
            >
              <AgentCard
                name={agent?.name || "No agent"}
                model={agent?.model}
                provider={agent?.provider}
                sandbox={agent?.sandbox}
                onEdit={() => {
                  setPop(null);
                  setAgentDialogOpen(true);
                }}
                onModel={() => {
                  setPop(null);
                  setCommandOpen(false);
                  setText("/model ");
                  focusComposerAtEnd("/model ");
                }}
                tools={
                  agentId ? (
                    <ConnectedCarts
                      agentId={agentId}
                      refreshKey={mcpVersion}
                      status={mcpStatusByName}
                      onManage={() => {
                        setPop(null);
                        setPanel("mcp");
                      }}
                    />
                  ) : null
                }
              />
            </Popover>
          }
          isDark={isDark}
          onToggleTheme={toggleTheme}
          actions={
            session && status === "Disconnected" ? (
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  setStatus("Reconnecting");
                  setStreamKey((k) => k + 1);
                }}
              >
                Reconnect
              </button>
            ) : null
          }
        />
        {session && goal && (
          <GoalBar
            key={session._id}
            sessionId={session._id}
            goal={goal}
            review={goalReview}
            onChange={(next, review) => {
              setGoal(next);
              setGoalReview(review);
              syncSessionGoal(session._id, next);
            }}
            onReopen={(feedback) =>
              applyPrompt(
                feedback
                  ? `The goal isn’t complete yet: ${feedback}`
                  : "The goal isn’t complete yet. Please keep working on it.",
              )
            }
            onProvideInput={() => {
              setPanel(null);
              setTimeout(() => composer.current?.focus(), 0);
            }}
            onFollowUp={() => startGoal()}
            running={running}
            entries={entries}
            documents={documents}
            documentHref={(id) =>
              `${base}/api/sessions/${session._id}/documents/${encodeURIComponent(id)}`
            }
            failure={failure}
            provider={agents.find((a) => a.id === session.agentId)?.provider}
          />
        )}
        <SessionBanner
          health={chatHealth}
          reconnecting={status === "Reconnecting"}
          onReconnect={() => {
            setStatus("Reconnecting");
            setStreamKey((k) => k + 1);
          }}
          onNewChat={newChat}
        />
        <div
          className="scroll"
          role="log"
          aria-label="Conversation"
          aria-live="off"
          ref={scroll}
          onScroll={() => {
            const el = scroll.current;
            if (el)
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {empty ? (
            <Hero>
              {composerForm}
              {!loading && !agents.length && (
                <p className="muted sm">
                  No agents are available. Contact your Truex administrator.
                </p>
              )}
            </Hero>
          ) : (
            <div className="thread">
              <ChatMessages
                sessionId={session?._id}
                onPrompt={(prompt) => {
                  setText(prompt);
                  setCommandOpen(false);
                  composer.current?.focus();
                }}
                entries={entries}
                traces={observability.traces}
                liveUsage={observability.liveUsage}
                goal={goal}
                goalReview={goalReview}
                subAgents={subAgents}
                onOpenAgent={openAgents}
                onSuggest={askSuggestion}
                suggestionsEnabled={
                  !busy && !goalMode && !failure && !pending.length
                }
                agentName={agent?.name || "Assistant"}
                running={running}
                onCommand={(command) => {
                  setText(command);
                  setCommandOpen(false);
                  composer.current?.focus();
                }}
                onOpen={(id) => void open(id)}
                onRefresh={() => session && void open(session._id)}
                timings={timings}
                rateLimits={observability.rateLimits}
                pending={pending}
                error={
                  // Turn errors show inline; all other errors show as the toast.
                  turnError ? streamError(error, errorDetail, failure) : null
                }
                onRetryTurn={() => {
                  const last = entries.findLast(
                    (e) => e.kind === "message" && e.role === "user" && !e.command,
                  );
                  if (last?.kind === "message") void send(last.text);
                }}
                onRetryMessage={(e) => void send(e.text)}
                selectedTurnId={selectedTurnId}
                // "Turn N, show in session panel": open the panel on that turn.
                onSelectTurn={(id) => {
                  follow.manual();
                  setSelectedTurnId(id);
                  setPanels((p) => ({ ...p, activity: true }));
                }}
              />
            </div>
          )}
        </div>
        <div className="bottom">
          <ErrorToast
            toast={
              turnError ? null : errorToast({ message: error, ref: errorDetail })
            }
            onDismiss={() => setError("")}
          />
          {!empty && <HelperChip state={subAgents} onView={viewHelpers} />}
          {!empty &&
            (chatHealth?.kind === "dead" || chatHealth?.kind === "archived" ? (
              <SessionLockbar health={chatHealth} onNewChat={newChat} />
            ) : (
              composerForm
            ))}
          <div className="dock-wrap">
            <Popover
              open={pop === "agent"}
              onClose={() => setPop(null)}
              className="pop-agent"
              ignoreRef={agentBtn}
              aria-label="Choose agent"
            >
              <AgentMenu
                agents={agents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  description: a.description,
                  hue: tintOf(a.tint).dot,
                }))}
                currentId={agentId}
                onPick={(id) => {
                  setAgentId(id);
                  setPop(null);
                }}
                onNew={() => {
                  setPop(null);
                  setAgentDialogOpen(true);
                }}
              />
            </Popover>
            <Popover
              open={pop === "user"}
              onClose={() => setPop(null)}
              className="pop-user"
              ignoreRef={userBtn}
              aria-label="Account"
            >
              <UserMenu
                onSettings={() => {
                  setPop(null);
                  setPanel("mcp");
                }}
              />
            </Popover>
            <FloatingDock
              groups={[3, 5]}
              items={[
                {
                  id: "sidebar",
                  label: "Sidebar",
                  icon: "sidebar",
                  kbd: "⌘B",
                  active: sidebarShown,
                  onClick: toggleSidebar,
                },
                {
                  id: "search",
                  label: "Search",
                  icon: "search",
                  kbd: "⌘K",
                  onClick: () => setPaletteOpen(true),
                },
                {
                  id: "new",
                  label: "New chat",
                  icon: "plus",
                  kbd: "⌘J",
                  onClick: newChat,
                },
                {
                  id: "agent",
                  label: "Agent",
                  icon: "bot",
                  active: pop === "agent",
                  onClick: () => togglePop("agent"),
                  buttonRef: agentBtn,
                },
                {
                  id: "activity",
                  label: "Activity",
                  icon: "activity",
                  kbd: "⌘.",
                  active: panels.activity,
                  badge:
                    pending.length + (turnError && !panels.activity ? 1 : 0) ||
                    (running && !panels.activity),
                  onClick: toggleActivity,
                },
                {
                  id: "user",
                  label: "Account",
                  icon: "user",
                  active: pop === "user",
                  onClick: () => togglePop("user"),
                  buttonRef: userBtn,
                },
              ]}
            />
          </div>
        </div>
      </main>
      <p className="sr-only" role="status" aria-live="polite">
        {follow.announce}
      </p>
      <Panel
        kind="activity"
        open={panels.activity}
        overlay={fit.overlay}
        width={fit.width}
        label="Session activity"
      >
        <SessionActivity
          events={events}
          entries={entries}
          turnId={selectedTurnId}
          onTurn={setSelectedTurnId}
          plan={plan}
          awaitingApproval={awaitingApproval(pending)}
          timings={timings}
          traces={observability.traces}
          traceSummary={traceSummary}
          rateLimits={observability.rateLimits}
          liveUsage={
            running
              ? (Object.values(observability.liveUsage).at(-1) ?? null)
              : null
          }
          sessionId={session?._id}
          goal={goal}
          goalReview={goalReview}
          tab={inspectorTab}
          onTab={(t) => {
            follow.manual();
            setInspectorTab(t);
          }}
          follow={follow.enabled}
          onFollow={follow.setEnabled}
          subAgents={subAgents}
          delegation={delegation}
          onDelegation={changeDelegation}
          agentName={agent?.name}
          open={panels.activity}
          wide={panelSize === "max"}
          onToggleWide={() =>
            setPanelSizes((s) => ({
              ...s,
              [panelMode]: s[panelMode] === "max" ? "min" : "max",
            }))
          }
          onClose={() => {
            follow.dismiss();
            setPanels((p) => ({ ...p, activity: false }));
          }}
          onDetailChange={setHelperOpen}
        />
      </Panel>
      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={sessions.map((s) => ({
          id: s._id,
          title: s.title || "New conversation",
          time: convoTime(s.createdAt),
        }))}
        onPick={(id) => void open(id)}
      />
      <AgentDialog
        open={agentDialogOpen}
        agents={agents}
        onClose={() => setAgentDialogOpen(false)}
        onCreated={(a) => setAgents((list) => [...list, a])}
        // Source: close, start a new chat with the agent, pre-fill "@handle hi, ".
        onSayHi={(a) => {
          setAgentDialogOpen(false);
          newChat();
          setAgentId(a.id);
          const t = `@${a.handle || agentHandle(a.name)} hi, `;
          setText(t);
          setTimeout(() => {
            const el = composer.current;
            el?.focus();
            el?.setSelectionRange(t.length, t.length);
          }, 0);
        }}
      />
      <Sheet
        open={panel === "tools"}
        title="Capabilities, documents & visuals"
        description="Start from a capability, or work with this conversation’s files."
        onClose={() => setPanel(null)}
      >
        <AssistantTools
          key={session?._id || "new"}
          sessionId={session?._id}
          refreshKey={timings.length}
          running={running}
          onPrompt={applyPrompt}
          onFork={(id) => {
            setPanel(null);
            void refreshSessions();
            void open(id);
          }}
        />
      </Sheet>
      <Sheet
        open={panel === "mcp"}
        title="Connected tools"
        description={`MCP servers attached to ${agent?.name || "this agent"}. Changes apply to new chats.`}
        onClose={() => setPanel(null)}
      >
        {agentId ? (
          <McpSettings
            key={agentId}
            agentId={agentId}
            onSaved={() => setMcpVersion((v) => v + 1)}
          />
        ) : (
          <p className="muted">Select an agent to manage its tools.</p>
        )}
      </Sheet>
    </Shell>
  );
}
