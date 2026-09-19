"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Plus,
  Square,
  Activity,
  ChevronRight,
  MessageSquare,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ChatMessages } from "@/components/chat-messages";
import { applyChatEvent, historyEntries, type Entry } from "@/lib/chat";
import { RequestCard } from "@/components/request-card";
import { Capabilities } from "@/components/capabilities";
import { api, base } from "@/lib/api";
import { transport } from "@/lib/transport";
import type {
  AgentSummary,
  Session,
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
    [pending, setPending] = useState<PendingRequest[]>([]),
    [timings, setTimings] = useState<TurnTiming[]>([]);
  const [resolutions, setResolutions] = useState<any[]>([]);
  const [text, setText] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [running, setRunning] = useState(false),
    [status, setStatus] = useState("Not connected"),
    [panel, setPanel] = useState("events"),
    [plan, setPlan] = useState<any[]>([]),
    [diff, setDiff] = useState(""),
    [health, setHealth] = useState<any>(null);
  const scroll = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null),
    following = useRef(true),
    generation = useRef(0),
    sessionRef = useRef<Session | null>(null),
    seen = useRef(new Set<string>()),
    sending = useRef(false);
  const refreshSessions = () =>
    api("/api/sessions")
      .then(setSessions)
      .catch(() => {});
  const open = useCallback(async (id: string) => {
    const token = ++generation.current;
    setBusy(true);
    setError("");
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
      setResolutions(data.session.approvals || []);
      seen.current.clear();
      setPending([]);
      setTimings(data.session.timings || []);
      setPlan([]);
      setDiff("");
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
        setEvents((old) => [...old.slice(-299), event]);
        const d = event.data;
        setEntries((old) => applyChatEvent(old, event));
        switch (event.type) {
          case "snapshot":
            setPending(d.pending);
            setRunning(d.state.kind !== "idle");
            setPlan(d.plan || []);
            setDiff(d.diff || "");
            setTimings(d.timings || []);
            break;
          case "resync.required": {
            const token = generation.current;
            void api("/api/sessions/" + id)
              .then((data) => {
                if (
                  token !== generation.current ||
                  sessionRef.current?._id !== id
                )
                  return;
                setEntries((old) => {
                  let next = historyEntries(data.messages);
                  // Keep live items received while history was in flight.
                  for (const entry of old) {
                    if (entry.kind !== "message" || entry.role === "user") {
                      if (!next.some((e) => e.id === entry.id))
                        next.push(entry);
                    } else
                      next = applyChatEvent(next, {
                        type: "snapshot",
                        data: { messages: [{ ...entry, id: entry.itemId }] },
                      } as unknown as DomainEvent);
                  }
                  return next;
                });
              })
              .catch((e) => {
                if (token === generation.current) setError(e.message);
              });
            break;
          }
          case "turn.started":
            setRunning(true);
            setDiff("");
            setPlan([]);
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
          case "mcp.status":
            if (d.status === "failed")
              setError(
                `MCP server ${d.name || d.server || ""} failed: ${d.error || "startup failed"}`,
              );
            break;
          case "approval.resolved":
            setResolutions((old) => [
              ...old.filter((x) => x.requestId !== d.requestId),
              d,
            ]);
            setPending((old) => old.filter((p) => p.requestId !== d.requestId));
            break;
          case "plan.updated":
            setPlan(d.plan || []);
            break;
          case "diff.updated":
            setDiff(d.diff || "");
            break;
          case "error":
            setError(d.message || d.error?.message || "Runtime error");
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
    sessionRef.current = null;
    following.current = true;
    setSession(null);
    setEntries([]);
    setEvents([]);
    setResolutions([]);
    setPending([]);
    setTimings([]);
    setPlan([]);
    setDiff("");
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
  async function send() {
    if (
      sending.current ||
      !text.trim() ||
      busy ||
      (!sessionRef.current && !agentId)
    )
      return;
    sending.current = true;
    const token = generation.current;
    const value = text,
      clientId = crypto.randomUUID(),
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
          <details>
            <summary>Diagnostics</summary>
            <pre>{JSON.stringify(health, null, 2)}</pre>
          </details>
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
              label: `${a.name} — ${a.provider}/${a.model}`,
            }))}
            placeholder={loading ? "Loading agents…" : "Select an agent"}
          />
          <span className="muted">{agent?.description}</span>
        </div>
        {session && (
          <div className="session-meta">
            {session._id}
            <ChevronRight size={12} />
            {session.threadId}
            {session.status !== "active" && <b>{session.status}</b>}
          </div>
        )}
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
              <div className="eyebrow">A PLACE TO THINK AND BUILD</div>
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
                  No agents found. Add your agents and model profiles to the
                  truex database.
                </p>
              )}
            </div>
          ) : (
            <>
              <ChatMessages
                entries={entries}
                agentName={agent?.name || "Assistant"}
                running={running}
              />
              {resolutions.map((r) => (
                <p className="resolution" key={r.requestId}>
                  {r.reason === "expired"
                    ? "Automatically denied after the deadline"
                    : r.reason === "runtime-unavailable"
                      ? "Decision could not be delivered to the runtime"
                      : r.result?.decision === "accept" ||
                          r.result?.decision === "approved"
                        ? "Approved"
                        : r.result?.decision === "decline" ||
                            r.result?.decision?.denied
                          ? "Denied by user"
                          : `Request resolved · ${r.reason}`}
                </p>
              ))}
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
            void send();
          }}
        >
          <textarea
            ref={composer}
            aria-label="Message"
            placeholder={
              running
                ? "Add a thought to steer the current turn…"
                : "What would you like to work on?"
            }
            value={text}
            disabled={!session && !agentId}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            <span>Enter to send · Shift + Enter for a new line</span>
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
      <aside className="inspector">
        <div className="inspector-title">
          <Activity size={16} /> Session activity
        </div>
        <div className="tabs">
          {["events", "plan", "timings", "tools"].map((p) => (
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
          {panel === "events" &&
            (events.length ? (
              events.map((e, i) => (
                <details className="event" key={i}>
                  <summary>
                    <span>{e.type}</span>
                    <time>
                      {e.at ? new Date(e.at).toLocaleTimeString() : ""}
                    </time>
                  </summary>
                  <pre>{JSON.stringify(e.data, null, 2)}</pre>
                </details>
              ))
            ) : (
              <p className="muted">Events appear here as your agent works.</p>
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
                <p className="muted">No plan yet.</p>
              )}
              <h3>Changes</h3>
              <pre>{diff || "No changes yet."}</pre>
            </>
          )}
          {panel === "timings" && (
            <>
              <p className="muted">
                Average total:{" "}
                {timings.length
                  ? (
                      timings.reduce((s, t) => s + t.totalMs, 0) /
                      timings.length /
                      1000
                    ).toFixed(2)
                  : "—"}
                s
              </p>
              {timings.map((t, i) => (
                <div className="timing" key={t.turnId}>
                  <b>Turn {i + 1}</b>
                  <span>
                    {t.nonStreaming ? " · non-streaming" : ""} · {t.status}
                  </span>
                  <div className="timing-bar">
                    <i
                      style={{
                        width: `${((t.ttftMs || 0) / t.totalMs) * 100}%`,
                      }}
                    />
                    <i
                      style={{ width: `${(t.streamMs / t.totalMs) * 100}%` }}
                    />
                    <i
                      style={{ width: `${(t.finalizeMs / t.totalMs) * 100}%` }}
                    />
                  </div>
                  <small>
                    First output{" "}
                    {t.ttftMs === null
                      ? "—"
                      : (t.ttftMs / 1000).toFixed(2) + "s"}{" "}
                    · stream {(t.streamMs / 1000).toFixed(2)}s · total{" "}
                    {(t.totalMs / 1000).toFixed(2)}s
                  </small>
                </div>
              ))}
            </>
          )}
          {panel === "tools" &&
            (session ? (
              <Capabilities
                sessionId={session._id}
                onFork={(id) => {
                  void refreshSessions();
                  void open(id);
                }}
              />
            ) : (
              <p className="muted">
                Send your first message to explore capabilities.
              </p>
            ))}
        </div>
      </aside>
    </main>
  );
}
