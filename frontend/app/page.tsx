"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Plus, Square, MessageSquare, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ChatMessages } from "@/components/chat-messages";
import {
  applyChatEvent,
  historyEntries,
  mergeHistoryEntries,
  type Entry,
} from "@/lib/chat";
import { SessionActivity } from "@/components/session-activity";
import { McpSettings } from "@/components/mcp-settings";
import { RequestCard } from "@/components/request-card";
import { api, base } from "@/lib/api";
import { transport } from "@/lib/transport";
import { parseChatInput, suggestCommands } from "@/lib/slash-commands";
import type {
  AgentSummary,
  PublicSession as Session,
  DomainEvent,
  PendingRequest,
  TurnTiming,
} from "../../shared/contracts";
export default function Home() {
  const [agents, setAgents] = useState<AgentSummary[]>([]),
    [agentId, setAgentId] = useState(""),
    [sessions, setSessions] = useState<Session[]>([]),
    [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]),
    [events, setEvents] = useState<DomainEvent[]>([]),
    [pending, setPending] = useState<PendingRequest[]>([]);
  const [plan, setPlan] = useState<{ step: string; status: string }[]>([]);
  const [timings, setTimings] = useState<TurnTiming[]>([]);
  const [text, setText] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [commandOpen, setCommandOpen] = useState(false),
    [commandIndex, setCommandIndex] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [running, setRunning] = useState(false),
    [status, setStatus] = useState("Not connected"),
    [health, setHealth] = useState<any>(null);
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
  const refreshSessions = () =>
    api("/api/sessions")
      .then(setSessions)
      .catch(() => {});
  const open = useCallback(async (id: string) => {
    const token = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setCommandOpen(false);
    try {
      const data = await api("/api/sessions/" + id);
      if (token !== generation.current) return;
      sessionRef.current = data.session;
      setSession(data.session);
      setAgentId(data.session.agentId);
      following.current = true;
      setEntries(
        data.snapshot
          ? applyChatEvent(historyEntries(data.messages), {
              type: "snapshot",
              data: data.snapshot,
            } as DomainEvent)
          : historyEntries(data.messages),
      );
      setEvents([]);

      seen.current.clear();
      setPending(data.snapshot?.pending || []);
      setPlan(data.snapshot?.plan || []);
      setTimings(data.snapshot?.timings || []);
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
        .catch(() => {});

      setRunning(!!data.snapshot && data.snapshot.state.kind !== "idle");
      if (data.recoveryError) setError(data.recoveryError);
      history.replaceState(null, "", "?session=" + id);
    } catch (e) {
      if (token === generation.current) setError((e as Error).message);
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    fetch(base + "/healthz")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
    api("/api/agents")
      .then((data) => {
        setAgents(data);
        setAgentId(data[0]?.id || "");
      })
      .catch((e) => setError(e.message))
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
          setEntries((old) => mergeHistoryEntries(data.messages, old));
        })
        .catch((e) => {
          if (token === generation.current) setError(e.message);
        });
    };
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
          ["activity.updated", "turn.started", "turn.completed"].includes(
            event.type,
          )
        )
          setEvents((old) => [...old.slice(-99), event]);
        const d = event.data;
        setEntries((old) => applyChatEvent(old, event));
        switch (event.type) {
          case "snapshot":
            setPending(d.pending);
            setRunning(d.state.kind !== "idle");
            setPlan(d.plan || []);
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
            reloadTranscript();
            break;
          case "turn.started":
            setRunning(true);
            setPlan([]);

            break;
          case "plan.updated":
            setPlan(d.plan || []);
            break;
          case "turn.completed":
            setRunning(false);
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
            setError(d.message || "The request could not be completed.");
            break;
        }
      },
      setStatus,
    );
  }, [session?._id]);
  useEffect(() => {
    if (following.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "instant",
      });
  }, [entries, pending]);
  function startDraft() {
    generation.current++;
    setText("");
    setNotice("");
    setCommandOpen(false);
    sessionRef.current = null;
    following.current = true;
    setSession(null);
    setEntries([]);
    setEvents([]);

    setPending([]);
    setPlan([]);
    setTimings([]);

    setError("");
    setRunning(false);
    setBusy(false);
    setStatus("Not connected");
    seen.current.clear();
    history.replaceState(null, "", location.pathname);
    composer.current?.focus();
  }
  async function ensureSession(): Promise<Session> {
    if (sessionRef.current) return sessionRef.current;
    const token = generation.current;
    const created: Session = await api("/api/sessions", { agentId });
    if (token !== generation.current) return created;
    sessionRef.current = created;
    setSession(created);
    history.replaceState(null, "", "?session=" + created._id);
    void refreshSessions();
    return created;
  }
  async function send(value = text) {
    if (
      sending.current ||
      !text.trim() ||
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
      setError((e as Error).message);
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
    const parsed = parseChatInput(text);
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
    if (input.kind === "invalid") {
      setNotice(input.message);
      return;
    }
    if (input.kind === "help") {
      setNotice(
        "Commands: /goal [objective|show|clear], /fork, /compact, /model <identifier>, /effort <level>, /archive, /unarchive. Use // to send a literal command as a question.",
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
    const active = sessionRef.current;
    if (!active) {
      setNotice(
        "Start a conversation with a message before using this command. Your draft is saved.",
      );
      return;
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
        setError((e as Error).message);
      }
    } finally {
      sending.current = false;
      if (token === generation.current) setBusy(false);
    }
  }
  const agent = agents.find((a) => a.id === agentId);
  return (
    <main className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/">
          truex<span> / agents</span>
        </a>
        <div className="eyebrow">WORKSPACE</div>
        <Button variant="outline" onClick={startDraft} disabled={busy}>
          <Plus size={16} /> New conversation
        </Button>
        <div className="sidebar-label">Recent conversations</div>
        <nav>
          {sessions.map((s) => (
            <button
              key={s._id}
              className={
                session?._id === s._id
                  ? "session-link selected"
                  : "session-link"
              }
              disabled={busy}
              onClick={() => void open(s._id)}
            >
              <MessageSquare size={14} />
              <span>
                <b>{s.title || "New conversation"}</b>
                <small>
                  {agents.find((a) => a.id === s.agentId)?.name || s.agentId} ·{" "}
                  {new Date(s.createdAt).toLocaleString()}
                </small>
              </span>
            </button>
          ))}
        </nav>
        <div className="health">
          <span className={health?.ok ? "dot good" : "dot"} />
          {health?.ok ? "All systems connected" : "Connection needs attention"}
        </div>
      </aside>
      <section className="conversation">
        <header>
          <div>
            <div className="eyebrow">AGENT WORKSPACE</div>
            <h1>{agent?.name || "Your next conversation"}</h1>
          </div>
          <div className="connection">
            <span className={status === "Connected" ? "dot good" : "dot"} />
            {status}
          </div>
        </header>
        <div className="agent-bar">
          <Select
            value={agentId}
            onValueChange={setAgentId}
            options={agents.map((a) => ({
              value: a.id,
              label: a.name,
            }))}
            placeholder={loading ? "Loading agents…" : "Select an agent"}
          />
          <span className="muted">{agent?.description}</span>
        </div>
        {agentId && <McpSettings key={agentId} agentId={agentId} />}
        {error && (
          <div role="alert" className="error-banner">
            {error}
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
                <Layers size={30} />
              </div>
              <div className="eyebrow">YOUR BUSINESS ASSISTANT</div>
              <h2>Start with a conversation.</h2>
              <p>
                Choose an agent and ask your first question. The session starts
                when you send it.
              </p>
              <Button
                onClick={() => composer.current?.focus()}
                disabled={!agentId}
              >
                Ask your first question
                <ArrowUp size={16} />
              </Button>
              {!loading && !agents.length && (
                <p>
                  No agents are available. Contact your Truex administrator.
                </p>
              )}
            </div>
          ) : (
            <>
              <ChatMessages
                entries={entries}
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
                    onAnswer={async (result) => {
                      await transport.answer(session._id, p.requestId, result);
                    }}
                  />
                ))}
            </>
          )}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submitInput();
          }}
        >
          <textarea
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
              running
                ? "Add a thought to steer the current turn…"
                : "Ask a question or type / for commands"
            }
            value={text}
            disabled={busy || (!session && !agentId)}
            onChange={(e) => {
              setText(e.target.value);
              setCommandOpen(e.target.value.startsWith("/"));
              setCommandIndex(0);
              if (notice) setNotice("");
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape") {
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
          <div className="composer-footer">
            <span id="composer-hint">
              / for commands · Enter to send · Shift + Enter for a new line
            </span>
            {running && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void transport
                    .interrupt(session!._id)
                    .catch((e) => setError(e.message))
                }
              >
                <Square size={12} />
                Stop
              </Button>
            )}
            <Button
              type="submit"
              disabled={!text.trim() || busy || (!session && !agentId)}
              aria-label="Send message"
            >
              <ArrowUp size={18} />
            </Button>
          </div>
        </form>
      </section>
      <SessionActivity events={events} plan={plan} timings={timings} />
    </main>
  );
}
