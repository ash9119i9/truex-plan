"use client";
import { useMemo, useState } from "react";
import { Check, ChevronDown, CircleDot, Square, X } from "lucide-react";
import Markdown from "react-markdown";
import { stripSuggestions } from "@/lib/suggestions";
import remarkGfm from "remark-gfm";
import { interruptAgent } from "@/lib/api";
import {
  elapsedMs,
  groupElapsedMs,
  helperName,
  isRunning,
  previewTail,
  statusLabels,
  taskTitle,
  type SubAgentState,
} from "@/lib/subagents";
import type { SubAgent } from "../../shared/contracts";
import { useClock } from "./use-clock";
import { LiveDuration } from "./live-duration";

// The helper agents one turn started, shown inline where the user is reading.
export function HelperGroup({
  id,
  threadIds,
  state,
  sessionId,
  onOpenAgent,
}: {
  id: string;
  threadIds: string[];
  state: SubAgentState;
  sessionId?: string;
  onOpenAgent?: (threadId: string) => void;
}) {
  const agents = useMemo(
    () =>
      threadIds
        .map((t) => state.agents.find((a) => a.threadId === t))
        .filter((a): a is SubAgent => !!a),
    [threadIds, state.agents],
  );
  const running = agents.filter(isRunning).length;
  const now = useClock(running > 0);
  if (!agents.length) return null;
  const done = agents.length - running;
  const summary = [
    `${agents.length} ${agents.length === 1 ? "helper" : "helpers"}`,
    running ? `${running} running` : "",
    done ? `${done} done` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section
      className="helper-group"
      id={`helpers-${id}`}
      tabIndex={-1}
      aria-label="Helper agents"
    >
      <header className="helper-group-head">
        <span className="helper-group-summary">{summary}</span>
        <LiveDuration
          className="helper-time"
          ms={groupElapsedMs(agents, now, state.skewMs)}
        />
      </header>
      {/* Announces count and status changes, never timer ticks. */}
      <p className="visually-hidden" aria-live="polite">
        {summary}
      </p>
      <ul className="helper-rows">
        {agents.map((a) => (
          <HelperRow
            key={a.threadId}
            agent={a}
            name={helperName(a, state.agents)}
            preview={state.previews[a.threadId] || ""}
            elapsed={elapsedMs(a, now, state.skewMs)}
            sessionId={sessionId}
            onOpenAgent={onOpenAgent}
          />
        ))}
      </ul>
    </section>
  );
}

function StatusIcon({ agent }: { agent: SubAgent }) {
  if (isRunning(agent))
    return <CircleDot size={14} className="helper-icon running" aria-hidden />;
  if (agent.status === "completed")
    return <Check size={14} className="helper-icon done" aria-hidden />;
  if (agent.status === "errored")
    return <X size={14} className="helper-icon failed" aria-hidden />;
  return <Square size={12} className="helper-icon stopped" aria-hidden />;
}

function HelperRow({
  agent,
  name,
  preview,
  elapsed,
  sessionId,
  onOpenAgent,
}: {
  agent: SubAgent;
  name: string;
  preview: string;
  elapsed: number;
  sessionId?: string;
  onOpenAgent?: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const running = isRunning(agent);
  const title = taskTitle(agent.task);
  const detailId = `helper-detail-${agent.threadId}`;
  const output = previewTail(running ? preview : agent.lastMessage || preview);

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

  return (
    <li className={`helper-row ${agent.status}`}>
      <button
        type="button"
        className="helper-row-main"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        <StatusIcon agent={agent} />
        <span className="helper-label">
          <span className="helper-title" title={agent.task || title}>
            {title}
          </span>
          <span className="helper-name">{name}</span>
        </span>
        <span className="helper-status">
          {statusLabels[agent.status] || agent.status}
        </span>
        <LiveDuration className="helper-time" ms={elapsed} />
        <ChevronDown size={14} className="helper-chevron" aria-hidden />
      </button>
      {open && (
        <div className="helper-detail" id={detailId}>
          {output ? (
            <div className="helper-output markdown">
              <Markdown remarkPlugins={[remarkGfm]}>
                {stripSuggestions(output, running)}
              </Markdown>
            </div>
          ) : (
            <p className="muted">
              {running ? "No output yet." : "No output was shared."}
            </p>
          )}
          {agent.task && <p className="helper-task">{agent.task}</p>}
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          <div className="helper-actions">
            {onOpenAgent && (
              <button
                type="button"
                className="link-button"
                onClick={() => onOpenAgent(agent.threadId)}
              >
                Open transcript
              </button>
            )}
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
        </div>
      )}
    </li>
  );
}
