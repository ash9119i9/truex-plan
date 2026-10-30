"use client";
import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/tx/button";
import { Icon } from "@/components/tx/icon";
import { Menu } from "@/components/tx/menu";
import { useTheme } from "@/lib/use-theme";
import { ariaKeys, useKeyLabel, useShortcuts } from "@/lib/shortcuts";
import type { Role } from "@/lib/session";

// The application frame (DESIGN-SPEC 11.1–11.3): the sidebar's fixed parts and
// the stage's topbar. Data comes in through props; nothing is fetched here.

export type AgentState = "ready" | "working" | "waiting";
const STATE_WORD: Record<AgentState, string> = {
  ready: "Ready",
  working: "Working",
  waiting: "Waiting on you",
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";

// 11.3: the agent for this conversation (absent while it is new), the title,
// then the actions. `start` holds the narrow sidebar toggle. `titleSlot`
// replaces the title (a rename form); `note` sits under the bar (a confirm).
export function Topbar({
  title,
  titleSlot,
  slim = false,
  agent,
  start,
  actions,
  note,
}: {
  title: string;
  titleSlot?: ReactNode;
  slim?: boolean;
  agent?: { name: string; state: AgentState } | null;
  start?: ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <>
      <header className={slim ? "cs-topbar is-slim" : "cs-topbar"}>
        {start}
        {agent && (
          <div className="cs-top-left">
            <span
              className="cs-agent-tag"
              data-state={agent.state}
              title="Agent for this conversation"
            >
              <span className="cs-agent-av" aria-hidden="true">
                {initials(agent.name)}
              </span>
              <span className="cs-agent-name">{agent.name}</span>
              <span className="tx-sr">{STATE_WORD[agent.state]}</span>
            </span>
          </div>
        )}
        {titleSlot ?? (
          <span className="cs-title" title={title}>
            {title}
          </span>
        )}
        <div className="cs-top-actions">
          {actions}
          <ThemeButton />
        </div>
      </header>
      {note && <div className="cs-top-note">{note}</div>}
    </>
  );
}

function ThemeButton() {
  const { isDark, toggle } = useTheme();
  return (
    <Button
      iconOnly
      icon={isDark ? "sun" : "moon"}
      variant="ghost"
      size="sm"
      className="cs-theme"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
    />
  );
}

export type SidebarPlace = "chat" | "agents" | "tools";

// A left click with no modifier; others keep the browser's own (new tab, …).
const plainClick = (event: MouseEvent) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

// 11.2: wordmark, New conversation, the workspace sections, the history (the
// page's children) and the account row.
export function SidebarFrame({
  tenantId,
  user,
  role,
  workspace,
  current,
  onNew,
  onAgents,
  onSignOut,
  children,
}: {
  tenantId: string;
  user: { name: string; email: string };
  role: Role;
  workspace: string;
  current: SidebarPlace;
  onNew: () => void;
  /** Opens the team board in place (the chat page); otherwise a link to it. */
  onAgents?: () => void;
  onSignOut: () => void;
  children?: ReactNode;
}) {
  // The button advertises ⌘J, so whatever renders it binds the chord too.
  useShortcuts({ new: onNew });
  const newKey = useKeyLabel("new");
  return (
    <>
      <Link
        className="cs-brand"
        href={`/t/${tenantId}/chat`}
        aria-label="truex"
        onClick={(event) => {
          // A plain click starts a new conversation in place, like the button.
          if (!plainClick(event)) return;
          event.preventDefault();
          onNew();
        }}
      >
        <span className="pt-brand-word">truex</span>
      </Link>
      <Button
        variant="dark"
        className="cs-new"
        icon="plus"
        kbd={newKey}
        aria-keyshortcuts={ariaKeys("new")}
        onClick={onNew}
      >
        New conversation
      </Button>
      <nav className="cs-side-nav" aria-label="Workspace">
        {onAgents ? (
          <button
            type="button"
            className="tx-btn tx-ghost cs-nav-item"
            aria-current={current === "agents" ? "page" : undefined}
            onClick={onAgents}
          >
            <Icon name="bot" />
            <span>Agents</span>
          </button>
        ) : (
          <Link
            className="tx-btn tx-ghost cs-nav-item"
            href={`/t/${tenantId}/chat?view=agents`}
            aria-current={current === "agents" ? "page" : undefined}
          >
            <Icon name="bot" />
            <span>Agents</span>
          </Link>
        )}
        <Link
          className="tx-btn tx-ghost cs-nav-item"
          href={`/t/${tenantId}/connected-tools`}
          aria-current={current === "tools" ? "page" : undefined}
        >
          <Icon name="plug" />
          <span>Connected tools</span>
        </Link>
        {/* Not built yet: stays in place so the map is honest (11.2). */}
        <button
          className="tx-btn tx-ghost cs-nav-item"
          type="button"
          aria-disabled="true"
          aria-label="Knowledge base, coming soon"
        >
          <Icon name="book" />
          <span>Knowledge base</span>
          <span className="tx-pill tx-pill-line tx-pill-sm cs-soon">Soon</span>
        </button>
      </nav>
      <div className="cs-side-scroll">{children}</div>
      <div className="cs-side-foot">
        <Menu
          label="Account"
          className="cs-account-wrap"
          panelClassName="cs-account-menu"
          items={[{ id: "sign-out", label: "Sign out", icon: "out" }]}
          onSelect={(id) => {
            if (id === "sign-out") onSignOut();
          }}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              className="tx-btn tx-ghost cs-account"
              title={user.email}
            >
              <span className="cs-avatar" aria-hidden="true">
                {initials(user.name)}
              </span>
              <span className="cs-user-text">
                <span className="cs-user-name">{user.name}</span>
                <span className="cs-user-meta">
                  {role === "admin" ? "Admin" : "Member"} · {workspace}
                </span>
              </span>
              <Icon name="chev-updown" className="cs-account-chev" />
            </button>
          )}
        />
      </div>
    </>
  );
}
