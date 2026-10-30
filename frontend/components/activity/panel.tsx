"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { statePill, type Step, type TurnView } from "@/lib/activity";
import { mask } from "@/lib/mask";
import { duration, compactCount, modelLabel, traceTimings } from "@/lib/turn";
import { helperLabel, type HelperStatus } from "@/lib/tenant-chat";
import { ariaKeys } from "@/lib/shortcuts";
import { Button } from "@/components/tx/button";
import { RefChip } from "@/components/tx/chip";
import { Spin } from "@/components/tx/live";
import { Icon, type IconName } from "@/components/tx/icon";
import { Segmented } from "@/components/tx/segmented";
import { Tabs, tabId } from "@/components/tx/tabs";
import { initials } from "@/components/auth/workspace-frame";
import { DocumentCard } from "@/components/tenant/document-card";
import type { ChatFile } from "@/lib/tenant-files";

// The Activity Panel (DESIGN-SPEC 14): it reports what happened in a turn and
// never decides anything. Its most active control is "Show in chat"; approve,
// decline, retry, stop and steer live only in the chat.

export type PanelTab = "activity" | "agent" | "files" | "insights";

export type PanelAgent = {
  name: string;
  source: "builtin" | "personal" | "tenant";
  model: string | null;
};

export function ActivityPanel({
  turns,
  index,
  agent,
  onIndex,
  onClose,
  onShowInChat,
  onOpenFile,
  onDownloadFile,
  file = null,
  onCloseFile,
  wide = false,
  onToggleWide,
  closing = false,
}: {
  turns: TurnView[];
  index: number;
  agent: PanelAgent | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Scrolls the chat to this turn (or its waiting request) and focuses it. */
  onShowInChat: (turn: TurnView) => void;
  onOpenFile?: (file: ChatFile) => void;
  onDownloadFile?: (file: ChatFile) => void;
  /** An open file, shown in place of the Files tab's list. */
  file?: ReactNode;
  onCloseFile?: () => void;
  /** Shown at the wide size (560 instead of 360). */
  wide?: boolean;
  /** Absent when the window has no room for the wide size. */
  onToggleWide?: () => void;
  /** Sliding out: still mounted for its exit, but inert. */
  closing?: boolean;
}) {
  const idBase = useId();
  const panelId = `${idBase}-panel`;
  const [picked, setPicked] = useState<PanelTab>("activity");
  // An open file belongs to the Files tab.
  const tab: PanelTab = file ? "files" : picked;
  const setTab = (next: PanelTab) => {
    if (file && next !== "files") onCloseFile?.();
    setPicked(next);
  };
  const body = useRef<HTMLDivElement>(null);
  const hasFile = !!file;
  const turn = turns[index] ?? null;
  // Closing the file goes back to the Files list.
  useEffect(() => {
    if (hasFile) setPicked("files");
  }, [hasFile]);
  // The scroll resets when the tab or the turn changes.
  useEffect(() => {
    body.current?.scrollTo?.({ top: 0 });
  }, [tab, index, hasFile]);
  const helpers = turn?.helpers.length ?? 0;
  const made = turn?.made.length ?? 0;
  const items = [
    { id: "activity", label: "Activity" },
    helpers
      ? { id: "agent", label: "Sub-agents", count: helpers }
      : { id: "agent", label: "Agent" },
    made
      ? { id: "files", label: "Files", count: made }
      : { id: "files", label: "Files" },
    { id: "insights", label: "Insights" },
  ];
  return (
    <aside
      className={["ap", wide && "is-wide", closing && "is-closing"]
        .filter(Boolean)
        .join(" ")}
      aria-label="Activity panel"
      inert={closing}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className="ap-head">
        <nav className="ap-scope" aria-label="Scope">
          <span>Session</span>
          <Icon name="chev" size="sm" />
          <span aria-current="page">
            Turn <span className="num">{turns.length ? index + 1 : 0}</span> of{" "}
            <span className="num">{turns.length}</span>
          </span>
        </nav>
        <span className="pt-spacer" />
        <Button
          iconOnly
          icon="chev-l"
          variant="ghost"
          size="xs"
          aria-label="Previous turn"
          disabled={index <= 0}
          onClick={() => onIndex(index - 1)}
        />
        <Button
          iconOnly
          icon="chev"
          variant="ghost"
          size="xs"
          aria-label="Next turn"
          disabled={index >= turns.length - 1}
          onClick={() => onIndex(index + 1)}
        />
        {onToggleWide && (
          <Button
            iconOnly
            icon={wide ? "shrink" : "expand"}
            variant="ghost"
            size="xs"
            aria-label={wide ? "Shrink panel" : "Expand panel"}
            aria-pressed={wide}
            onClick={onToggleWide}
          />
        )}
        <Button
          iconOnly
          icon="x"
          variant="ghost"
          size="xs"
          aria-label="Close Activity panel"
          aria-keyshortcuts={ariaKeys("activity")}
          onClick={onClose}
        />
      </header>
      <Tabs
        label="Activity panel sections"
        idBase={idBase}
        panelId={panelId}
        items={items}
        selected={tab}
        onSelect={(id) => setTab(id as PanelTab)}
      />
      <div
        ref={body}
        className={file ? "ap-body has-file" : "ap-body"}
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(idBase, tab)}
        tabIndex={0}
      >
        {!turn ? (
          <p className="ap-empty">
            Nothing to report yet. Send a message to start a turn.
          </p>
        ) : tab === "activity" ? (
          <ActivityTab
            turn={turn}
            agentName={agent?.name ?? "Agent"}
            onShowInChat={onShowInChat}
          />
        ) : tab === "agent" ? (
          <AgentTab turn={turn} agent={agent} />
        ) : file ? (
          file
        ) : tab === "files" ? (
          <FilesTab
            turn={turn}
            onOpen={onOpenFile}
            onDownload={onDownloadFile}
          />
        ) : (
          <InsightsTab
            turn={turn}
            model={agent?.model ?? null}
            onShowInChat={onShowInChat}
          />
        )}
      </div>
      <footer className="ap-foot">
        <span className="ap-k">Trace</span>
        {turn && <RefChip value={turn.runId} label="trace ID" copyIcon />}
        <span className="pt-spacer" />
        {turn && (
          <Button
            size="xs"
            variant="ghost"
            icon="download"
            onClick={() => exportLog(turn)}
          >
            Export log
          </Button>
        )}
      </footer>
    </aside>
  );
}

// Downloads what the panel shows for the turn, masked, as JSON.
function exportLog(turn: TurnView) {
  const log = {
    trace: turn.runId,
    state: turn.state,
    asked: turn.ask && { at: turn.ask.at, text: mask(turn.ask.text) },
    steps: turn.steps.map(({ title, system, status, durationMs }) => ({
      title,
      system,
      status,
      durationMs,
    })),
    helpers: turn.helpers.map((h) => ({
      name: helperLabel(h.path),
      status: h.status,
    })),
    made: turn.made.map((f) => ({ path: mask(f.path), size: f.size })),
    edited: turn.edited,
    timings: turn.run?.timings ?? null,
    usage: turn.run?.usage ?? null,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `turn-${turn.runId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

const clock = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const totalOf = (turn: TurnView) =>
  turn.run
    ? traceTimings(turn.run).find(([label]) => label === "Total")?.[1]
    : undefined;

function StatePill({ turn }: { turn: TurnView }) {
  const failed = turn.steps.filter((s) => s.status === "fail").length;
  const pill = statePill(turn.state, failed);
  return (
    <span className={`tx-pill ${pill.tone}`}>
      {pill.glyph ? <Icon name={pill.glyph} size="sm" /> : <Spin />}
      {pill.word}
    </span>
  );
}

// ── Tab 1 · Activity (14.5) ─────────────────────────────────────────────────
const STEP_NODE: Record<Step["status"], IconName | null> = {
  done: "check",
  run: null,
  wait: "hand",
  fail: "x",
  decl: "ban",
  stop: "stop",
};
const STEP_NOTE: Record<Step["status"], string> = {
  done: "Done",
  run: "In progress",
  wait: "Waiting for you in chat",
  fail: "Didn’t work",
  decl: "You declined",
  stop: "You pressed Stop",
};

export function ActivityTab({
  turn,
  agentName,
  onShowInChat,
}: {
  turn: TurnView;
  agentName: string;
  onShowInChat: (turn: TurnView) => void;
}) {
  const [technical, setTechnical] = useState<"plain" | "technical">("plain");
  const total = totalOf(turn);
  const live = turn.state === "live" || turn.state === "needs";
  const done = turn.steps.filter((s) => s.status === "done").length;
  return (
    <>
      {turn.ask && (
        <section className="ap-sec ap-ask" aria-label="The ask">
          <p className="ap-micro">
            <span>You asked · {clock(turn.ask.at)}</span>
            <span>{agentName}</span>
          </p>
          <blockquote className="ap-q">“{turn.ask.text}”</blockquote>
          <p className="ap-facts">
            <StatePill turn={turn} />
            <span className="num">
              {turn.steps.length} {turn.steps.length === 1 ? "step" : "steps"}
            </span>
            {turn.steers.length > 0 && (
              <span>
                {turn.steers.length}{" "}
                {turn.steers.length === 1 ? "note" : "notes"} from you
              </span>
            )}
            {total && (
              <span className="num">{live ? `${total} so far` : total}</span>
            )}
          </p>
        </section>
      )}
      {(turn.state === "needs" ||
        turn.state === "issue" ||
        turn.state === "stopped") && (
        <section
          className={`ap-notice is-${turn.state === "needs" ? "warn" : turn.state === "issue" ? "bad" : "line"}`}
          role="status"
        >
          <p className="ap-notice-title">
            <Icon
              name={
                turn.state === "needs"
                  ? "hand"
                  : turn.state === "issue"
                    ? "alert"
                    : "stop"
              }
              size="sm"
            />
            {turn.state === "needs"
              ? "Waiting for your approval in the chat"
              : turn.state === "issue"
                ? turn.run?.status === "failed"
                  ? "This turn didn’t finish"
                  : "A step didn’t work"
                : "You stopped this turn"}
          </p>
          <p className="ap-notice-copy">
            {turn.state === "needs"
              ? "Nothing runs until you answer there."
              : turn.state === "issue"
                ? mask(
                    turn.run?.error?.message ??
                      "One step failed; the rest finished.",
                  )
                : "Steps after that point didn’t run."}
          </p>
          <div className="ap-notice-foot">
            <Button size="sm" onClick={() => onShowInChat(turn)}>
              Show in chat
            </Button>
          </div>
          {turn.state === "needs" && (
            <p className="ap-hint">
              Answer, add a note, or stop the turn from the chat.
            </p>
          )}
        </section>
      )}
      {(turn.made.length > 0 || turn.edited.length > 0) && (
        <section className="ap-sec" aria-labelledby={`${turn.runId}-changed`}>
          <h3 className="ap-h" id={`${turn.runId}-changed`}>
            <Icon name="pen" size="sm" />
            Changed
          </h3>
          <ul className="ap-list">
            {turn.made.map((f) => (
              <li key={f.id}>
                {mask(f.path)} <span className="ap-tag">new</span>
              </li>
            ))}
            {turn.edited.map((path) => (
              <li key={path}>
                {path} <span className="ap-tag">edited</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="ap-sec" aria-labelledby={`${turn.runId}-steps`}>
        <div className="ap-sec-head">
          <h3 className="ap-h" id={`${turn.runId}-steps`}>
            Steps{" "}
            <span className="num">
              {done}/{turn.steps.length}
            </span>
          </h3>
          <Segmented
            label="Detail level"
            size="sm"
            options={[
              { value: "plain", label: "Plain" },
              { value: "technical", label: "Technical" },
            ]}
            value={technical}
            onChange={setTechnical}
          />
        </div>
        {turn.steps.length === 0 ? (
          <p className="ap-empty">
            {live
              ? "No steps yet."
              : "This turn answered without using any tools."}
          </p>
        ) : (
          <ol className="ap-steps">
            {turn.steps.map((step) => (
              <StepItem
                key={step.id}
                step={step}
                technical={technical === "technical"}
              />
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function StepItem({ step, technical }: { step: Step; technical: boolean }) {
  const glyph = STEP_NODE[step.status];
  return (
    <li className={`ap-step is-${step.status}`}>
      <details>
        <summary>
          <span className="ap-node" aria-hidden="true">
            {glyph ? <Icon name={glyph} size="sm" /> : <Spin />}
          </span>
          <span className="ap-step-main">
            <span className="ap-step-title">{step.title}</span>
            <span className="ap-step-sub">
              {step.system} · {STEP_NOTE[step.status]}
            </span>
          </span>
          <span className="ap-step-time num">{duration(step.durationMs)}</span>
        </summary>
        <dl className="ap-dl">
          <dt>Did</dt>
          <dd>{step.title}</dd>
          <dt>System</dt>
          <dd>{step.system}</dd>
          {step.touched.length > 0 && (
            <>
              <dt>Touched</dt>
              <dd>{step.touched.join(", ")}</dd>
            </>
          )}
          {step.durationMs != null && (
            <>
              <dt>Took</dt>
              <dd className="num">{duration(step.durationMs)}</dd>
            </>
          )}
          <dt>Result</dt>
          <dd className={`ap-result is-${step.status}`}>
            {STEP_NOTE[step.status]}
          </dd>
        </dl>
        {technical && (
          <dl className="ap-dl is-technical">
            <dt>Tool</dt>
            <dd className="mono">{mask(step.tool)}</dd>
            <dt>Step</dt>
            <dd className="mono">{step.id}</dd>
          </dl>
        )}
      </details>
    </li>
  );
}

// ── Tab 2 · Agent / Sub-agents (14.6) ───────────────────────────────────────
const SOURCE: Record<PanelAgent["source"], string> = {
  builtin: "Built-in",
  personal: "Yours",
  tenant: "Shared",
};
const HELPER_WORD: Record<HelperStatus, { tone: string; word: string }> = {
  running: { tone: "live", word: "Working" },
  completed: { tone: "ok", word: "Done" },
  failed: { tone: "bad", word: "Failed" },
  stopped: { tone: "line", word: "Stopped" },
};

export function AgentTab({
  turn,
  agent,
}: {
  turn: TurnView;
  agent: PanelAgent | null;
}) {
  return (
    <>
      {agent && (
        <section className="ap-sec ap-agent" aria-label="Agent">
          <span className="ap-av" aria-hidden="true">
            {initials(agent.name)}
          </span>
          <span className="ap-agent-text">
            <span className="ap-agent-name">
              {agent.name}{" "}
              <span className="tx-pill tx-pill-line tx-pill-sm">
                {SOURCE[agent.source]}
              </span>
            </span>
            {agent.model && (
              <span className="ap-agent-model mono">
                {modelLabel(agent.model)}
              </span>
            )}
          </span>
        </section>
      )}
      {turn.helpers.length > 0 ? (
        <section className="ap-sec" aria-labelledby={`${turn.runId}-crew`}>
          <h3 className="ap-h" id={`${turn.runId}-crew`}>
            Crew <span className="num">{turn.helpers.length + 1}</span>
          </h3>
          <ul className="ap-crew">
            {agent && (
              <li
                className="ap-crew-card"
                style={{ "--crew": "var(--id-main)" } as CSSProperties}
              >
                <span className="ap-micro">Lead</span>
                <span className="ap-crew-name">{agent.name}</span>
              </li>
            )}
            {turn.helpers.map((helper, i) => {
              const status = HELPER_WORD[helper.status];
              const name = helperLabel(helper.path);
              return (
                <li
                  key={`${helper.path}:${i}`}
                  className="ap-crew-card"
                  style={
                    {
                      "--crew": `var(${i < 5 ? `--id-${i + 1}` : "--id-main"})`,
                    } as CSSProperties
                  }
                >
                  <span className="ap-micro">Helper</span>
                  <span className="ap-crew-name">
                    {name.charAt(0).toUpperCase() + name.slice(1)}
                  </span>
                  <span className={`ap-crew-status is-${status.tone}`}>
                    <span className="ap-dot" aria-hidden="true" />
                    {status.word}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="ap-empty">No helpers were spawned in this turn.</p>
      )}
    </>
  );
}

// ── Tab 3 · Files (14.7) ────────────────────────────────────────────────────
export function FilesTab({
  turn,
  onOpen,
  onDownload,
}: {
  turn: TurnView;
  onOpen?: (file: ChatFile) => void;
  onDownload?: (file: ChatFile) => void;
}) {
  return (
    <>
      <div className="ap-tiles">
        <span className="ap-tile">
          <small>Made</small>
          <b className="num">{turn.made.length}</b>
        </span>
        <span className="ap-tile">
          <small>Edited</small>
          <b className="num">{turn.edited.length}</b>
        </span>
      </div>
      <section className="ap-sec" aria-labelledby={`${turn.runId}-made`}>
        <h3 className="ap-h" id={`${turn.runId}-made`}>
          Made by this turn
        </h3>
        {turn.made.length === 0 ? (
          <p className="ap-empty">This turn made no files.</p>
        ) : (
          <div className="dc-stack">
            {turn.made.map((file) => (
              <DocumentCard
                key={file.id}
                name={file.name}
                size={file.size}
                version={file.version}
                state="ready"
                onOpen={onOpen && (() => onOpen(file))}
                onDownload={onDownload && (() => onDownload(file))}
              />
            ))}
          </div>
        )}
      </section>
      <section className="ap-sec" aria-labelledby={`${turn.runId}-edited`}>
        <h3 className="ap-h" id={`${turn.runId}-edited`}>
          Edited
        </h3>
        {turn.edited.length === 0 ? (
          <p className="ap-empty">No existing file was edited.</p>
        ) : (
          <ul className="ap-list">
            {turn.edited.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ── Tab 4 · Insights (14.8) ─────────────────────────────────────────────────
export function InsightsTab({
  turn,
  model,
  onShowInChat,
}: {
  turn: TurnView;
  model: string | null;
  onShowInChat: (turn: TurnView) => void;
}) {
  const run = turn.run;
  const timings = run ? traceTimings(run) : [];
  const total = timings.find(([label]) => label === "Total")?.[1];
  const usage = run?.usage ?? null;
  if (!run || (!total && !usage))
    return (
      <div className="tx-card tx-state">
        <p>
          {turn.state === "live" || turn.state === "needs"
            ? "Insights appear when this turn finishes."
            : "Nothing was recorded for this turn."}
        </p>
        <Button size="sm" onClick={() => onShowInChat(turn)}>
          Show in chat
        </Button>
      </div>
    );
  const t = run.timings;
  const span = (from?: string, to?: string) => {
    const a = from ? Date.parse(from) : NaN;
    const b = to ? Date.parse(to) : NaN;
    return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : 0;
  };
  const parts = [
    {
      key: "start",
      label: "Starting",
      ms: span(t.acceptedAt, t.dispatchedAt),
      swatch: "var(--cx-data-mute)",
    },
    {
      key: "think",
      label: "Before the first words",
      ms: span(t.dispatchedAt ?? t.acceptedAt, t.firstTextAt),
      swatch: "var(--cx-data)",
    },
    {
      key: "write",
      label: "Writing the answer",
      ms: span(t.firstTextAt, t.completedAt),
      swatch: "var(--cx-data-hi)",
    },
  ].filter((p) => p.ms > 0);
  const sum = parts.reduce((n, p) => n + p.ms, 0);
  return (
    <>
      <div className="ap-tiles">
        {total && (
          <span className="ap-tile">
            <small>Time</small>
            <b className="num">{total}</b>
          </span>
        )}
        {usage && (
          <span className="ap-tile">
            <small>Tokens</small>
            <b className="num">{compactCount(usage.input + usage.output)}</b>
          </span>
        )}
      </div>
      {parts.length > 0 && (
        <section className="ap-sec" aria-labelledby={`${turn.runId}-time`}>
          <h3 className="ap-h" id={`${turn.runId}-time`}>
            Where the time went
          </h3>
          <div
            className="ap-bar"
            role="img"
            aria-label={parts
              .map((p) => `${p.label} ${duration(p.ms)}`)
              .join(", ")}
          >
            {parts.map((p) => (
              <span
                key={p.key}
                style={{ flexGrow: p.ms, background: p.swatch }}
              />
            ))}
          </div>
          <ul className="ap-legend">
            {parts.map((p) => (
              <li key={p.key}>
                <span
                  className="ap-swatch"
                  style={{ background: p.swatch }}
                  aria-hidden="true"
                />
                <span>{p.label}</span>
                <span className="num">{duration(p.ms)}</span>
                <span className="num">{Math.round((p.ms / sum) * 100)}%</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {usage && (
        <section className="ap-sec" aria-labelledby={`${turn.runId}-tokens`}>
          <h3 className="ap-h" id={`${turn.runId}-tokens`}>
            Tokens
          </h3>
          <dl className="ap-dl">
            <dt>Input</dt>
            <dd className="num">{usage.input.toLocaleString("en-US")}</dd>
            <dt>From cache</dt>
            <dd className="num">{usage.cached.toLocaleString("en-US")}</dd>
            <dt>Output</dt>
            <dd className="num">{usage.output.toLocaleString("en-US")}</dd>
            <dt>Reasoning</dt>
            <dd className="num">{usage.reasoning.toLocaleString("en-US")}</dd>
            {model && (
              <>
                <dt>Model</dt>
                <dd>{modelLabel(model)}</dd>
              </>
            )}
          </dl>
        </section>
      )}
    </>
  );
}
