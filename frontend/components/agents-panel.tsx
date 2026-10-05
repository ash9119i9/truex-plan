"use client";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripSuggestions } from "@/lib/suggestions";
import { getAgentTranscript } from "@/lib/api";
import { formatDuration } from "@/lib/observability";
import {
  elapsedMs,
  groupElapsedMs,
  helperName,
  helperStatusLabel,
  isRunning,
  isTerminal,
  previewTail,
  spawnOrder,
  taskTitle,
} from "@/lib/subagents";
import { useClock } from "./use-clock";
import { Icon } from "./v2/icon";
import type {
  SubAgent,
  SubAgentStatus,
  SubAgentTranscript,
} from "../../shared/contracts";

type Chip = "is-running" | "is-done" | "is-stopped" | "is-warn";
const chipTone: Record<SubAgentStatus, Chip> = {
  pendingInit: "is-running",
  running: "is-running",
  completed: "is-done",
  interrupted: "is-stopped",
  shutdown: "is-stopped",
  errored: "is-warn",
  notFound: "is-warn",
};

export function StatusChip({ agent }: { agent: SubAgent }) {
  const tone = chipTone[agent.status] || "is-stopped";
  return (
    <span className={`ag-chip ${tone}`} role="status">
      {tone === "is-running" && <span className="spinner" aria-hidden="true" />}
      {tone === "is-warn" && <span aria-hidden="true">⚠</span>}
      {helperStatusLabel(agent)}
    </span>
  );
}

// Helper avatar: first letter of the name on the helper's tone.
export function HelperAvatar({
  name,
  tone,
  size,
}: {
  name: string;
  tone: number;
  size?: "xs" | "lg";
}) {
  return (
    <span className={`h-av tone-${tone % 3}${size ? ` ${size}` : ""}`} aria-hidden="true">
      {(name.trim()[0] || "H").toUpperCase()}
    </span>
  );
}

interface Helper {
  agent: SubAgent;
  name: string;
  tone: number;
  elapsed: number;
}

export function AgentsPanel({
  sessionId,
  agents,
  previews,
  skewMs,
  onDetailChange,
  onStopAgent,
  stopDisabled = false,
}: {
  sessionId?: string;
  agents: SubAgent[];
  previews: Record<string, string>;
  skewMs?: number;
  // Opening a helper switches the panel to its wide "detail" size.
  onDetailChange?: (open: boolean) => void;
  onStopAgent?: (threadId: string) => void;
  stopDisabled?: boolean;
}) {
  const now = useClock(agents.some(isRunning));
  const [openId, setOpenId] = useState<string | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const ordered = spawnOrder(agents);
  const helpers: Helper[] = ordered.map((agent, i) => ({
    agent,
    name: helperName(agent, agents),
    tone: i % 3,
    elapsed: elapsedMs(agent, now, skewMs),
  }));
  const openIndex = helpers.findIndex((h) => h.agent.threadId === openId);
  const detailOpen = openIndex >= 0;

  // Tell the shell when the detail view opens or closes (and on unmount).
  const report = useRef(onDetailChange);
  report.current = onDetailChange;
  useEffect(() => {
    report.current?.(detailOpen);
  }, [detailOpen]);
  useEffect(() => () => report.current?.(false), []);

  if (!helpers.length)
    return (
      <div className="empty-tab">
        <span className="tile lg">
          <Icon name="bot" size={20} />
        </span>
        <span className="strong">No helpers yet</span>
        <span className="muted sm">
          When the assistant hands part of a task to a helper, it shows up here.
        </span>
      </div>
    );

  if (detailOpen)
    return (
      <HelperDetail
        key={`${sessionId}:${helpers[openIndex].agent.threadId}`}
        sessionId={sessionId}
        helper={helpers[openIndex]}
        onStopAgent={onStopAgent}
        stopDisabled={stopDisabled}
        index={openIndex}
        count={helpers.length}
        preview={previews[helpers[openIndex].agent.threadId] || ""}
        onBack={() => setOpenId(null)}
        onPage={(step) =>
          setOpenId(
            helpers[(openIndex + step + helpers.length) % helpers.length].agent
              .threadId,
          )
        }
      />
    );

  const counts = {
    running: helpers.filter((h) => isRunning(h.agent)).length,
    done: helpers.filter((h) => h.agent.status === "completed").length,
    stopped: helpers.filter(
      (h) => !isRunning(h.agent) && h.agent.status !== "completed",
    ).length,
  };
  const summary = [
    `${helpers.length} helper${helpers.length === 1 ? "" : "s"}`,
    counts.running && `${counts.running} running`,
    counts.done && `${counts.done} done`,
    counts.stopped && `${counts.stopped} stopped`,
  ]
    .filter(Boolean)
    .join(" · ");
  const span = groupElapsedMs(agents, now, skewMs);

  return (
    <div className="ag-list">
      <div className="ag-summary">
        <span className="strong">{summary}</span>
        <span className="mono sm muted">{formatDuration(span)}</span>
      </div>
      {helpers.length >= 2 && (
        <Lanes helpers={helpers} now={now} skewMs={skewMs} lit={lit} />
      )}
      <ul className="ag-rows" aria-label="Helper agents">
        {helpers.map((h) => (
          <li key={h.agent.threadId}>
            <HelperRow
              helper={h}
              preview={previews[h.agent.threadId] || ""}
              lit={lit === h.agent.threadId}
              onLit={setLit}
              onOpen={() => setOpenId(h.agent.threadId)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

// When each helper started and how long it ran, on one shared axis.
function Lanes({
  helpers,
  now,
  skewMs = 0,
  lit,
}: {
  helpers: Helper[];
  now: number;
  skewMs?: number;
  lit: string | null;
}) {
  const current = now + (Number.isFinite(skewMs) ? skewMs : 0);
  const starts = helpers.map((h) => Date.parse(h.agent.startedAt) || current);
  const t0 = Math.min(...starts);
  const ends = helpers.map((h, i) => starts[i] + h.elapsed);
  const span = Math.max(1, Math.max(...ends) - t0);
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  return (
    <div className="ag-timeline" aria-hidden="true">
      {helpers.map((h, i) => (
        <div
          key={h.agent.threadId}
          className={`ag-lane tone-${h.tone}${lit === h.agent.threadId ? " is-lit" : ""}`}
        >
          <span className="ag-lane-name">{h.name}</span>
          <div className="ag-track">
            <i
              className={`ag-span${isRunning(h.agent) ? " is-running" : ""}`}
              style={{
                left: `${clamp(((starts[i] - t0) / span) * 100)}%`,
                width: `${clamp((h.elapsed / span) * 100)}%`,
              }}
            />
          </div>
          <span className="ag-lane-time">{formatDuration(h.elapsed)}</span>
        </div>
      ))}
      <div className="ag-axis">
        <span>0s</span>
        <span>{formatDuration(span)}</span>
      </div>
    </div>
  );
}

function HelperRow({
  helper,
  preview,
  lit,
  onLit,
  onOpen,
}: {
  helper: Helper;
  preview: string;
  lit: boolean;
  onLit: (id: string | null) => void;
  onOpen: () => void;
}) {
  const { agent, name, tone, elapsed } = helper;
  const running = isRunning(agent);
  const role = agent.role && agent.nickname ? agent.role : "";
  const text = previewTail(
    isTerminal(agent.status) ? agent.lastMessage || preview : preview,
    200,
    3,
  );
  return (
    <button
      type="button"
      // page.tsx scrolls to and focuses this id when a chat chip opens a helper.
      id={`agent-card-${agent.threadId}`}
      className={`ag-row tone-${tone}${lit ? " is-lit" : ""}`}
      onClick={onOpen}
      onMouseEnter={() => onLit(agent.threadId)}
      onMouseLeave={() => onLit(null)}
      onFocus={() => onLit(agent.threadId)}
      onBlur={() => onLit(null)}
    >
      <HelperAvatar name={name} tone={tone} />
      <span className="ag-row-body">
        <span className="ag-row-top">
          <span>
            <span className="strong">{name}</span>
            <span className="muted"> · {role || taskTitle(agent.task)}</span>
          </span>
          <StatusChip agent={agent} />
        </span>
        <span className="ag-row-meta">
          {formatDuration(elapsed)}
          {running ? " · working…" : ""}
          {agent.depth > 1 ? ` · level ${agent.depth}` : ""}
        </span>
        {text && (
          <span className="ag-preview">{stripSuggestions(text, running)}</span>
        )}
      </span>
      <Icon name="chevronR" size={15} className="ag-chev" />
    </button>
  );
}

type Seg = "output" | "task" | "transcript";

function HelperDetail({
  sessionId,
  helper,
  index,
  count,
  preview,
  onBack,
  onPage,
  onStopAgent,
  stopDisabled,
}: {
  sessionId?: string;
  helper: Helper;
  index: number;
  count: number;
  preview: string;
  onBack: () => void;
  onPage: (step: number) => void;
  onStopAgent?: (threadId: string) => void;
  stopDisabled: boolean;
}) {
  const { agent, name, tone, elapsed } = helper;
  const running = isRunning(agent);
  const [seg, setSeg] = useState<Seg>("output");
  const [transcript, setTranscript] = useState<SubAgentTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => back.current?.focus(), []);
  // Esc returns to the list unless a dialog or scrim is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".scrim, dialog[open]")) return;
      onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

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
  const output = isTerminal(agent.status) ? agent.lastMessage || preview : preview;
  async function copy() {
    try {
      await navigator.clipboard.writeText(stripSuggestions(output));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn’t copy the output.");
    }
  }
  function pick(next: Seg) {
    setSeg(next);
    if (next === "transcript" && !transcript) void loadTranscript();
  }
  // Streamed text not yet in the fetched transcript.
  const saved = transcript?.messages.map((m) => m.text).join("\n\n") || "";
  const live =
    running && preview && !saved.endsWith(preview.trim()) ? preview : "";
  const panelId = `ag-panel-${agent.threadId}`;

  return (
    <div className={`ag-detail tone-${tone}`}>
      <div className="ag-nav">
        <button
          ref={back}
          type="button"
          className="btn-ghost ag-back"
          onClick={onBack}
        >
          <Icon name="chevronL" size={14} /> All helpers
        </button>
        {count > 1 && (
          <div className="ag-pager">
            <button
              type="button"
              className="icon-btn ghost"
              aria-label="Previous helper"
              title="Previous helper"
              onClick={() => onPage(-1)}
            >
              <Icon name="chevronL" size={15} />
            </button>
            <span className="ag-pager-label">
              {index + 1} of {count}
            </span>
            <button
              type="button"
              className="icon-btn ghost"
              aria-label="Next helper"
              title="Next helper"
              onClick={() => onPage(1)}
            >
              <Icon name="chevronR" size={15} />
            </button>
          </div>
        )}
      </div>
      <div className="ag-ident">
        <HelperAvatar name={name} tone={tone} size="lg" />
        <div className="grow" style={{ minWidth: 0 }}>
          <span className="ag-ident-name">{name}</span>
          <span className="muted sm">
            {[agent.role && agent.nickname ? agent.role : "", agent.depth > 1 ? `Level ${agent.depth}` : "", taskTitle(agent.task)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </div>
      <dl className="ag-stats">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusChip agent={agent} />
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(elapsed)}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>
            {Number.isFinite(Date.parse(agent.startedAt))
              ? new Date(agent.startedAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "—"}
          </dd>
        </div>
      </dl>
      {(agent.status === "errored" || agent.status === "notFound") && (
        <p className="ag-warn" role="note">
          <span aria-hidden="true">⚠</span>
          {agent.status === "errored"
            ? "This helper failed before finishing."
            : "This helper is no longer available."}
        </p>
      )}
      {error && (
        <p role="alert" className="ag-error">
          {error}
        </p>
      )}
      <div className="ag-seg-tabs" role="tablist" aria-label="Helper details">
        {(["output", "task", "transcript"] as Seg[]).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            className="ag-seg-tab"
            aria-selected={seg === s}
            aria-controls={panelId}
            onClick={() => pick(s)}
          >
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <div className="ag-panel" id={panelId} role="tabpanel">
        {seg === "output" && (
          <>
            {agent.status === "interrupted" && output && (
              <p className="muted sm">Stopped before finishing. Partial output:</p>
            )}
            {output ? (
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>
                  {stripSuggestions(output, running)}
                </Markdown>
              </div>
            ) : (
              <p className="muted">
                {running
                  ? "Working… output appears when this helper finishes."
                  : "No output yet."}
              </p>
            )}
            <div className="goal-actions" style={{ marginTop: 0 }}>
              {agent.stopStatus === "unconfirmed" && (
                <p role="status" className="muted sm">
                  Stop is unconfirmed. Retry stop to check this helper again.
                </p>
              )}
              {!running && output && (
                <button type="button" className="btn-soft" onClick={() => void copy()}>
                  <Icon name={copied ? "check" : "doc"} size={14} />
                  {copied ? "Copied" : "Copy output"}
                </button>
              )}
              {running && (
                <button
                  type="button"
                  className="btn-soft"
                  onClick={() => onStopAgent?.(agent.threadId)}
                  disabled={
                    stopDisabled ||
                    agent.stopStatus === "pending" ||
                    !sessionId ||
                    !onStopAgent
                  }
                  aria-label={`${agent.stopStatus === "unconfirmed" ? "Retry stop for" : "Stop"} ${name}`}
                >
                  <Icon name="stop" size={13} />
                  {agent.stopStatus === "pending"
                    ? "Stopping…"
                    : agent.stopStatus === "unconfirmed"
                      ? "Retry stop"
                      : "Stop"}
                </button>
              )}
            </div>
            <span className="sr-only" role="status">
              {copied ? "Output copied" : ""}
            </span>
          </>
        )}
        {seg === "task" && (
          <>
            <div className="ag-task">{agent.task || "No task was recorded."}</div>
            <p className="muted sm">Sent by the main agent</p>
          </>
        )}
        {seg === "transcript" && (
          <>
            {!sessionId && <p className="muted">Transcript isn’t available.</p>}
            {loading && !transcript && (
              <p className="ag-pending">
                <span className="spinner" aria-hidden="true" /> Loading…
              </p>
            )}
            {transcript?.messages.map((m) => (
              <div key={m.id} className="ag-msg markdown">
                <Markdown remarkPlugins={[remarkGfm]}>
                  {stripSuggestions(m.text)}
                </Markdown>
              </div>
            ))}
            {live && (
              <pre className="ag-live" aria-live="polite">
                {live}
              </pre>
            )}
            {running && (
              <p className="ag-pending">
                <span className="spinner" aria-hidden="true" /> Working…
              </p>
            )}
            {transcript && !transcript.messages.length && !live && !running && (
              <p className="muted">No output yet.</p>
            )}
            {transcript && (
              <button
                type="button"
                className="link"
                onClick={() => void loadTranscript()}
                disabled={loading}
              >
                {loading ? "Refreshing…" : "Refresh transcript"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
