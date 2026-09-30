"use client";
import { useMemo, useState } from "react";
import { Icon } from "./v2/icon";
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
      className="hcard"
      id={`helpers-${id}`}
      tabIndex={-1}
      aria-label="Helper agents"
    >
      <header className="hcard-head">
        <span>{summary}</span>
        <LiveDuration
          className="mono sm muted"
          ms={groupElapsedMs(agents, now, state.skewMs)}
        />
      </header>
      {/* Announces count and status changes, never timer ticks. */}
      <p className="visually-hidden" aria-live="polite">
        {summary}
      </p>
      <ul className="hcard-rows">
        {agents.map((a, i) => (
          <HelperRow
            key={a.threadId}
            agent={a}
            tone={i % 3}
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

// Spec .ag-chip variants for finished states; running shows a spinner.
function chipClass(agent: SubAgent) {
  if (agent.status === "completed") return "is-done";
  if (agent.status === "errored" || agent.status === "notFound")
    return "is-warn";
  return "is-stopped";
}

function HelperRow({
  agent,
  tone,
  name,
  preview,
  elapsed,
  sessionId,
  onOpenAgent,
}: {
  agent: SubAgent;
  tone: number;
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

  const label = statusLabels[agent.status] || agent.status;
  return (
    <li className={`hcard-item ${agent.status}`}>
      <button
        type="button"
        className={`hcard-row tone-${tone}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        <span className="h-av xs" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="hcard-name" title={agent.task || title}>
          <span className="strong">{name}</span>
          <span className="muted"> · {title}</span>
        </span>
        {running ? (
          <span className="ag-chip is-running">
            <span className="spinner" aria-label="running" />
            {label}
          </span>
        ) : (
          <span className={`ag-chip ${chipClass(agent)}`}>{label}</span>
        )}
        <LiveDuration className="hcard-time mono sm muted" ms={elapsed} />
        <span className="hcard-go" aria-hidden="true">
          {open ? "Hide" : "Open"}
          <Icon name={open ? "chevron" : "chevronR"} size={13} />
        </span>
      </button>
      {open && (
        <div className="hcard-detail" id={detailId}>
          {output ? (
            <div className="hcard-output markdown">
              <Markdown remarkPlugins={[remarkGfm]}>
                {stripSuggestions(output, running)}
              </Markdown>
            </div>
          ) : (
            <p className="muted">
              {running ? "No output yet." : "No output was shared."}
            </p>
          )}
          {agent.task && <p className="hcard-task">{agent.task}</p>}
          {error && (
            <p role="alert" className="hcard-error">
              {error}
            </p>
          )}
          <div className="hcard-actions">
            {onOpenAgent && (
              <button
                type="button"
                className="btn-soft"
                onClick={() => onOpenAgent(agent.threadId)}
              >
                Open transcript
              </button>
            )}
            {running && (
              <button
                type="button"
                className="btn-ghost danger"
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
