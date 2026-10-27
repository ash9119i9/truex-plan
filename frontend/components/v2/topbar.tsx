"use client";
import type { ReactNode } from "react";
import { Icon } from "./icon";

// Stage topbar (Layout & shell §4): [crumb 1fr][status pill auto][actions 1fr], 56px.
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
}: {
  /** When false the "truex" wordmark shows in the crumb. */
  sidebarShown: boolean;
  /** Crumb title; empty hides the slash too. */
  title?: string | null;
  agentName: string;
  /** e.g. "ready" | "working" | "working on goal" | "reconnecting…" */
  stateText: string;
  /** Animates the pulse; idle when false. */
  busy: boolean;
  onStatusClick?: () => void;
  /** Extra icon buttons rendered before the theme toggle. */
  actions?: ReactNode;
  isDark: boolean;
  onToggleTheme: () => void;
}) {
  return (
    <header className="topbar">
      <div className="crumb">
        {!sidebarShown && <span className="brand-word sm">truex</span>}
        {title && (
          <>
            <span className="muted" aria-hidden="true">
              /
            </span>
            <span className="crumb-title">{title}</span>
          </>
        )}
      </div>
      <button
        type="button"
        className="status-pill"
        onClick={onStatusClick}
        title={`Edit ${agentName}`}
      >
        <span className={busy ? "pulse" : "pulse idle"} aria-hidden="true" />
        {agentName}
        <span className="muted" aria-hidden="true">
          ·
        </span>
        <span className="muted">{stateText}</span>
      </button>
      <div className="top-actions">
        {actions}
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleTheme}
          aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
          title={isDark ? "Light theme" : "Dark theme"}
        >
          <Icon name={isDark ? "sun" : "moon"} size={16} />
        </button>
        {/* Placeholder: no share flow yet. */}
        <button
          type="button"
          className="icon-btn"
          aria-label="Share"
          onClick={() => {}}
        >
          <Icon name="share" size={16} />
        </button>
      </div>
    </header>
  );
}
