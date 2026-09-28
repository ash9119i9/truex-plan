"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Plus,
  Square,
  MessageSquare,
  Layers,
  Sparkles,
  Target,
  X,
  Folder,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
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
import { RequestCard } from "@/components/request-card";
import { applyPlanEvent, awaitingApproval, type PlanStep } from "@/lib/plan";
import { Sheet } from "@/components/sheet";
import { ConnectedTools } from "@/components/connected-tools";
import { GoalBar } from "@/components/goal-bar";
import {
  awaitingReview,
  budgetHelp,
  goalCommand,
  goalStatus,
} from "@/lib/goal";
import { BudgetField } from "@/components/budget-field";
import { SmoothTextarea } from "@/components/smooth-textarea";
import { turnFailure, type TurnFailure } from "@/lib/goal-errors";
import {
  assistantCapabilities,
  type ConversationFile,
} from "../../shared/assistant-capabilities";
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
import {
  ProjectSidebar,
  SessionMenu,
  useProjects,
} from "@/components/project-sidebar";
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
// The public payload includes the alpha approval mode when it is enabled.
type Session = PublicSession;
// Goal starters open the composer in goal mode with a template.
const goalStarters = [
  { label: "Research report", text: "Research and write a cited report on " },
  { label: "Spreadsheet model", text: "Build a spreadsheet model that " },
  { label: "Project plan", text: "Create a complete project plan for " },
];
// Starter prompts shown on an empty conversation.
const starters = assistantCapabilities.filter((c) =>
  ["explain", "web", "documents", "visualize"].includes(c.id),
);
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
    [goalsOnly, setGoalsOnly] = useState(false),
    // The project a new chat will be created in (from a project's "+").
    [draftProjectId, setDraftProjectId] = useState<string | null>(null);
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
        const d = event.data;
        setEntries((old) => applyChatEvent(old, event));
        setSubAgents((old) => applySubAgentEvent(old, event));
        setObservability((old) => applyObservabilityEvent(old, event));
        setPlan((old) => applyPlanEvent(old, event));
        switch (event.type) {
          case "snapshot":
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

            reloadTranscript();
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
  // The inspector is hidden on narrow screens; show agents in a sheet there.
  // With a helper given, its card is brought into view once rendered.
  function openAgents(threadId?: string) {
    if (!window.matchMedia("(max-width: 1100px)").matches)
      setInspectorTab("agents");
    else setPanel("agents");
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
      { kind: "message", id, role: "user", text: value, delivery: "pending" },
    ]);
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
  return (
    <main className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/">
          truex<span> / agents</span>
        </a>
        <div className="eyebrow">WORKSPACE</div>
        <Button variant="outline" onClick={() => startDraft()} disabled={busy}>
          <Plus size={16} /> New conversation
        </Button>
        <ProjectSidebar
          state={projects}
          sessions={sessions}
          currentSessionId={session?._id}
          busy={busy}
          onOpen={(id) => void open(id)}
          onNewChat={(id) => startDraft(id)}
          onDeleted={(id) =>
            setDraftProjectId((old) => (old === id ? null : old))
          }
          onSessionUpdated={updateCurrentProject}
        />
        <div className="sidebar-label">
          Recent conversations
          <button
            type="button"
            className="sidebar-filter"
            aria-pressed={goalsOnly}
            onClick={() => setGoalsOnly((on) => !on)}
            title="Show only conversations with a goal"
          >
            Goals
          </button>
        </div>
        <nav>
          {sessionsFailed && (
            <p className="sidebar-refresh-error" role="alert">
              Couldn’t refresh ·{" "}
              <button
                type="button"
                className="inline-retry"
                onClick={() => void refreshSessions()}
              >
                Retry
              </button>
            </p>
          )}
          {goalsOnly && !sessions.some((s) => s.goal) && (
            <p className="sidebar-empty">No conversations with goals yet.</p>
          )}
          {(goalsOnly ? sessions.filter((s) => s.goal) : sessions).map((s) => (
            <div key={s._id} className="session-row">
              <button
                className={
                  session?._id === s._id
                    ? "session-link selected"
                    : "session-link"
                }
                disabled={busy}
                onClick={() => void open(s._id)}
              >
                {s.goal ? (
                  <Target
                    size={14}
                    className="session-goal"
                    data-tone={goalStatus[s.goal.status]?.tone}
                    aria-hidden="true"
                  />
                ) : (
                  <MessageSquare size={14} />
                )}
                <span>
                  <b>{s.title || "New conversation"}</b>
                  <small>
                    {s.goal &&
                      `Goal ${goalStatus[s.goal.status]?.label.toLowerCase() || ""} · `}
                    {agents.find((a) => a.id === s.agentId)?.name || s.agentId}{" "}
                    · {new Date(s.createdAt).toLocaleString()}
                  </small>
                </span>
              </button>
              <SessionMenu
                session={s}
                state={projects}
                disabled={busy}
                onUpdated={updateCurrentProject}
              />
            </div>
          ))}
        </nav>
        <div className="health">
          <span className={health?.ok ? "dot good" : "dot"} />
          {health?.ok ? "All systems connected" : "Connection needs attention"}
        </div>
      </aside>
      <section className="conversation">
        <header className="topbar">
          <h1>
            {session
              ? session.title || "Untitled conversation"
              : "New conversation"}
          </h1>
          <div className="topbar-actions">
            {session && (
              <span className="connection" role="status">
                <span className={status === "Connected" ? "dot good" : "dot"} />
                {retrying && status === "Connected" ? "Retrying…" : status}
                {status === "Reconnecting" && slowReconnect && (
                  <span className="connection-hint">
                    Still trying. Check your network.
                  </span>
                )}
                {status === "Disconnected" && (
                  <button
                    type="button"
                    className="connection-retry"
                    onClick={() => {
                      setStatus("Reconnecting");
                      setStreamKey((k) => k + 1);
                    }}
                  >
                    Retry
                  </button>
                )}
              </span>
            )}
            <Select
              value={agentId}
              onValueChange={setAgentId}
              options={agents.map((a) => ({
                value: a.id,
                label: a.name,
              }))}
              placeholder={loading ? "Loading agents…" : "Select an agent"}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setPanel("tools")}
              aria-label="Capabilities, documents & visuals"
              title="Capabilities, documents & visuals (/tools)"
            >
              <Sparkles size={16} />
            </button>
          </div>
        </header>
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
        <div
          className="transcript"
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
          {!session && !entries.length ? (
            <div className="empty">
              <div className="empty-icon">
                <Layers size={22} />
              </div>
              <h2>How can I help today?</h2>
              <p>
                {agent
                  ? `Ask ${agent.name} anything, or type / for commands and tools.`
                  : "Choose an agent to start a conversation."}
              </p>
              <div className="starters" aria-label="Suggestions">
                {starters.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    disabled={!agentId}
                    onClick={() => applyPrompt(c.prompt)}
                  >
                    <strong>{c.name}</strong>
                    <span>{c.description}</span>
                  </button>
                ))}
              </div>
              <div className="goal-starters" aria-label="Start with a goal">
                <span>Or start with a goal the assistant works through</span>
                {goalStarters.map((g) => (
                  <button
                    type="button"
                    key={g.label}
                    disabled={!agentId}
                    onClick={() => startGoal(g.text)}
                  >
                    <Target size={13} aria-hidden="true" /> {g.label}
                  </button>
                ))}
              </div>
              {!loading && !agents.length && (
                <p className="empty-note">
                  No agents are available. Contact your Truex administrator.
                </p>
              )}
            </div>
          ) : (
            <>
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
              />
              {session &&
                pending.map((p) => (
                  <RequestCard
                    key={p.requestId}
                    request={p}
                    plan={plan}
                    onAnswer={async (result) => {
                      await transport.answer(session._id, p.requestId, result);
                    }}
                  />
                ))}
            </>
          )}
        </div>
        <HelperChip state={subAgents} onView={viewHelpers} />
        <form
          className={goalMode ? "composer goal-mode" : "composer"}
          onSubmit={(e) => {
            e.preventDefault();
            void submitInput();
          }}
        >
          {goalMode && (
            <div className="composer-goal-head">
              <Target size={14} aria-hidden="true" />
              <span>
                <strong>New goal</strong> The assistant keeps working until the
                goal is done, paused or out of budget.
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setGoalMode(false)}
                aria-label="Cancel goal"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {pendingProject && (
            <div className="composer-project" role="status">
              <Folder size={13} aria-hidden="true" />
              <span>
                New chat in <strong>{pendingProject.name}</strong>
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setDraftProjectId(null)}
                aria-label={`Don't add to ${pendingProject.name}`}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <PrivacyNote draft={text} />
          <SmoothTextarea
            ref={composer}
            aria-label="Message"
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
              goalMode
                ? "Describe the outcome you want. The assistant works until it’s done."
                : running
                  ? "Add a thought to steer the current turn…"
                  : "Ask a question or type / for commands"
            }
            value={text}
            disabled={busy || (!session && !agentId)}
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
          <div className="composer-footer">
            <span id="composer-hint" className="visually-hidden">
              Type / for commands. Enter to send, Shift + Enter for a new line.
            </span>
            <div className="composer-tools">
              <button
                type="button"
                className="composer-chip"
                aria-pressed={goalMode}
                onClick={() =>
                  goalMode ? setGoalMode(false) : startGoal(text)
                }
                title="Set this message as the conversation goal"
              >
                <Target size={14} aria-hidden="true" /> Goal
              </button>
              {goalMode && (
                <BudgetField
                  initial={goalBudget}
                  selectClassName="composer-select"
                  onChange={({ tokens, valid }) => {
                    setGoalBudget(tokens);
                    setGoalBudgetValid(valid);
                  }}
                />
              )}
              <button
                type="button"
                className="composer-chip"
                onClick={() => setPanel("tools")}
                title="Capabilities, documents & visuals (/tools)"
              >
                <Sparkles size={14} aria-hidden="true" /> Tools
              </button>
              {agentId && (
                <ConnectedTools
                  key={agentId}
                  agentId={agentId}
                  refreshKey={mcpVersion}
                  onManage={() => setPanel("mcp")}
                />
              )}
              {picker && (
                <ApprovalModePicker
                  picker={picker}
                  errorId={modeError ? "approval-mode-error" : undefined}
                  onChange={(mode) => void changeApprovalMode(mode)}
                />
              )}
            </div>
            {running && (
              <Button
                type="button"
                variant="outline"
                title={
                  goal?.status === "active"
                    ? "Pause the goal and stop the current response"
                    : "Stop the current response"
                }
                onClick={() =>
                  void (async () => {
                    const id = session!._id;
                    try {
                      // An active goal restarts on its own once the thread is
                      // idle, so pause it before stopping the turn.
                      if (goal?.status === "active") {
                        const data = await api(
                          `/api/sessions/${id}/capabilities`,
                          {
                            method: "thread/goal/set",
                            params: { status: "paused" },
                          },
                        );
                        setGoal(data.goal);
                        syncSessionGoal(id, data.goal);
                      }
                      await transport.interrupt(id).catch((e) => {
                        // The turn already ended, so there is nothing to stop.
                        if (!(e instanceof ApiRequestError && e.status === 409))
                          throw e;
                      });
                    } catch (e) {
                      reportError(e);
                    }
                  })()
                }
              >
                <Square size={12} />
                Stop
              </Button>
            )}
            <Button
              type="submit"
              disabled={!text.trim() || busy || (!session && !agentId)}
              aria-label={goalMode ? "Set goal" : "Send message"}
            >
              <ArrowUp size={18} />
            </Button>
          </div>
        </form>
      </section>
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
        sessionId={session?._id}
        goal={goal}
        goalReview={goalReview}
        tab={inspectorTab}
        onTab={setInspectorTab}
        subAgents={subAgents}
        delegation={delegation}
        onDelegation={changeDelegation}
      />
      <Sheet
        open={panel === "agents"}
        title="Helper agents"
        description="Agents your assistant started for parts of this task."
        onClose={() => setPanel(null)}
      >
        <AgentsPanel
          sessionId={session?._id}
          agents={subAgents.agents}
          previews={subAgents.previews}
          skewMs={subAgents.skewMs}
        />
      </Sheet>
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
    </main>
  );
}
