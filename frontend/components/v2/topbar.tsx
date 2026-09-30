"use client";
import { useEffect, useState } from "react";
import type { ReactNode, Ref } from "react";
import { Icon } from "./icon";
import { ChIcon } from "./chrome-icons";
import {
  crumb as crumbVM,
  pillAriaLabel,
  statusPill,
  type PillInput,
  type PillVM,
} from "@/lib/vm-chrome";

// Stage topbar (convo-v2-wireframe-r2 §3 Board A): crumb, agent status pill, right cluster.
export function Topbar({
  sidebarShown,
  title,
  agentName,
  stateText,
  busy,
  onStatusClick,
  actions,
  isDark,
  onToggleTheme,
  turn,
  toolIssues = 0,
  project,
  archived,
  turnChip,
  onHistory,
  pillOpen = false,
  pillRef,
  popover,
}: {
  /** When false the "truex" wordmark shows in the crumb. */
  sidebarShown: boolean;
  /** Crumb title; empty falls back to "New conversation". */
  title?: string | null;
  agentName: string;
  /** Fallback label when `turn` is not given, e.g. "ready" | "reconnecting…". */
  stateText: string;
  /** Fallback busy flag when `turn` is not given. */
  busy: boolean;
  onStatusClick?: () => void;
  /** Extra icon buttons rendered before the theme toggle. */
  actions?: ReactNode;
  isDark: boolean;
  onToggleTheme: () => void;
  /** Turn state for the pill; startedAt drives the Working timer. */
  turn?: Omit<PillInput, "now" | "toolIssue">;
  /** Count of MCP servers that need sign-in or failed; > 0 shows the amber dot. */
  toolIssues?: number;
  /** Project folder name, muted, before the title. Hidden on phones. */
  project?: string | null;
  archived?: boolean;
  /** e.g. "T4" while a turn is live. */
  turnChip?: string | null;
  onHistory?: () => void;
  /** Accent ring while the agent popover is open. */
  pillOpen?: boolean;
  pillRef?: Ref<HTMLButtonElement>;
  /** Agent popover, rendered under the pill. */
  popover?: ReactNode;
}) {
  const running = turn ? turn.running && !turn.stopping : false;
  const startedAt = turn?.startedAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  // Tick the Working timer only while a timed turn runs.
  useEffect(() => {
    if (!running || startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, startedAt]);

  const pill: PillVM = turn
    ? statusPill({ ...turn, now, toolIssue: toolIssues > 0 })
    : {
        state: busy ? "running" : "idle",
        tone: busy ? "s-run" : "s-idle",
        label: stateText ? stateText[0].toUpperCase() + stateText.slice(1) : "",
        glyph: busy ? "pulse" : "pulse-idle",
        time: null,
        flag: toolIssues > 0,
      };
  const c = crumbVM({ title, projectName: project, archived });

  return (
    <header className="ch-top">
      <div className="ch-crumb">
        {!sidebarShown && <span className="brand-word sm">truex</span>}
        {c.project && (
          <span className="ch-proj">
            <ChIcon name="layers" sm />
            {c.project} <span>/</span>
          </span>
        )}
        <span className="t">{c.title}</span>
        {c.archived && (
          <span className="ch-arch">
            <ChIcon name="history" sm />
            Archived
          </span>
        )}
      </div>
      <div className="ch-anchor">
        <button
          ref={pillRef}
          type="button"
          className={["ch-pill", pill.tone, pillOpen && "open"].filter(Boolean).join(" ")}
          onClick={onStatusClick}
          aria-label={pillAriaLabel(agentName, pill, toolIssues)}
          aria-haspopup="dialog"
          aria-expanded={pillOpen}
        >
          <span className="ch-av">
            <ChIcon name="bot" />
            {pill.flag && <span className="ch-flag" />}
          </span>
          {agentName}
          <span className="ch-sep" />
          <span className="ch-st">
            <PillGlyph glyph={pill.glyph} />
            {pill.glyph === "spinner" ? <span className="ch-shim">{pill.label}</span> : pill.label}
            {pill.time && <span className="ch-time">{pill.time}</span>}
          </span>
          <ChIcon name="chevd" sm />
        </button>
        {popover}
      </div>
      <div className="ch-right">
        {turnChip && (
          <span className="ch-turnchip">
            <i />
            {turnChip}
          </span>
        )}
        {actions}
        {onHistory && (
          <button
            type="button"
            className="ch-ib ch-hide-sm"
            onClick={onHistory}
            aria-label="Session history"
            title="Session history"
          >
            <ChIcon name="history" />
          </button>
        )}
        <button
          type="button"
          className="ch-ib"
          onClick={onToggleTheme}
          aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
          title={isDark ? "Light theme" : "Dark theme"}
        >
          <Icon name={isDark ? "sun" : "moon"} size={16} />
        </button>
        {/* Placeholder: no share flow yet. */}
        <button type="button" className="ch-ib ch-hide-sm" aria-label="Share" onClick={() => {}}>
          <Icon name="share" size={16} />
        </button>
      </div>
    </header>
  );
}

function PillGlyph({ glyph }: { glyph: PillVM["glyph"] }) {
  switch (glyph) {
    case "spinner":
      return <span className="spinner" aria-hidden="true" />;
    case "square":
      return <span className="ch-sq" aria-hidden="true" />;
    case "user":
      return <ChIcon name="user" sm />;
    case "pulse-idle":
      return <span className="pulse idle" aria-hidden="true" />;
    case "pulse-warn":
      return <span className="pulse warn" aria-hidden="true" />;
    default:
      return <span className="pulse" aria-hidden="true" />;
  }
}
