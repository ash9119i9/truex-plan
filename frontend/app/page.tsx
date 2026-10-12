"use client";
import { Icon } from "@/components/v2/icon";
import { Shell, Panel } from "@/components/v2/shell";
import { Sidebar, convoTime } from "@/components/v2/sidebar";
import { Topbar } from "@/components/v2/topbar";
import { Hero } from "@/components/v2/hero";
import { SearchPalette } from "@/components/v2/search-palette";
import {
  Composer,
  PLACEHOLDERS,
  useRotatingPlaceholder,
} from "@/components/v2/composer";
import { FloatingDock } from "@/components/v2/floating-dock";
import { Popover } from "@/components/v2/popover";
import { AgentMenu } from "@/components/v2/agent-menu";
import { AgentDialog } from "@/components/v2/agent-dialog";
import { AgentsView } from "@/components/v2/agents-view";
import { tintOf } from "@/lib/agent-look";
import { UserMenu } from "@/components/v2/user-menu";
import {
  SessionGate,
  type SessionActions,
} from "@/components/auth/session-gate";
import { meKey, type Me } from "@/lib/session";
import { fitPanel, PANEL_W, CHAT_MIN, type PanelSize } from "@/lib/fit-panel";
import { useFollowActivity } from "@/lib/use-follow-activity";
import { useHotkeys } from "@/lib/use-hotkeys";
import { useTheme } from "@/lib/use-theme";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppliedState } from "@/lib/use-applied-state";
import { SessionCache } from "@/lib/session-cache";
import { SessionHistory } from "@/lib/session-history";
import {
  advanceSourceSync,
  beginSourceSync,
  overlaySourceEntries,
  SynchronizationWaiter,
  type SourcePair,
} from "@/lib/source-sync";
import {
  ChatMessages,
  type ChatTimelineProps,
} from "@/components/chat-messages";
import type { LegendListRef } from "@legendapp/list/react";
import { timelineAnchorIndex } from "@/lib/timeline-anchor";
import {
  applyChatEvent,
  addApprovals,
  historyEntries,
  mergeHistoryWindow,
  type Entry,
} from "@/lib/chat";
import { SessionActivity } from "@/components/session-activity";
import { McpSettings } from "@/components/mcp-settings";
import { AssistantTools } from "@/components/assistant-tools";
import { RequestCard } from "@/components/request-card";
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
import { ErrorRef } from "@/components/error-ref";
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
import { SessionPreparation } from "@/lib/session-preparation";
import { coalesceChatEvents } from "@/lib/chat-batch";
import {
  ComposerDraft,
  ApprovalConfirmation,
  type DispatchState,
} from "@/lib/composer-submission";
import { messageTextError } from "../../shared/message-input";
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
import {
  parseChatInput,
  suggestCommands,
  SLASH_COMMANDS_ENABLED,
} from "@/lib/slash-commands";
import type {
  AgentSummary,
  AgentDetails,
  ApprovalRecord,
  Message,
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
import { fetchAgent } from "@/lib/agents";
// The public payload includes the alpha approval mode when it is enabled.
type Session = PublicSession;
type HistoryWindow = { hasOlder: boolean; beforeCursor: string | null };
type SavedConversation = {
  session: Session;
  entries: Entry[];
  plan: PlanStep[];
  timings: TurnTiming[];
  observability: ObservabilityState;
  traceSummary: TraceSummary | null;
  subAgents: SubAgentState;
  events: DomainEvent[];
  goal: Goal | null;
  goalReview: GoalReview | null;
  text: string;
  historyWindow: HistoryWindow | null;
  expanded: boolean;
  scrollTop: number;
  following: boolean;
  anchor?: { id: string; offset: number };
};
type SessionHistoryPayload = {
  session: Session;
  messages: Message[];
  snapshot: DomainEvent["data"] | null;
  approvals: ApprovalRecord[];
  plan: { steps: PlanStep[] } | null;
  goalReview: GoalReview | null;
  recoveryError: string | null;
  recoveryErrorRef: ErrorRefValue | null;
  historyWindow: HistoryWindow | null;
};
// Nothing below runs until the platform has said who is signed in. The
// workspace is keyed by person and workspace, so a different identity gets a
// fresh tree: no state, stream or in-flight request carries over.
export default function Home() {
  return (
    <SessionGate>
      {(me, actions) => (
        // A new role remounts too: what an admin was reading may not be
        // readable once demoted, and nothing already loaded should linger.
        <Workspace key={`${meKey(me)}:${me.role}`} me={me} actions={actions} />
      )}
    </SessionGate>
  );
}
function Workspace({ me, actions }: { me: Me; actions: SessionActions }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]),
    [agentId, setAgentId] = useState(""),
    [sessions, setSessions] = useState<Session[]>([]),
    [session, setSession] = useState<Session | null>(null),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [openingId, setOpeningId] = useState<string | null>(null),
    [historyWindow, setHistoryWindow] = useState<HistoryWindow | null>(null),
    [olderLoading, setOlderLoading] = useState(false),
    [paintedConversation, setPaintedConversation] =
      useState<SavedConversation | null>(null),
    [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  // Alpha approval modes. A choice made before the chat exists is kept here
  // and sent once the session is created.
  const [approvalModes, setApprovalModes] =
      useState<ApprovalModesConfig>(approvalModesOff),
    [draftMode, setDraftMode] = useState<ApprovalMode | null>(null),
    [modeError, setModeError] = useState(""),
    [changingMode, setChangingMode] = useState(false),
    modeChanging = useRef(false),
    draftModeRef = useRef<ApprovalMode | null>(null);
  const [entries, setEntries, entriesRef] = useAppliedState<Entry[]>([]);
  const [events, setEvents] = useState<DomainEvent[]>([]),
    [pending, setPending] = useState<PendingRequest[]>([]);
  const [plan, setPlan, planRef] = useAppliedState<PlanStep[]>([]);
  const [timings, setTimings] = useState<TurnTiming[]>([]);
  const [observability, setObservability, observabilityRef] =
      useAppliedState<ObservabilityState>(emptyObservability),
    [traceSummary, setTraceSummary] = useState<TraceSummary | null>(null);
  const draft = useRef(new ComposerDraft());
  const approvalConfirmation = useRef(new ApprovalConfirmation());
  const [dispatchState, setDispatchState] = useState<DispatchState>(null);
  const [text, setTextState] = useState(""),
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
    [panel, setPanel] = useState<"mcp" | "tools" | "agents" | null>(null),
    [inspectorTab, setInspectorTab] = useState("activity"),
    [subAgents, setSubAgents, subAgentsRef] =
      useAppliedState<SubAgentState>(emptySubAgents),
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
    [draftProjectId, setDraftProjectId] = useState<string | null>(null),
    [draftActive, setDraftActive] = useState(true),
    [draftVersion, setDraftVersion] = useState(0),
    [preparationStatus, setPreparationStatus] = useState<{
      key: string;
      state: "failed";
    } | null>(null);
  function setText(value: string) {
    draft.current.edit();
    setTextState(value);
  }
  // Both panels start collapsed; the user opens them from the header.
  const [panels, setPanels] = useState({ sidebar: false, activity: false }),
    [panelSizes, setPanelSizes] = useState<
      Record<"list" | "detail", PanelSize>
    >({ list: "min", detail: "max" }),
    [helperOpen, setHelperOpen] = useState(false),
    [vw, setVw] = useState(1440),
    [paletteOpen, setPaletteOpen] = useState(false),
    [pop, setPop] = useState<null | "agent" | "user">(null),
    [agentDialogOpen, setAgentDialogOpen] = useState(false),
    [editingAgent, setEditingAgent] = useState<AgentDetails | null>(null),
    // The stage shows the conversation or the agents board.
    [view, setView] = useState<"chat" | "agents">("chat"),
    [composerFocused, setComposerFocused] = useState(false),
    [shellReady, setShellReady] = useState(false);
  const agentBtn = useRef<HTMLButtonElement>(null),
    userBtn = useRef<HTMLButtonElement>(null);
  const agentEditRequest = useRef(0);
  // Follow activity: a new goal, plan or helper brings its tab forward.
  // Auto-opening uses the list size and never pushes an open sidebar out.
  const follow = useFollowActivity({
    panelOpen: panels.activity,
    vw,
    fitsOpen:
      !panels.sidebar ||
      fitPanel(
        vw,
        PANEL_W[panelSizes.list],
        CHAT_MIN[panelSizes.list],
        true,
        true,
      ).sidebar,
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
  const scroll = useRef<HTMLElement | null>(null),
    timelineList = useRef<LegendListRef | null>(null),
    timelineSettling = useRef(false),
    timelineNavigation = useRef(0),
    historyWindowRef = useRef<HistoryWindow | null>(null),
    composer = useRef<HTMLTextAreaElement>(null),
    following = useRef(true),
    streamFlush = useRef<(() => void) | null>(null),
    heldTimeline = useRef<SavedConversation | null>(null),
    generation = useRef(0),
    preparation = useRef(new SessionPreparation<Session>()),
    openingSession = useRef(false),
    sessionRef = useRef<Session | null>(null),
    seen = useRef(new Set<string>()),
    sending = useRef(false),
    liveRevision = useRef(0),
    expandedHistory = useRef(false),
    olderFlight = useRef(false),
    conversationCache = useRef(new SessionCache<SavedConversation>()),
    sourcePairs = useRef(new SessionCache<SourcePair>()),
    sourceSync = useRef(beginSourceSync(null)),
    sourceOwner = useRef<string | null>(null),
    sourceWaiter = useRef(new SynchronizationWaiter()),
    sourceConnection = useRef(0),
    sourceRequestedCursor = useRef<string | null>(null),
    sourceProtocol = useRef(true),
    sourceCapability = useRef(false),
    sourceRecovered = useRef(false),
    historyLoader = useRef(
      new SessionHistory<SessionHistoryPayload>((id, persisted) =>
        api(
          `/api/sessions/${encodeURIComponent(id)}?window=1${persisted ? "&persisted=1" : ""}`,
        ),
      ),
    ),
    recoveryStarts = useRef(
      new WeakMap<
        Promise<SessionHistoryPayload>,
        { token: number; revision: number }
      >(),
    ),
    displayed = useRef<SavedConversation | null>(null),
    restoreScroll = useRef<SavedConversation | null>(null),
    commandAttempt = useRef<{
      sessionId: string;
      text: string;
      clientId: string;
    } | null>(null);
  historyWindowRef.current = historyWindow;
  // Setting a message always replaces the reference of the previous error.
  const setError = (message: string, detail: ErrorRefValue | null = null) => {
    setErrorText(message);
    setErrorDetail(message ? detail : null);
  };
  const reportError = (e: unknown) => setError(userMessage(e), errorRef(e));
  const refreshSessions = useCallback(
    () =>
      api("/api/sessions")
        .then((list) => {
          setSessions(list);
          setSessionsFailed(false);
        })
        .catch((e) => {
          warnFailure("session list", e);
          setSessionsFailed(true);
        }),
    [],
  );
  // Recents and search load on demand; mounting the chat creates no session.
  useEffect(() => {
    if (panels.sidebar || paletteOpen) void refreshSessions();
  }, [panels.sidebar, paletteOpen, refreshSessions]);
  const projects = useProjects(refreshSessions);
  const picker = modePicker(approvalModes, session, draftMode);
  const pendingProject = session
    ? null
    : draftProject(draftProjectId, projects.projects);
  const preparationKey = JSON.stringify([
    draftVersion,
    agentId,
    draftProjectId,
    delegation.mode,
    delegation.maxConcurrent,
  ]);
  const preparationFailed =
    draftActive &&
    !session &&
    preparationStatus?.key === preparationKey &&
    preparationStatus.state === "failed";
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
  // Save only at navigation boundaries; serializing on every delta stalls streaming.
  displayed.current = session
    ? {
        session,
        entries,
        plan,
        timings,
        observability,
        traceSummary,
        subAgents,
        events,
        goal,
        goalReview,
        text,
        historyWindow,
        expanded: expandedHistory.current,
        scrollTop: 0,
        following: following.current,
      }
    : null;
  const rememberDisplayed = useCallback(() => {
    streamFlush.current?.();
    const current = displayed.current;
    if (!current) return;
    const container = scroll.current;
    const top = container?.getBoundingClientRect().top ?? 0;
    const bottom = container?.getBoundingClientRect().bottom ?? 0;
    const row =
      container &&
      [...container.querySelectorAll<HTMLElement>(".msg[id]")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > top && rect.top < bottom;
        })
        .sort(
          (a, b) =>
            a.getBoundingClientRect().top - b.getBoundingClientRect().top,
        )[0];
    const saved = {
      ...current,
      entries: entriesRef.current,
      plan: planRef.current,
      subAgents: subAgentsRef.current,
      observability: observabilityRef.current,
      scrollTop: container?.scrollTop ?? 0,
      following: following.current,
      anchor: row
        ? { id: row.id, offset: row.getBoundingClientRect().top - top }
        : undefined,
    };
    heldTimeline.current = saved.entries.length ? saved : heldTimeline.current;
    conversationCache.current.set(current.session._id, saved);
    if (
      sourceOwner.current === current.session._id &&
      sourceSync.current.phase === "ready" &&
      sourceSync.current.pair
    )
      sourcePairs.current.set(current.session._id, sourceSync.current.pair);
    return saved;
  }, []);
  const invalidateConversation = useCallback((id: string, error: unknown) => {
    if (
      !(error instanceof ApiRequestError) ||
      (![401, 403, 404].includes(error.status) &&
        !(error.status === 409 && error.code === "LEGACY_SESSION"))
    )
      return;
    const activeOwner =
      sourceOwner.current === id ||
      sessionRef.current?._id === id ||
      error.status === 401;
    conversationCache.current.delete(id);
    sourcePairs.current.delete(id);
    setPaintedConversation(null);
    heldTimeline.current = null;
    if (error.status === 401) {
      conversationCache.current.clear();
      sourcePairs.current.clear();
    }
    if (sourceOwner.current === id || error.status === 401) {
      sourceOwner.current = null;
      sourceSync.current = beginSourceSync(null);
      sourceRecovered.current = false;
      sourceCapability.current = false;
      sourceConnection.current++;
      sourceWaiter.current.cancel();
    }
    if (displayed.current?.session._id === id || error.status === 401)
      displayed.current = null;
    if (activeOwner) {
      generation.current++;
      sessionRef.current = null;
      sourceWaiter.current.cancel();
      openingSession.current = false;
      setOpeningId(null);
      setBusy(false);
      setSession(null);
      setEntries([]);
      setPending([]);
      setGoal(null);
      setGoalReview(null);
      setRunning(false);
      setText("");
      setPlan([]);
      setTimings([]);
      setSubAgents(emptySubAgents);
      setEvents([]);
      setObservability(emptyObservability);
      setTraceSummary(null);
      setDocuments([]);
      setHistoryWindow(null);
      setFailure(null);
    }
  }, []);
  const recover = useCallback(
    async (
      id: string,
      token: number,
      flight = historyLoader.current.load(id),
    ) => {
      let start = recoveryStarts.current.get(flight);
      if (!start) {
        start = { token, revision: liveRevision.current };
        recoveryStarts.current.set(flight, start);
      }
      const data = await flight;
      if (token !== generation.current || sessionRef.current?._id !== id)
        return false;
      // A queued delta is already newer than the HTTP snapshot, even before paint.
      streamFlush.current?.();
      sessionRef.current = data.session;
      setSession(data.session);
      setEntries((old) =>
        addApprovals(
          mergeHistoryWindow(data.messages, old, {
            preserveLive:
              start.token !== token || liveRevision.current !== start.revision,
          }),
          data.approvals || [],
        ),
      );
      if (start.token === token && liveRevision.current === start.revision)
        setGoalReview(data.goalReview || null);
      if (!expandedHistory.current)
        setHistoryWindow(data.historyWindow ?? null);
      // Events received during recovery are newer than its snapshot. Preserve them.
      if (
        data.snapshot &&
        start.token === token &&
        liveRevision.current === start.revision
      ) {
        const currentSnapshot = data.snapshot;
        const snapshot = {
          type: "snapshot",
          data: currentSnapshot,
        } as DomainEvent;
        setEntries((old) => applyChatEvent(old, snapshot));
        setPending(data.snapshot.pending || []);
        setSubAgents((old) => rehydrate(old, currentSnapshot.subAgents || []));
        setPlan(data.snapshot.plan || data.plan?.steps || []);
        setGoal(data.snapshot.goal || null);
        setRunning(data.snapshot.state.kind !== "idle");
        setTimings(data.snapshot.timings || []);
        setObservability((old) => applyObservabilityEvent(old, snapshot));
      }
      if (data.recoveryError)
        setError(data.recoveryError, data.recoveryErrorRef);
      return !data.recoveryError;
    },
    [],
  );
  const requestSourceHandoff = useCallback(
    async (id: string, token: number) => {
      if (token !== generation.current || sessionRef.current?._id !== id)
        return false;
      streamFlush.current?.();
      sourceSync.current = beginSourceSync(null, true);
      sourceRequestedCursor.current = null;
      sourceProtocol.current = true;
      sourceConnection.current++;
      const ready = sourceWaiter.current.wait(id, token);
      setStreamKey((key) => key + 1);
      const complete = await ready;
      if (token !== generation.current || sessionRef.current?._id !== id)
        return false;
      if (!complete) {
        sourcePairs.current.delete(id);
        sourceSync.current = { ...beginSourceSync(null), phase: "legacy" };
        sourceProtocol.current = false;
        sourceConnection.current++;
        setStreamKey((key) => key + 1);
      }
      return complete;
    },
    [],
  );
  const open = useCallback(
    async (id: string) => {
      if (sending.current) return;
      rememberDisplayed();
      const cached = conversationCache.current.get(id);
      setPaintedConversation(cached ? null : heldTimeline.current);
      const token = ++generation.current;
      sourceWaiter.current.cancel();
      const paired = sourcePairs.current.get(id) ?? null;
      sourceOwner.current = id;
      sourceSync.current = beginSourceSync(paired);
      sourceRequestedCursor.current = paired?.cursor ?? null;
      sourceProtocol.current = true;
      sourceCapability.current = false;
      sourceRecovered.current = false;
      sourceConnection.current++;
      const warmReady = paired ? sourceWaiter.current.wait(id, token) : null;
      setStreamKey((key) => key + 1);
      liveRevision.current = 0;
      preparation.current.reset();
      openingSession.current = true;
      timelineSettling.current = true;
      setOpeningId(id);
      setSelectedId(id);
      expandedHistory.current = cached?.expanded ?? false;
      olderFlight.current = false;
      setOlderLoading(false);
      setHistoryWindow(cached?.historyWindow ?? null);
      setDraftActive(false);
      setPreparationStatus(null);
      setView("chat");
      setBusy(true);
      setError("");
      setNotice("");
      setCommandOpen(false);
      setDraftProjectId(null);
      setModeError("");
      setGoalMode(false);
      setStatus("Not connected");
      seen.current.clear();
      sessionRef.current = cached?.session ?? null;
      setSession(cached?.session ?? null);
      if (cached) setAgentId(cached.session.agentId);
      setEntries(
        paired && cached
          ? overlaySourceEntries(cached.entries, paired.entries)
          : (cached?.entries ?? []),
      );
      setEvents(cached?.events ?? []);
      // Pending actions are live state, never restored from the display cache.
      setPending([]);
      setSubAgents(cached?.subAgents ?? emptySubAgents);
      setPlan(cached?.plan ?? []);
      setGoal(cached?.goal ?? null);
      setGoalReview(cached?.goalReview ?? null);
      setTimings(cached?.timings ?? []);
      setObservability(cached?.observability ?? emptyObservability);
      setTraceSummary(cached?.traceSummary ?? null);
      setFailure(null);
      setRunning(false);
      setText(cached?.text ?? "");
      following.current = cached?.following ?? true;
      setLiveFollowEnabled(following.current);
      restoreScroll.current = cached ?? null;
      history.replaceState(null, "", "?session=" + encodeURIComponent(id));
      try {
        const revision = liveRevision.current;
        const { persisted, recovery } = paired
          ? {
              persisted: historyLoader.current.load(id, true),
              recovery: undefined,
            }
          : historyLoader.current.loadForOpen(id);
        // Record ownership at request start, before saved history or SSE can
        // arrive. A completed recovery must not be re-requested after paint.
        if (recovery && !recoveryStarts.current.has(recovery))
          recoveryStarts.current.set(recovery, { token, revision });
        const data = await persisted;
        if (token !== generation.current) return;
        streamFlush.current?.();
        setPaintedConversation(null);
        sessionRef.current = data.session;
        setSession(data.session);
        setAgentId(data.session.agentId);
        setEntries((old) => {
          const merged = addApprovals(
            mergeHistoryWindow(data.messages, old, {
              preserveLive: liveRevision.current !== revision,
            }),
            data.approvals || [],
          );
          return paired && sourceSync.current.pair
            ? overlaySourceEntries(merged, sourceSync.current.pair.entries)
            : merged;
        });
        if (liveRevision.current === 0) setPlan(data.plan?.steps || []);
        if (liveRevision.current === revision)
          setGoalReview(data.goalReview || null);
        if (!expandedHistory.current)
          setHistoryWindow(data.historyWindow ?? null);
        const warm = warmReady ? await warmReady : false;
        if (token !== generation.current) return;
        if (!warm) {
          sourcePairs.current.delete(id);
          sourceSync.current = beginSourceSync(null);
          if (paired) sourceConnection.current++;
          const recovered = await recover(id, token, recovery);
          if (token !== generation.current) return;
          sourceRecovered.current = recovered;
          if (recovered && sourceCapability.current)
            await requestSourceHandoff(id, token);
          else if (paired) {
            // A rolled-back server may not publish markers. Restore its safe
            // live stream without waiting another deadline after full recovery.
            sourceSync.current = { ...beginSourceSync(null), phase: "legacy" };
            sourceRequestedCursor.current = null;
            sourceProtocol.current = false;
            sourceConnection.current++;
            setStreamKey((key) => key + 1);
          }
        }
        if (token !== generation.current) return;
        if (warm) return;
        void getTraces(id, true)
          .then((traceData) => {
            if (token !== generation.current) return;
            setObservability((old) => ({
              ...old,
              traces: mergeTraces(old.traces, traceData?.traces),
            }));
            setTraceSummary(traceData?.summary || null);
          })
          .catch((e) => warnFailure("traces", e));
        void api(`/api/sessions/${encodeURIComponent(id)}/timings?persisted=1`)
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
      } catch (e) {
        if (token === generation.current) {
          setPaintedConversation(null);
          invalidateConversation(id, e);
          reportError(e);
        }
      } finally {
        if (token === generation.current) {
          openingSession.current = false;
          setOpeningId(null);
          setBusy(false);
        }
      }
    },
    [rememberDisplayed, recover, invalidateConversation, requestSourceHandoff],
  );
  const restoreTimelineScroll = useCallback(async () => {
    const saved = restoreScroll.current;
    const list = timelineList.current;
    const container = scroll.current;
    const id = sessionRef.current?._id;
    if (!list || !container || !id || (saved && saved.session._id !== id))
      return;
    if (!saved && !following.current) return;
    const token = generation.current;
    const navigation = ++timelineNavigation.current;
    restoreScroll.current = null;
    timelineSettling.current = true;
    try {
      if (saved && !saved.following) {
        const index =
          saved.anchor &&
          timelineAnchorIndex(entriesRef.current, saved.anchor.id);
        if (index !== undefined)
          await list.scrollToIndex({
            index,
            animated: false,
            viewOffset: saved.anchor?.offset ?? 0,
          });
        else
          await list.scrollToOffset({
            offset: saved.scrollTop,
            animated: false,
          });
      } else if (following.current) await list.scrollToEnd({ animated: false });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (
        token !== generation.current ||
        timelineList.current !== list ||
        navigation !== timelineNavigation.current
      )
        return;
      if (saved?.anchor && !saved.following) {
        const anchor = document.getElementById(saved.anchor.id);
        if (anchor && container.contains(anchor))
          container.scrollTop +=
            anchor.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            saved.anchor.offset;
      }
    } catch (error) {
      if (
        token === generation.current &&
        timelineList.current === list &&
        navigation === timelineNavigation.current
      )
        warnFailure("conversation scroll restoration", error);
    } finally {
      if (
        token === generation.current &&
        timelineList.current === list &&
        navigation === timelineNavigation.current
      )
        timelineSettling.current = false;
    }
  }, []);
  useLayoutEffect(() => {
    if (restoreScroll.current && timelineList.current)
      void restoreTimelineScroll();
  }, [session?._id, entries, restoreTimelineScroll]);
  const onTimelineViewport = useCallback((node: HTMLElement | null) => {
    scroll.current = node;
  }, []);
  const cancelTimelineRestoration = useCallback(() => {
    timelineNavigation.current++;
    restoreScroll.current = null;
    timelineSettling.current = false;
  }, []);
  const onTimelineScroll = useCallback(() => {
    const container = scroll.current;
    if (!container || timelineSettling.current) return;
    const next =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      80;
    following.current = next;
    setLiveFollowEnabled(next);
  }, []);
  const navigateTimeline = useCallback(async (anchorId: string) => {
    const list = timelineList.current;
    const index = timelineAnchorIndex(entriesRef.current, anchorId);
    if (!list || index === undefined || openingSession.current) return false;
    const token = generation.current;
    const navigation = ++timelineNavigation.current;
    following.current = false;
    setLiveFollowEnabled(false);
    restoreScroll.current = null;
    timelineSettling.current = false;
    try {
      await list.scrollToIndex({ index, animated: false, viewOffset: 12 });
    } catch (error) {
      if (
        token === generation.current &&
        timelineList.current === list &&
        navigation === timelineNavigation.current
      )
        warnFailure("conversation navigation", error);
      if (navigation === timelineNavigation.current)
        timelineSettling.current = false;
      return false;
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (
      token !== generation.current ||
      timelineList.current !== list ||
      navigation !== timelineNavigation.current
    )
      return false;
    const target = document.getElementById(anchorId);
    if (!target || !scroll.current?.contains(target)) return false;
    target.focus({ preventScroll: true });
    return true;
  }, []);
  const viewTimelineTurn = useCallback(
    (turnId: string) => navigateTimeline(`turn-${turnId}`),
    [navigateTimeline],
  );
  useEffect(() => {
    // A page-instance cache cannot survive an account navigation via bfcache.
    const clear = () => {
      conversationCache.current.clear();
      sourcePairs.current.clear();
      sourceWaiter.current.cancel();
      heldTimeline.current = null;
    };
    const revalidate = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    addEventListener("pagehide", clear);
    addEventListener("pageshow", revalidate);
    return () => {
      removeEventListener("pagehide", clear);
      removeEventListener("pageshow", revalidate);
      clear();
    };
  }, []);
  const loadEarlier = useCallback(async () => {
    const id = sessionRef.current?._id;
    const cursor = historyWindowRef.current?.beforeCursor;
    if (!id || !cursor || olderFlight.current) return;
    olderFlight.current = true;
    setOlderLoading(true);
    const token = generation.current;
    try {
      const data: SessionHistoryPayload = await api(
        `/api/sessions/${encodeURIComponent(id)}?persisted=1&window=1&before=${encodeURIComponent(cursor)}`,
      );
      if (token !== generation.current || sessionRef.current?._id !== id)
        return;
      const saved = rememberDisplayed();
      if (saved) {
        restoreScroll.current = { ...saved, following: false };
        following.current = false;
        setLiveFollowEnabled(false);
      }
      setEntries((old) =>
        addApprovals(
          mergeHistoryWindow(data.messages, old, { older: true }),
          data.approvals || [],
        ),
      );
      expandedHistory.current = true;
      setHistoryWindow(data.historyWindow ?? null);
    } catch (e) {
      if (token === generation.current) {
        invalidateConversation(id, e);
        reportError(e);
      }
    } finally {
      if (token === generation.current) {
        olderFlight.current = false;
        setOlderLoading(false);
      }
    }
  }, [rememberDisplayed, invalidateConversation]);
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
    api("/api/agents")
      .then((data) => {
        setAgents(data);
        // Restoring a saved chat owns its selection, regardless of which GET
        // finishes first. Never select a default agent alongside that restore.
        if (!openingSession.current && !sessionRef.current)
          setAgentId(
            (current) =>
              current ||
              // Only an agent this person may start a conversation with.
              data.find((a: AgentSummary) => a.canUse !== false)?.id ||
              "",
          );
      })
      .catch(reportError)
      .finally(() => setLoading(false));
    const id = new URLSearchParams(location.search).get("session");
    if (id) void open(id);
  }, [open]);
  useEffect(() => {
    if (!session) return;
    const id = session._id;
    const token = generation.current;
    if (sourceOwner.current !== id) {
      sourceOwner.current = id;
      sourceSync.current = beginSourceSync(null);
      sourceRequestedCursor.current = null;
      sourceProtocol.current = true;
      sourceCapability.current = false;
      sourceRecovered.current = false;
    }
    const connection = sourceConnection.current;
    follow.reset();
    let active = true;
    let firstSnapshot = true;
    const openingOwnsRecovery = openingSession.current;
    const reloadTranscript = () => {
      void recover(id, token)
        .then((recovered) => {
          if (
            !active ||
            token !== generation.current ||
            sessionRef.current?._id !== id
          )
            return;
          sourceRecovered.current = recovered;
          if (
            recovered &&
            sourceCapability.current &&
            sourceSync.current.phase === "cold"
          )
            void requestSourceHandoff(id, token);
        })
        .catch((e) => {
          if (active && token === generation.current) {
            invalidateConversation(id, e);
            reportError(e);
          }
        });
    };
    // Reload what the stream may have missed, as the platform asks on resync.
    const resync = () => {
      if (
        !active ||
        token !== generation.current ||
        sessionRef.current?._id !== id
      )
        return;
      sourcePairs.current.delete(id);
      sourceSync.current = beginSourceSync(null);
      sourceWaiter.current.cancel();
      if (openingSession.current) return;
      openingSession.current = true;
      setOpeningId(id);
      setBusy(true);
      sourceConnection.current++;
      void recover(id, token)
        .then(async (recovered) => {
          if (token !== generation.current || sessionRef.current?._id !== id)
            return;
          sourceRecovered.current = recovered;
          if (recovered && sourceCapability.current)
            await requestSourceHandoff(id, token);
          else {
            sourceSync.current = { ...beginSourceSync(null), phase: "legacy" };
            sourceRequestedCursor.current = null;
            sourceProtocol.current = false;
            sourceConnection.current++;
            setStreamKey((key) => key + 1);
          }
        })
        .catch((e) => {
          if (token === generation.current) {
            invalidateConversation(id, e);
            reportError(e);
          }
        })
        .finally(() => {
          if (token === generation.current) {
            openingSession.current = false;
            setOpeningId(null);
            setBusy(false);
          }
        });
      void listAgents(id)
        .then((list) => {
          if (active && sessionRef.current?._id === id && Array.isArray(list))
            setSubAgents((old) => rehydrate(old, list));
        })
        .catch((e) => warnFailure("helper agents", e));
    };
    setRetrying(false);
    const applyBatch = (incoming: DomainEvent[]): boolean => {
      if (
        !active ||
        token !== generation.current ||
        connection !== sourceConnection.current ||
        sessionRef.current?._id !== id
      )
        return false;
      const newCursors = new Set<string>();
      let batch = incoming.filter((event) => {
        if (
          event.type !== "snapshot" &&
          event.type !== "sync.completed" &&
          event.cursor
        ) {
          if (seen.current.has(event.cursor) || newCursors.has(event.cursor))
            return false;
          newCursors.add(event.cursor);
        }
        return true;
      });
      if (!batch.length) return true;
      if (batch.some((event) => event.type === "sync.completed"))
        sourceCapability.current = true;
      const ownedSnapshot = sourceSync.current.phase === "handoff";
      const synchronized = advanceSourceSync(sourceSync.current, batch);
      if (synchronized.failure) {
        resync();
        return false;
      }
      batch = synchronized.accepted;
      if (!batch.length) return true;
      const operationalBatch = batch.map((event) =>
        event.type === "sync.completed"
          ? { ...event, type: "snapshot" as const, data: event.data.snapshot }
          : event,
      );
      // Compute every projection before publishing or remembering a cursor.
      // A malformed frame cannot commit only part of the conversation state.
      const nextEntries = coalesceChatEvents(batch).reduce(
        applyChatEvent,
        entriesRef.current,
      );
      const nextAgents = operationalBatch.reduce(
        (state, event) => applySubAgentEvent(state, event),
        subAgentsRef.current,
      );
      const nextObservability = operationalBatch.reduce(
        applyObservabilityEvent,
        observabilityRef.current,
      );
      const nextPlan = operationalBatch.reduce(applyPlanEvent, planRef.current);
      for (const cursor of newCursors) {
        seen.current.add(cursor);
        if (seen.current.size > 2000)
          seen.current.delete(seen.current.values().next().value!);
      }
      liveRevision.current += batch.length;
      setEntries(nextEntries);
      setSubAgents(nextAgents);
      setObservability(nextObservability);
      setPlan(nextPlan);
      sourceSync.current = synchronized.state;
      for (const event of batch) {
        follow.onEvent(event);
        if (
          [
            "activity.updated",
            "subagent.spawned",
            "subagent.status",
            "subagent.completed",
            "turn.started",
            "turn.completed",
            "error",
          ].includes(event.type)
        )
          setEvents((old) => [...old.slice(-99), event]);
        const d =
          event.type === "sync.completed" ? event.data.snapshot : event.data;
        switch (event.type) {
          case "snapshot":
          case "sync.completed":
            setPending(d.pending);
            setRunning(d.state.kind !== "idle");
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

            // Opening already performs one complete catch-up. A reconnect must
            // catch up durable history again; the initial snapshot must not repeat it.
            if (event.type === "snapshot") {
              if (!ownedSnapshot && (!firstSnapshot || !openingOwnsRecovery))
                reloadTranscript();
              firstSnapshot = false;
            }
            break;
          case "resync.required":
            resync();
            break;
          case "turn.started":
            setRunning(true);
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
            setError(d.message || "The request could not be completed.", {
              ...(typeof d.code === "string" ? { code: d.code } : {}),
              ...(typeof d.turnId === "string" ? { turnId: d.turnId } : {}),
            });
            setFailure(turnFailure(d));
            break;
        }
      }
      if (synchronized.operational) sourceWaiter.current.complete(id, token);
      else if (
        batch.some((event) => event.type === "sync.completed") &&
        sourceRecovered.current &&
        sourceSync.current.phase === "cold"
      )
        void requestSourceHandoff(id, token);
      return true;
    };
    const unsubscribe = transport.subscribe(
      id,
      (event) => applyBatch([event]),
      (next) => active && sessionRef.current?._id === id && setStatus(next),
      {
        sync: sourceProtocol.current ? "v1" : undefined,
        cursor: sourceRequestedCursor.current,
        onBatch: applyBatch,
        onResync: resync,
        onFailure: (f) => {
          if (
            active &&
            token === generation.current &&
            sessionRef.current?._id === id
          ) {
            sourceWaiter.current.cancel();
            sourcePairs.current.delete(id);
            setError(f.message, { code: f.code, requestId: f.requestId });
            if (f.code === "ACCESS_REVOKED" || f.code === "AUTH_UNAVAILABLE")
              actions.recheck();
            if (
              ["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND"].includes(
                f.code || "",
              )
            )
              invalidateConversation(
                id,
                new ApiRequestError(
                  f.message,
                  f.code === "UNAUTHENTICATED"
                    ? 401
                    : f.code === "NOT_FOUND"
                      ? 404
                      : 403,
                  f.code || "FORBIDDEN",
                ),
              );
          }
        },
      },
    );
    streamFlush.current = unsubscribe.flush ?? null;
    return () => {
      unsubscribe.flush?.();
      active = false;
      if (streamFlush.current === unsubscribe.flush) streamFlush.current = null;
      unsubscribe();
    };
  }, [
    session?._id,
    streamKey,
    recover,
    invalidateConversation,
    requestSourceHandoff,
    actions.recheck,
  ]);
  // A stream that closed for good may be a lost connection or a lost session;
  // only the platform can tell which.
  useEffect(() => {
    if (session && status === "Disconnected") actions.recheck();
  }, [status]);
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
    if (following.current && !timelineSettling.current)
      void timelineList.current?.scrollToEnd({ animated: false });
  }, [entries, pending]);
  // A plain new chat clears any project; a project's "+" passes its id.
  function startDraft(projectId: string | null = null) {
    rememberDisplayed();
    generation.current++;
    setPaintedConversation(null);
    setSelectedId(null);
    setOpeningId(null);
    setHistoryWindow(null);
    expandedHistory.current = false;
    olderFlight.current = false;
    setOlderLoading(false);
    preparation.current.reset();
    openingSession.current = false;
    sending.current = false;
    setDispatchState(null);
    setDraftActive(true);
    setDraftVersion(generation.current);
    setPreparationStatus(null);
    setView("chat");
    setDraftProjectId(projectId);
    setText("");
    setNotice("");
    setCommandOpen(false);
    sessionRef.current = null;
    following.current = true;
    setLiveFollowEnabled(true);
    setSession(null);
    draftModeRef.current = null;
    setDraftMode(null);
    setModeError("");
    setEntries([]);
    setEvents([]);

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
    const block = entriesRef.current.findLast(
      (entry) => entry.kind === "agents",
    );
    if (!block) return openAgents();
    const token = generation.current;
    void navigateTimeline(`helpers-${block.id.replace(/[^\w-]/g, "-")}`).then(
      (found) => {
        if (!found && token === generation.current) openAgents();
      },
    );
  }
  // Keep the open conversation's projectId in step with sidebar moves.
  function updateCurrentProject(updated: Session) {
    if (sessionRef.current?._id !== updated._id) return;
    const next = { ...sessionRef.current, projectId: updated.projectId };
    sessionRef.current = next;
    setSession(next);
  }
  function changeDelegation(next: DelegationPrefs) {
    if (busy || sending.current) return;
    if (
      !sessionRef.current &&
      (next.mode !== delegation.mode ||
        next.maxConcurrent !== delegation.maxConcurrent)
    )
      invalidatePreparation();
    setDelegation(next);
    saveDelegation(next);
  }
  // Show the requested mode; a failed update leaves its effective state unknown.
  async function changeApprovalMode(
    mode: ApprovalMode,
    target: Session | null = sessionRef.current,
  ) {
    setModeError("");
    if (!target) {
      draftModeRef.current = mode;
      setDraftMode(mode);
      return true;
    }
    if (modeChanging.current) return false;
    modeChanging.current = true;
    setChangingMode(true);
    approvalConfirmation.current.require(target._id, mode);
    const apply = (value: ApprovalMode | undefined) => {
      if (sessionRef.current?._id !== target._id) return;
      const next = { ...sessionRef.current, approvalMode: value };
      sessionRef.current = next;
      setSession(next);
    };
    apply(mode);
    try {
      const confirmed = await setApprovalMode(target._id, mode);
      if (confirmed !== mode)
        throw new Error("The approval mode was not confirmed.");
      approvalConfirmation.current.confirm(target._id, confirmed);
      apply(confirmed);
      return true;
    } catch (e) {
      if (sessionRef.current?._id === target._id)
        setModeError(
          e instanceof ApiRequestError && e.status === 422
            ? "Autopilot is not available right now."
            : `Approval mode is unconfirmed. Retry the selection before sending. ${userMessage(e)}`,
        );
      return false;
    } finally {
      modeChanging.current = false;
      setChangingMode(false);
    }
  }
  function invalidatePreparation() {
    generation.current++;
    preparation.current.reset();
    setDraftVersion(generation.current);
    setPreparationStatus(null);
    setError("");
  }
  function changeDraftProject(projectId: string | null) {
    if (busy || sending.current) return;
    invalidatePreparation();
    setDraftProjectId(projectId);
  }
  function prepareSession(chosen: ApprovalMode | null) {
    return preparation.current.prepare(preparationKey, async () => {
      const created: Session = await api(
        "/api/sessions",
        createSessionBody(
          agentId,
          delegation,
          draftProjectId,
          chosen ?? undefined,
        ),
      );
      // A submitted creation that finishes after navigation stays in Recents.
      // Only ensureSession attaches it to the active composer.
      void refreshSessions();
      return created;
    });
  }
  async function ensureSession(): Promise<Session> {
    if (sessionRef.current) {
      const active = sessionRef.current;
      const wanted = approvalConfirmation.current.wanted(active._id);
      if (wanted && !(await changeApprovalMode(wanted, active)))
        throw new Error(
          "Confirm the approval mode before sending. Your draft is saved.",
        );
      return active;
    }
    const chosen = draftModeRef.current;
    const token = generation.current;
    const projectId = draftProjectId;
    const attempt = prepareSession(chosen);
    let created: Session;
    try {
      created = await attempt.promise;
    } catch (error) {
      if (
        token === generation.current &&
        preparation.current.isCurrent(attempt)
      ) {
        // A timed-out POST may have succeeded. Recover from Recents instead
        // of allowing another creation request for this draft.
        setPreparationStatus({ key: attempt.key, state: "failed" });
        void refreshSessions();
      }
      throw error;
    }
    if (token !== generation.current || !preparation.current.isCurrent(attempt))
      return created;
    setDraftActive(false);
    setPreparationStatus(null);
    sessionRef.current = created;
    setSession(created);
    setSelectedId(created._id);
    history.replaceState(null, "", "?session=" + created._id);
    draftModeRef.current = null;
    setDraftMode(null);
    // Configured creation returns the server-confirmed mode. Older platforms
    // ignore the additive choice, so confirm through their existing endpoint.
    if (chosen && chosen !== created.approvalMode)
      if (!(await changeApprovalMode(chosen, created)))
        throw new Error(
          "Confirm the approval mode before sending. Your draft is saved.",
        );
    if (projectId) {
      projects.expand(projectId);
      projects.refreshAll();
    } else void refreshSessions();
    return created;
  }
  async function send(value = text, restoreDraft?: string) {
    if (
      sending.current ||
      modeChanging.current ||
      preparationFailed ||
      busy ||
      (!sessionRef.current && !agentId)
    )
      return;
    const invalid = messageTextError(value);
    if (invalid) {
      setNotice(invalid);
      return;
    }
    sending.current = true;
    setBusy(true);
    const nextDispatch = running ? "steering" : "sending";
    setDispatchState(sessionRef.current ? nextDispatch : "creating");
    const token = generation.current;
    const clientId = crypto.randomUUID(),
      id = clientId;
    following.current = true;
    setText("");
    const clearedDraft = draft.current.capture();
    let dispatched = false;
    setError("");
    setEntries((old) => [
      ...old,
      { kind: "message", id, role: "user", text: value, delivery: "pending" },
    ]);
    try {
      const active = await ensureSession();
      if (token !== generation.current) return;
      setDispatchState(nextDispatch);
      dispatched = true;
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
      reportError(e);
      if (!dispatched) {
        setEntries((old) => old.filter((entry) => entry.id !== id));
        if (draft.current.isCurrent(clearedDraft))
          setText(restoreDraft ?? value);
      } else
        setEntries((old) =>
          old.map((e) =>
            e.kind === "message" && e.id === id
              ? { ...e, delivery: "unknown" }
              : e,
          ),
        );
    } finally {
      if (token === generation.current) {
        sending.current = false;
        setDispatchState(null);
        setBusy(false);
        if (restoreDraft !== undefined && draft.current.isCurrent(clearedDraft))
          setText(restoreDraft);
      }
    }
  }

  // A follow-up shows in the composer for a moment, then sends like a typed
  // message. Any unsent draft comes back afterwards.
  const suggesting = useRef(false);
  function askSuggestion(question: string) {
    if (
      suggesting.current ||
      sending.current ||
      modeChanging.current ||
      busy ||
      running
    )
      return;
    suggesting.current = true;
    const token = generation.current,
      previousDraft = text;
    setCommandOpen(false);
    setNotice("");
    setText(question);
    const suggestionDraft = draft.current.capture();
    composer.current?.focus();
    setTimeout(() => {
      void (async () => {
        try {
          if (
            token !== generation.current ||
            !draft.current.isCurrent(suggestionDraft)
          )
            return;
          await send(question, previousDraft);
        } finally {
          suggesting.current = false;
        }
      })();
    }, 350);
  }

  const commandSuggestions =
    SLASH_COMMANDS_ENABLED && commandOpen ? suggestCommands(text) : [];
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
      modeChanging.current ||
      preparationFailed ||
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
      : SLASH_COMMANDS_ENABLED
        ? parseChatInput(text)
        : { kind: "message" as const, text };
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
    const token = generation.current;
    const commandText = text;
    const submittedDraft = draft.current.capture();
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
    }
    sending.current = true;
    setBusy(true);
    setDispatchState(active ? "sending" : "creating");
    try {
      active = await ensureSession();
      if (token !== generation.current) return;
    } catch (e) {
      if (token === generation.current) {
        sending.current = false;
        setBusy(false);
        setDispatchState(null);
        reportError(e);
      }
      return;
    }
    const previous = commandAttempt.current;
    const clientId =
      previous?.sessionId === active._id && previous.text === commandText
        ? previous.clientId
        : crypto.randomUUID();
    commandAttempt.current = {
      sessionId: active._id,
      text: commandText,
      clientId,
    };
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
              command: {
                method: input.method,
                params: input.params,
                state: "running",
              },
            },
          ],
    );
    setDispatchState("sending");
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
        if (
          record.method === "thread/goal/set" &&
          draft.current.isCurrent(submittedDraft)
        ) {
          setGoalMode(false);
          setGoalBudget(null);
        }
      }
      if (
        result.commandMessage.command.state === "succeeded" &&
        draft.current.isCurrent(submittedDraft)
      )
        setText("");
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
      if (token === generation.current) {
        sending.current = false;
        setDispatchState(null);
        setBusy(false);
      }
    }
  }
  const agent = agents.find((a) => a.id === agentId);
  const usableAgents = agents.filter((a) => a.canUse !== false);
  // A conversation that is not yours is for reading: only its owner can write
  // to it, and an admin looking at one never starts the owner's assistant.
  const readOnly = !!session && session.userId !== me.user.id;
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
  const empty = !selectedId && !session && !entries.length;
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
    if ((!busy || openingSession.current) && !sending.current) startDraft();
  }
  useHotkeys({
    "mod+k": () => setPaletteOpen((o) => !o),
    "mod+b": toggleSidebar,
    "mod+.": toggleActivity,
    "mod+j": newChat,
  });
  // Board "Chat": back to the conversation with that agent, fresh if the
  // open session belongs to another one.
  function chatWith(a: AgentSummary) {
    if (busy || sending.current) return;
    if (
      (sessionRef.current && sessionRef.current.agentId !== a.id) ||
      (!sessionRef.current && !draftActive)
    )
      startDraft();
    else if (agentId !== a.id) invalidatePreparation();
    setAgentId(a.id);
    setView("chat");
    setNotice("");
    setTimeout(() => composer.current?.focus(), 0);
  }
  function openNewAgent() {
    agentEditRequest.current++;
    setEditingAgent(null);
    setAgentDialogOpen(true);
  }
  function closeAgentDialog() {
    agentEditRequest.current++;
    setAgentDialogOpen(false);
  }
  async function editAgent(a: AgentSummary) {
    if (a.builtin || a.canWrite === false) return;
    const request = ++agentEditRequest.current;
    try {
      const details = await fetchAgent(a.id);
      if (request !== agentEditRequest.current) return;
      if (details.builtin || details.canWrite === false) return;
      setEditingAgent(details);
      setAgentDialogOpen(true);
    } catch (e) {
      if (request === agentEditRequest.current) setNotice(userMessage(e));
    }
  }
  const togglePop = (next: "agent" | "user") =>
    setPop((cur) => (cur === next ? null : next));
  // The list refreshes with the server-generated title; the open session may not.
  const crumbTitle =
    selectedId && !session
      ? sessions.find((s) => s._id === selectedId)?.title || "Conversation"
      : session
        ? sessions.find((s) => s._id === session._id)?.title ||
          session.title ||
          "Untitled conversation"
        : entries.length
          ? "New conversation"
          : "";
  const stateText = dispatchState
    ? dispatchState === "creating"
      ? "Creating…"
      : dispatchState === "steering"
        ? "Steering…"
        : "Sending…"
    : openingId
      ? entries.length
        ? "syncing…"
        : "loading…"
      : session && status === "Reconnecting"
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
    if (openingSession.current || !sessionRef.current) return;
    const token = generation.current;
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
          if (token === generation.current) setGoal(data.goal);
          syncSessionGoal(id, data.goal);
        }
        await transport.interrupt(id).catch((e) => {
          // The turn already ended, so there is nothing to stop.
          if (!(e instanceof ApiRequestError && e.status === 409)) throw e;
        });
      } catch (e) {
        if (token === generation.current) reportError(e);
      }
    })();
  }
  const fillComposer = useCallback((value: string) => {
    setText(value);
    setCommandOpen(false);
    composer.current?.focus();
  }, []);
  const navigationActions = useRef({
    openAgents,
    askSuggestion,
    newChat,
    updateCurrentProject,
  });
  navigationActions.current = {
    openAgents,
    askSuggestion,
    newChat,
    updateCurrentProject,
  };
  const showHelper = useCallback(
    (id: string) => navigationActions.current.openAgents(id),
    [],
  );
  const suggest = useCallback(
    (question: string) => navigationActions.current.askSuggestion(question),
    [],
  );
  const openConversation = useCallback(
    (id: string) => {
      void open(id);
    },
    [open],
  );
  const refreshConversation = useCallback(() => {
    const id = sessionRef.current?._id;
    if (id) void open(id);
  }, [open]);
  const newConversation = useCallback(
    () => navigationActions.current.newChat(),
    [],
  );
  const showSearch = useCallback(() => setPaletteOpen(true), []);
  const showAgents = useCallback(() => setView("agents"), []);
  const showSettings = useCallback(() => setPanel("mcp"), []);
  const retrySessions = useCallback(() => {
    void refreshSessions();
  }, [refreshSessions]);
  const projectState = useRef(projects);
  projectState.current = projects;
  const renderSessionMenu = useCallback(
    (s: Session) =>
      s.userId !== me.user.id ? null : (
        <SessionMenu
          session={s}
          state={projectState.current}
          disabled={busy}
          onUpdated={(updated) =>
            navigationActions.current.updateCurrentProject(updated)
          }
        />
      ),
    [
      busy,
      projects.projects,
      projects.expanded,
      projects.byProject,
      projects.error,
      projects.refreshFailed,
      me.user.id,
    ],
  );
  const renderedGeneration = generation.current;
  const paintOnly = paintedConversation !== null;
  const paintedAgent = paintedConversation
    ? agents.find((a) => a.id === paintedConversation.session.agentId)
    : null;
  const virtualized =
    view === "chat" &&
    (!empty || paintOnly) &&
    (!!session || !!entries.length || paintOnly);
  const initialTimelinePosition = useMemo(() => {
    const saved = restoreScroll.current ?? paintedConversation;
    if (!saved || saved.following) return {};
    const index =
      saved.anchor && timelineAnchorIndex(saved.entries, saved.anchor.id);
    return index === undefined
      ? { initialScrollOffset: saved.scrollTop }
      : {
          initialScrollIndex: {
            index,
            viewOffset: saved.anchor?.offset ?? 0,
          },
        };
  }, [selectedId, paintOnly]);
  const historyHeader = useMemo(
    () =>
      !paintOnly && historyWindow?.hasOlder ? (
        <button
          type="button"
          className="text-btn history-earlier"
          disabled={olderLoading}
          onClick={() => void loadEarlier()}
        >
          {olderLoading ? "Loading earlier messages…" : "Load earlier messages"}
        </button>
      ) : null,
    [paintOnly, historyWindow?.hasOlder, olderLoading, loadEarlier],
  );
  const requestFooter = useMemo(
    () =>
      session && !openingId && !readOnly
        ? pending.map((request) => (
            <RequestCard
              key={request.requestId}
              request={request}
              plan={plan}
              onAnswer={async (result) => {
                await transport.answer(session._id, request.requestId, result);
              }}
            />
          ))
        : null,
    [session, openingId, readOnly, pending, plan],
  );
  const timeline = useMemo<ChatTimelineProps>(
    () => ({
      identity:
        paintedConversation?.session._id ??
        selectedId ??
        session?._id ??
        "draft",
      listRef: timelineList,
      onViewport: onTimelineViewport,
      onScroll: onTimelineScroll,
      following: !paintOnly && liveFollowEnabled,
      ...initialTimelinePosition,
      header: historyHeader,
      footer: requestFooter,
      onLoad: () => void restoreTimelineScroll(),
    }),
    [
      paintedConversation?.session._id,
      selectedId,
      session?._id,
      onTimelineViewport,
      onTimelineScroll,
      paintOnly,
      liveFollowEnabled,
      initialTimelinePosition,
      historyHeader,
      requestFooter,
      restoreTimelineScroll,
    ],
  );
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
        dispatchState={dispatchState}
        canSend={
          !!text.trim() &&
          !busy &&
          !dispatchState &&
          !changingMode &&
          !preparationFailed &&
          (!!session || !!agentId)
        }
        onStop={stopTurn}
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
                  onClick={() => changeDraftProject(null)}
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
              {SLASH_COMMANDS_ENABLED && "Type / for commands. "}
              Enter to send, Shift + Enter for a new line.
            </span>
            {commandSuggestions.length > 0 && (
              <div
                id="chat-commands"
                className="slash-menu"
                role="listbox"
                aria-label="Chat commands"
              >
                {commandSuggestions.map((command, index) => (
                  <button
                    id={`chat-command-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === commandIndex}
                    className={index === commandIndex ? "selected" : ""}
                    key={command.name}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectCommand(command.name)}
                  >
                    <strong>{command.name}</strong>
                    <span>{command.description}</span>
                  </button>
                ))}
              </div>
            )}
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
                disabled={busy || changingMode}
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
          aria-haspopup={SLASH_COMMANDS_ENABLED ? "listbox" : undefined}
          aria-expanded={
            SLASH_COMMANDS_ENABLED ? commandSuggestions.length > 0 : undefined
          }
          aria-activedescendant={
            commandSuggestions.length
              ? `chat-command-${commandIndex}`
              : undefined
          }
          placeholder={
            goalMode
              ? "Describe the outcome you want. The assistant works until it’s done."
              : running
                ? "Add a thought to steer the current turn…"
                : empty
                  ? rotatingPlaceholder
                  : PLACEHOLDERS[0]
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCommandOpen(
              SLASH_COMMANDS_ENABLED &&
                !goalMode &&
                e.target.value.startsWith("/"),
            );
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
          activeId={selectedId ?? session?._id}
          onOpen={openConversation}
          onNew={newConversation}
          onSearch={showSearch}
          onAgents={showAgents}
          agentsActive={view === "agents"}
          onSettings={showSettings}
          busy={busy && !openingId}
          loadError={sessionsFailed ? "Couldn’t refresh" : null}
          onRetry={retrySessions}
          renderRowMenu={renderSessionMenu}
        />
      </Panel>
      <main className="stage">
        <Topbar
          sidebarShown={sidebarShown}
          title={view === "agents" ? "Agents" : crumbTitle}
          agentName={loading ? "Loading agents…" : agent?.name || "No agent"}
          stateText={stateText}
          busy={running}
          onStatusClick={() => setPop("agent")}
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
        <div
          className={virtualized ? "conversation-viewport" : "scroll"}
          // The board is a plain labelled region, not a live log.
          role={view === "agents" || virtualized ? "region" : "log"}
          aria-busy={openingId ? true : undefined}
          aria-label={view === "agents" ? "Agents" : "Conversation"}
          aria-live={view === "agents" ? undefined : "off"}
          ref={virtualized ? undefined : onTimelineViewport}
          onScroll={virtualized ? undefined : onTimelineScroll}
          onWheelCapture={(event) => {
            if (!virtualized || !event.deltaY) return;
            cancelTimelineRestoration();
            if (event.deltaY < 0) {
              following.current = false;
              setLiveFollowEnabled(false);
            }
          }}
          onKeyDownCapture={(event) => {
            if (
              !virtualized ||
              !(event.target instanceof HTMLElement) ||
              event.target.closest(
                'input, textarea, [contenteditable="true"]',
              ) ||
              !["ArrowUp", "PageUp", "Home"].includes(event.key)
            )
              return;
            cancelTimelineRestoration();
            following.current = false;
            setLiveFollowEnabled(false);
          }}
          onPointerDownCapture={() => {
            if (virtualized) cancelTimelineRestoration();
          }}
          onTouchMove={() => {
            if (!virtualized) return;
            cancelTimelineRestoration();
            following.current = false;
            setLiveFollowEnabled(false);
          }}
        >
          {paintOnly && (
            <p className="conversation-switching" role="status">
              Loading conversation…
            </p>
          )}
          {view === "agents" ? (
            <AgentsView
              agents={agents}
              currentId={session?.agentId || agentId}
              onEdit={(a) => void editAgent(a)}
              onChat={chatWith}
              onNew={openNewAgent}
            />
          ) : selectedId && !session && !entries.length && !paintOnly ? (
            <p className="conversation-loading" role="status">
              {openingId
                ? "Loading conversation…"
                : "Conversation could not be loaded."}
              {!openingId && (
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => void open(selectedId)}
                >
                  Retry
                </button>
              )}
            </p>
          ) : empty ? (
            <Hero>
              {composerForm}
              {!loading && !usableAgents.length && (
                <div className="first-agent" role="status">
                  <p className="muted sm">
                    {agents.length
                      ? "You haven’t made an agent of your own yet."
                      : "You don’t have an agent yet."}{" "}
                    An agent is what you talk to.
                  </p>
                  <button
                    type="button"
                    className="fa-btn"
                    onClick={openNewAgent}
                  >
                    Create your first agent
                  </button>
                </div>
              )}
            </Hero>
          ) : (
            <div
              className={`conversation-thread${paintOnly ? " paint-only" : ""}`}
              inert={paintOnly ? true : undefined}
              aria-hidden={paintOnly ? true : undefined}
            >
              <ChatMessages
                timeline={timeline}
                sessionId={openingId ? undefined : session?._id}
                onPrompt={paintOnly ? undefined : fillComposer}
                entries={paintedConversation?.entries ?? entries}
                traces={
                  paintedConversation?.observability.traces ??
                  observability.traces
                }
                liveUsage={paintOnly ? {} : observability.liveUsage}
                goal={paintOnly ? null : goal}
                goalReview={paintOnly ? null : goalReview}
                subAgents={paintedConversation?.subAgents ?? subAgents}
                onOpenAgent={paintOnly ? undefined : showHelper}
                onSuggest={paintOnly ? undefined : suggest}
                suggestionsEnabled={
                  !readOnly && !busy && !goalMode && !failure && !pending.length
                }
                agentName={paintedAgent?.name || agent?.name || "Assistant"}
                running={paintOnly ? false : running}
                onCommand={paintOnly ? undefined : fillComposer}
                onOpen={paintOnly ? undefined : openConversation}
                onRefresh={paintOnly ? undefined : refreshConversation}
              />
            </div>
          )}
        </div>
        <div className="bottom">
          {error && (
            <div role="alert" className="error-banner">
              <span className="error-banner-body">
                {error}
                <ErrorRef value={errorDetail} />
              </span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {/* The composer (and its notice) is hidden on the board. */}
          {view === "agents" && notice && (
            <div className="composer-notice" role="status">
              {notice}
            </div>
          )}
          {view === "chat" && session && goal && !openingId && !readOnly && (
            <GoalBar
              key={session._id}
              sessionId={session._id}
              goal={goal}
              review={goalReview}
              onChange={(next, review) => {
                if (generation.current !== renderedGeneration) return;
                setGoal(next);
                setGoalReview(review);
                syncSessionGoal(session._id, next);
              }}
              onReopen={(feedback) => {
                if (generation.current !== renderedGeneration) return;
                applyPrompt(
                  feedback
                    ? `The goal isn’t complete yet: ${feedback}`
                    : "The goal isn’t complete yet. Please keep working on it.",
                );
              }}
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
          {view === "chat" && !empty && (
            <HelperChip state={subAgents} onView={viewHelpers} />
          )}
          {view === "chat" && !empty && readOnly && (
            <div className="readonly-banner" role="status">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              <span>
                <b>Read-only.</b> This is another member’s conversation. Only
                its owner can reply, stop it or change it.
              </span>
            </div>
          )}
          {view === "chat" && !empty && !readOnly && composerForm}
          <div className="dock-wrap">
            <Popover
              open={pop === "agent"}
              onClose={() => setPop(null)}
              className="pop-agent"
              ignoreRef={agentBtn}
              aria-label="Choose agent"
            >
              <AgentMenu
                agents={usableAgents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  description: a.description,
                  hue: tintOf(a.tint).dot,
                }))}
                currentId={agentId}
                onPick={(id) => {
                  const picked = agents.find((a) => a.id === id);
                  if (picked) chatWith(picked);
                  setPop(null);
                }}
                onAll={() => {
                  setPop(null);
                  setView("agents");
                }}
                onNew={() => {
                  setPop(null);
                  openNewAgent();
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
                name={me.user.name}
                email={me.user.email}
                workspace={me.tenant.name}
                showWorkspaces={me.showWorkspaces}
                role={me.role}
                onSettings={() => {
                  setPop(null);
                  setPanel("mcp");
                }}
                onSignOut={me.auth === "google" ? actions.signOut : undefined}
                onWorkspaces={
                  me.auth === "google" || me.tenants.length > 1
                    ? () => {
                        setPop(null);
                        location.assign("/workspaces");
                      }
                    : undefined
                }
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
                  badge: running && !panels.activity,
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
          sessionId={openingId ? undefined : session?._id}
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
          onViewTurn={viewTimelineTurn}
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
        editing={editingAgent}
        // Handles are unique per creator in a private workspace, so only the
        // agents this person can change and reserved built-ins count toward
        // a clash. An admin's list also holds everyone else's.
        agents={agents.filter((a) => a.builtin || a.canWrite !== false)}
        onClose={closeAgentDialog}
        onCreated={(a) => setAgents((list) => [...list, a])}
        onUpdated={(a) => {
          setAgents((list) =>
            list.map((existing) => (existing.id === a.id ? a : existing)),
          );
          closeAgentDialog();
        }}
        // Source: close, start a new chat with the agent, pre-fill "@handle hi, ".
        onSayHi={(a) => {
          if (busy || sending.current) return;
          closeAgentDialog();
          newChat();
          setAgentId(a.id);
          setView("chat");
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
          sessionId={openingId ? undefined : session?._id}
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
