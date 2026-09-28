"use client";
import { useState } from "react";
import Markdown from "react-markdown";
import { stripSuggestions } from "@/lib/suggestions";
import remarkGfm from "remark-gfm";
import { getAgentTranscript, interruptAgent } from "@/lib/api";
import {
  elapsedMs,
  helperName,
  isRunning,
  previewTail,
  statusLabels,
  taskTitle,
} from "@/lib/subagents";
import { useClock } from "./use-clock";
import { LiveDuration } from "./live-duration";
import type { SubAgent, SubAgentTranscript } from "../../shared/contracts";

export function AgentsPanel({
  sessionId,
  agents,
  previews,
  skewMs,
}: {
  sessionId?: string;
  agents: SubAgent[];
  previews: Record<string, string>;
  skewMs?: number;
}) {
  const now = useClock(agents.some(isRunning));
  if (!agents.length)
    return (
      <p className="muted">
        Helper agents appear here when your assistant delegates part of a task.
      </p>
    );
  return (
    <ul className="agents-list" aria-label="Helper agents">
      {agents.map((a) => (
        <AgentCard
          key={a.threadId}
          sessionId={sessionId}
          agent={a}
          name={helperName(a, agents)}
          preview={previews[a.threadId] || ""}
          elapsed={elapsedMs(a, now, skewMs)}
        />
      ))}
    </ul>
  );
}

function AgentCard({
  sessionId,
  agent,
  name,
  preview,
  elapsed,
}: {
  sessionId?: string;
  agent: SubAgent;
  name: string;
  preview: string;
  elapsed: number;
}) {
  const [taskOpen, setTaskOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState<SubAgentTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const running = isRunning(agent);
  const transcriptId = `agent-transcript-${agent.threadId}`;
  const task = agent.task || "";
  const longTask = task.length > 140;

  async function loadTranscript() {
    if (!sessionId) return;
    setLoading(true);
    setError("");
    try {
      setTranscript(await getAgentTranscript(sessionId, agent.threadId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function stop() {
    if (!sessionId) return;
    setStopping(true);
    setError("");
    try {
      await interruptAgent(sessionId, agent.threadId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  }
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void loadTranscript();
  }
  // Streamed text not yet in the fetched transcript.
  const saved = transcript?.messages.map((m) => m.text).join("\n\n") || "";
  const live =
    running && preview && !saved.endsWith(preview.trim()) ? preview : "";

  return (
    <li
      className="agent-card"
      id={`agent-card-${agent.threadId}`}
      tabIndex={-1}
    >
      <div className="agent-head">
        <b>
          {taskTitle(agent.task)} <span className="agent-name">· {name}</span>
        </b>
        <span className={`agent-status ${agent.status}`}>
          {statusLabels[agent.status] || agent.status}
        </span>
      </div>
      <div className="agent-meta">
        {agent.role && agent.nickname && <span>{agent.role} · </span>}
        {agent.depth > 1 && <span>Level {agent.depth} · </span>}
        <LiveDuration ms={elapsed} />
      </div>
      {task && (
        <p className="agent-task">
          {longTask && !taskOpen ? task.slice(0, 140) + "…" : task}
          {longTask && (
            <button
              type="button"
              className="link-button"
              aria-expanded={taskOpen}
              onClick={() => setTaskOpen(!taskOpen)}
            >
              {taskOpen ? "Show less" : "Show more"}
            </button>
          )}
        </p>
      )}
      {!open && (running ? preview : agent.lastMessage) && (
        <div className="agent-preview markdown">
          <Markdown remarkPlugins={[remarkGfm]}>
            {stripSuggestions(
              previewTail(running ? preview : agent.lastMessage || ""),
              running,
            )}
          </Markdown>
        </div>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="agent-actions">
        <button
          type="button"
          className="link-button"
          aria-expanded={open}
          aria-controls={transcriptId}
          onClick={toggle}
          disabled={!sessionId}
        >
          {open ? "Hide transcript" : "View transcript"}
        </button>
        {running && (
          <button
            type="button"
            className="agent-stop"
            onClick={stop}
            disabled={stopping || !sessionId}
            aria-label={`Stop ${name}`}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {open && (
        <div className="agent-transcript" id={transcriptId}>
          {loading && !transcript && <p className="muted">Loading…</p>}
          {transcript?.messages.map((m) => (
            <div key={m.id} className="markdown">
              <Markdown remarkPlugins={[remarkGfm]}>
                {stripSuggestions(m.text)}
              </Markdown>
            </div>
          ))}
          {live && <pre aria-live="polite">{live}</pre>}
          {transcript && !transcript.messages.length && !live && (
            <p className="muted">No output yet.</p>
          )}
        </div>
      )}
    </li>
  );
}
