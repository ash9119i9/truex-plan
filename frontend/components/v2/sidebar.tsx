"use client";
import {
  useEffect,
  memo,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icon";
import {
  convoTime,
  loadEarlierExpanded,
  saveEarlierExpanded,
  groupSidebarSessions,
  sidebarWindow,
  SIDEBAR_INITIAL_COUNT,
  SIDEBAR_PAGE_COUNT,
  type SidebarSession,
} from "@/lib/sidebar";

import { useSidebarDay } from "@/lib/use-sidebar-clock";

export { convoGroup, convoTime } from "@/lib/sidebar";
export type { SidebarSession } from "@/lib/sidebar";

// Left sidebar (Layout & shell §3). Data comes in via props; nothing is fetched here.

function SidebarView<S extends SidebarSession>({
  sessions,
  activeId,
  onOpen,
  onNew,
  onSearch,
  agentsActive = false,
  onAgents,
  automationsActive = false,
  onAutomations,
  automationAttention = false,
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
  automationsActive?: boolean;
  onAutomations?: () => void;
  automationAttention?: boolean;
  onSettings?: () => void;
  /** Hover/focus-revealed affordance at the row's right (e.g. SessionMenu). */
  renderRowMenu?: (session: S) => ReactNode;
  /** Shows an inline error line with Retry. */
  loadError?: string | null;
  onRetry?: () => void;
  /** Disables conversation selection and creation while a request is being sent. */
  busy?: boolean;
}) {
  const dayKey = useSidebarDay();
  const now = new Date(dayKey);
  const groups = useMemo(
    () => groupSidebarSessions(sessions, new Date(dayKey)),
    [sessions, dayKey],
  );
  const [earlierCount, setEarlierCount] = useState(SIDEBAR_INITIAL_COUNT);
  const [earlierExpanded, setEarlierExpanded] = useState(true);
  // Read after mount so server rendering and hydration keep the same default.
  useEffect(() => setEarlierExpanded(loadEarlierExpanded()), []);
  const earlierId = useId();
  const earlier = useMemo(
    () =>
      sidebarWindow(groups.earlier, {
        count: earlierCount,
        activeId,
        expanded: earlierExpanded,
      }),
    [groups.earlier, earlierCount, activeId, earlierExpanded],
  );
  const rows = (items: S[]) =>
    items.map((session) => (
      <SidebarRow
        key={session._id}
        session={session}
        active={session._id === activeId}
        busy={busy}
        time={convoTime(session.createdAt, now)}
        onOpen={onOpen}
        renderRowMenu={renderRowMenu}
      />
    ));

  return (
    <>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="spark" size={14} stroke={2} />
        </span>
        <span className="brand-word">truex</span>
        <span className="brand-slash" aria-hidden="true">
          /
        </span>
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
        {onAutomations && (
          <button
            type="button"
            className={automationsActive ? "side-link is-active" : "side-link"}
            aria-current={automationsActive ? "page" : undefined}
            onClick={onAutomations}
          >
            <Icon name="play" size={16} />
            Automations
            {automationAttention && (
              <span className="automation-attention">Needs attention</span>
            )}
          </button>
        )}
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
        {groups.today.length > 0 && (
          <section className="side-group" aria-label="Today">
            <div className="eyebrow">Today</div>
            {rows(groups.today)}
          </section>
        )}
        {groups.earlier.length > 0 && (
          <section className="side-group" aria-label="Earlier">
            <button
              type="button"
              className="side-shelf-toggle eyebrow"
              aria-expanded={earlierExpanded}
              aria-controls={earlierId}
              onClick={() => {
                const next = !earlierExpanded;
                setEarlierExpanded(next);
                saveEarlierExpanded(next);
              }}
            >
              <Icon name={earlierExpanded ? "chevron" : "chevronR"} size={12} />
              Earlier
              <span className="side-shelf-count">{groups.earlier.length}</span>
            </button>
            <div id={earlierId}>
              {rows(earlier.items)}
              {earlierExpanded && earlier.hiddenCount > 0 && (
                <button
                  type="button"
                  className="side-show-more"
                  onClick={() =>
                    setEarlierCount((count) => count + SIDEBAR_PAGE_COUNT)
                  }
                >
                  Show more
                  <span className="side-shelf-count">
                    {earlier.hiddenCount} remaining
                  </span>
                </button>
              )}
            </div>
          </section>
        )}
      </div>

      <button
        type="button"
        className="side-link side-foot"
        onClick={onSettings}
      >
        <Icon name="gear" size={16} />
        Settings
      </button>
    </>
  );
}

export const Sidebar = memo(SidebarView) as typeof SidebarView;

function SidebarRowView<S extends SidebarSession>({
  session,
  active,
  busy,
  time,
  onOpen,
  renderRowMenu,
}: {
  session: S;
  active: boolean;
  busy: boolean;
  time: string;
  onOpen: (id: string) => void;
  renderRowMenu?: (session: S) => ReactNode;
}) {
  const menu = renderRowMenu?.(session);
  return (
    <div
      className={["convo-row", active && "is-active", menu && "has-menu"]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className={active ? "convo is-active" : "convo"}
        aria-current={active ? "true" : undefined}
        disabled={busy}
        onClick={() => onOpen(session._id)}
      >
        <span className="convo-title">
          {session.title || "New conversation"}
        </span>
        <span className="convo-time">{time}</span>
      </button>
      {menu && <span className="convo-menu">{menu}</span>}
    </div>
  );
}

const SidebarRow = memo(SidebarRowView) as typeof SidebarRowView;
