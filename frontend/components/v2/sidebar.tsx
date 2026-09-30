"use client";
import type { ReactNode } from "react";
import { Icon } from "./icon";

// Left sidebar (Layout & shell §3). Data comes in via props; nothing is fetched here.

export interface SidebarSession {
  _id: string;
  title?: string;
  createdAt: string;
}

const DAY = 86_400_000;

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today" vs "Earlier" by the session's local createdAt date. */
export function convoGroup(createdAt: string, now = new Date()): "Today" | "Earlier" {
  return startOfDay(new Date(createdAt)) === startOfDay(now) ? "Today" : "Earlier";
}

/** h:mm AM/PM today, short weekday within 7 days, else short date ("Sep 3"). */
export function convoTime(createdAt: string, now = new Date()): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (days <= 0) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function Sidebar<S extends SidebarSession>({
  sessions,
  activeId,
  onOpen,
  onNew,
  onSearch,
  agentsActive = false,
  onAgents,
  onSettings,
  renderRowMenu,
  loadError,
  onRetry,
  busy = false,
}: {
  sessions: S[];
  activeId?: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Opens the search palette. */
  onSearch: () => void;
  /** Agents nav link is the active view. */
  agentsActive?: boolean;
  onAgents?: () => void;
  onSettings?: () => void;
  /** Hover/focus-revealed affordance at the row's right (e.g. SessionMenu). */
  renderRowMenu?: (session: S) => ReactNode;
  /** Shows an inline error line with Retry. */
  loadError?: string | null;
  onRetry?: () => void;
  /** Disables row, new and nav buttons while a turn is running. */
  busy?: boolean;
}) {
  const now = new Date();
  const groups: { label: "Today" | "Earlier"; items: S[] }[] = [
    { label: "Today", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const s of sessions)
    groups[convoGroup(s.createdAt, now) === "Today" ? 0 : 1].items.push(s);

  return (
    <>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="spark" size={14} stroke={2} />
        </span>
        <span className="brand-word">truex</span>
        <span className="brand-slash" aria-hidden="true">/</span>
        <span className="brand-sub">agents</span>
      </div>

      <button type="button" className="search-trigger" onClick={onSearch}>
        <Icon name="search" size={15} />
        <span className="search-label">Search</span>
        <kbd>⌘K</kbd>
      </button>

      <button type="button" className="btn-new" onClick={onNew} disabled={busy}>
        <Icon name="plus" size={16} stroke={2} />
        New conversation
        <kbd>⌘J</kbd>
      </button>

      <nav className="side-nav" aria-label="Main">
        <button
          type="button"
          className={agentsActive ? "side-link is-active" : "side-link"}
          aria-current={agentsActive ? "page" : undefined}
          onClick={onAgents}
        >
          <Icon name="bot" size={16} />
          Agents
        </button>
      </nav>

      <div className="side-scroll">
        {loadError && (
          <p className="side-error" role="alert">
            {loadError} ·{" "}
            <button type="button" className="side-retry" onClick={onRetry}>
              Retry
            </button>
          </p>
        )}
        {groups.map(
          (g) =>
            g.items.length > 0 && (
              <div className="side-group" key={g.label}>
                <div className="eyebrow">{g.label}</div>
                {g.items.map((s) => {
                  const menu = renderRowMenu?.(s);
                  const active = s._id === activeId;
                  return (
                    <div
                      key={s._id}
                      className={[
                        "convo-row",
                        active && "is-active",
                        menu && "has-menu",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <button
                        type="button"
                        className={active ? "convo is-active" : "convo"}
                        aria-current={active ? "true" : undefined}
                        disabled={busy}
                        onClick={() => onOpen(s._id)}
                      >
                        <span className="convo-title">
                          {s.title || "New conversation"}
                        </span>
                        <span className="convo-time">
                          {convoTime(s.createdAt, now)}
                        </span>
                      </button>
                      {menu && <span className="convo-menu">{menu}</span>}
                    </div>
                  );
                })}
              </div>
            ),
        )}
      </div>

      <button type="button" className="side-link side-foot" onClick={onSettings}>
        <Icon name="gear" size={16} />
        Settings
      </button>
    </>
  );
}
