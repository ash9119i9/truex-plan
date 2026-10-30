"use client";
import { useId, useRef, useState, type CSSProperties } from "react";
import { agentHandle } from "../../../shared/contracts";
import {
  BOARD_KINDS,
  TILTS,
  filterAgents,
  inkOn,
  pad2,
  showNewCard,
  type BoardKind,
} from "@/lib/agent-board";
import { tintOf } from "@/lib/agent-look";
import { userMessage } from "@/lib/api";
import { archiveTenantAgent, promoteTenantAgent } from "@/lib/tenant-agents";
import { modelLabel } from "@/lib/turn";
import type { TenantAgent } from "@/lib/tenant-agents";
import { Robot } from "@/components/v2/agent-badge";
import { Button } from "@/components/tx/button";
import { Icon } from "@/components/tx/icon";
import { Menu } from "@/components/tx/menu";
import { Segmented } from "@/components/tx/segmented";

// The team board (DESIGN-SPEC 15.2): every agent a member can chat with, as a
// pinned polaroid. Search and filter don't reorder; the list keeps its order.
// The robots, their tints and the frame colours are printed artwork (19.1),
// set inline from the agent's look; signal is spent only on the agent pinned
// to the chat and on New agent.
export function TeamBoard({
  agents,
  selectedId,
  onChat,
  onEdit,
  onNew,
  onClose,
  onChanged,
  initialQuery = "",
  initialKind = "all",
}: {
  agents: TenantAgent[];
  /** The agent pinned to the chat. */
  selectedId: string | null;
  onChat: (agent: TenantAgent) => void;
  onEdit: (agent: TenantAgent) => void;
  onNew: () => void;
  onClose?: () => void;
  /** An agent was shared or archived. */
  onChanged?: (agent: TenantAgent) => void;
  initialQuery?: string;
  initialKind?: BoardKind;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<BoardKind>(initialKind);
  const active = agents.filter((a) => a.status === "active");
  const rows = active.map((agent) => ({
    agent,
    id: agent.id,
    name: agent.name,
    description: agent.description,
    builtin: agent.source === "builtin",
    handle: agentHandle(agent.name),
  }));
  const shown = filterAgents(rows, kind, query);
  const yours = active.filter((a) => a.createdByMe).length;
  return (
    <div className="tb">
      <div className="tb-top">
        <span className="tb-brand mono">truex / agents</span>
        <span className="pt-spacer" />
        {onClose && (
          <Button variant="ghost" size="sm" icon="back" onClick={onClose}>
            Back to chat
          </Button>
        )}
        <Button variant="primary" icon="plus" onClick={onNew}>
          New agent
        </Button>
      </div>
      <header className="tb-hero">
        <h1 className="t-display">
          What the <em>team</em> can help with
        </h1>
        <p className="t-lede">
          {active.length} {active.length === 1 ? "specialist" : "specialists"} ·{" "}
          {yours} built by you. Pin one to the chat, or build your own.
        </p>
      </header>
      <div className="tb-tools">
        <label className="tb-search">
          <Icon name="search" />
          <input
            className="tx-input"
            type="search"
            value={query}
            placeholder="Search by name, handle or purpose"
            aria-label="Search agents"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Segmented
          label="Filter agents"
          options={BOARD_KINDS.map(([value, label]) => ({ value, label }))}
          value={kind}
          onChange={setKind}
        />
      </div>
      <section className="tb-board" aria-label="Agent team">
        {shown.length === 0 ? (
          <div className="tb-empty">
            <p>No agents match “{query.trim()}”</p>
            <Button size="sm" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        ) : (
          <ul className="tb-team">
            {shown.map(({ agent, handle }, index) => (
              <BoardCard
                key={agent.id}
                agent={agent}
                handle={handle}
                tilt={TILTS[index % TILTS.length]}
                live={agent.id === selectedId}
                onChat={() => onChat(agent)}
                onEdit={() => onEdit(agent)}
                onChanged={onChanged}
              />
            ))}
            {showNewCard(kind, query) && (
              <li
                className="tb-new"
                style={
                  {
                    "--tilt": `${TILTS[shown.length % TILTS.length]}deg`,
                  } as CSSProperties
                }
              >
                <button type="button" className="tb-new-frame" onClick={onNew}>
                  <span className="tb-new-photo">
                    <span className="tb-new-plus" aria-hidden="true">
                      <Icon name="plus" size="lg" />
                    </span>
                  </span>
                  <span className="tb-caption">New agent</span>
                </button>
                <span className="tb-note" aria-hidden="true">
                  build your own
                </span>
              </li>
            )}
          </ul>
        )}
      </section>
      <div className="tb-foot">
        <span className="tb-tag mono">
          {BOARD_KINDS.find(([v]) => v === kind)?.[1]}
        </span>
        <span
          className="tb-tag mono num"
          aria-label={`${shown.length} of ${active.length} agents shown`}
        >
          {pad2(shown.length)}/{pad2(active.length)}
        </span>
      </div>
    </div>
  );
}

function BoardCard({
  agent,
  handle,
  tilt,
  live,
  onChat,
  onEdit,
  onChanged,
}: {
  agent: TenantAgent;
  handle: string;
  tilt: number;
  live: boolean;
  onChat: () => void;
  onEdit: () => void;
  onChanged?: (agent: TenantAgent) => void;
}) {
  // Sharing and archiving ask for confirmation inline, in the card.
  const [asking, setAsking] = useState<"share" | "archive" | null>(null);
  const card = useRef<HTMLLIElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    if (!asking || working) return;
    setWorking(true);
    setError("");
    try {
      const changed = await (asking === "share"
        ? promoteTenantAgent(agent.id)
        : archiveTenantAgent(agent.id));
      setAsking(null);
      onChanged?.(changed);
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setWorking(false);
    }
  };
  const actions = [
    ...(agent.canEdit
      ? [{ id: "edit", label: "Edit", icon: "pen" as const }]
      : []),
    ...(agent.canPromote
      ? [{ id: "share", label: "Share with workspace", icon: "share" as const }]
      : []),
    ...(agent.canArchive
      ? [
          {
            id: "archive",
            label: "Archive",
            icon: "ban" as const,
            danger: true,
          },
        ]
      : []),
  ];
  const tint = tintOf(agent.tint);
  const builtin = agent.source === "builtin";
  const meta = [
    agent.model ? modelLabel(agent.model.displayName).toLowerCase() : null,
    agent.skills.length
      ? `${agent.skills.length} ${agent.skills.length === 1 ? "skill" : "skills"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const photo = (
    <>
      {builtin && (
        <span className="tb-lock">
          <Icon name="lock" size="sm" />
          Built-in
        </span>
      )}
      <Robot look={agent.look} size={96} />
    </>
  );
  return (
    <li
      ref={card}
      className={live ? "tb-card is-live" : "tb-card"}
      style={
        {
          "--tilt": `${tilt}deg`,
          "--frame": tint.dot,
          "--tint": tint.bg,
          "--cap": inkOn(tint.dot),
        } as CSSProperties
      }
    >
      <Pin live={live} />
      <div className="tb-frame">
        {agent.canEdit ? (
          <button
            type="button"
            className="tb-photo"
            aria-label={`Edit ${agent.name}`}
            onClick={onEdit}
          >
            {photo}
          </button>
        ) : (
          <span className="tb-photo">{photo}</span>
        )}
        <span className="tb-caption">{agent.name}</span>
      </div>
      <div className="tb-info">
        <span className="tb-handle-row">
          <span className="tb-handle">@{handle}</span>
          {live && (
            <span className="tx-pill tx-pill-live tx-pill-sm">
              <span className="tx-pulse" aria-hidden="true" />
              in chat
            </span>
          )}
          {builtin && <span className="tx-sr"> · built-in</span>}
        </span>
        {agent.source === "tenant" && (
          <span className="tb-badge">
            <Icon name="share" size="sm" />
            Shared with the workspace
          </span>
        )}
        <p className="tb-purpose">{agent.description}</p>
        {agent.connectors.length ? (
          <span className="tb-chips">
            {agent.connectors.map((c) => (
              <span key={c.slug} className="tb-chip">
                {c.displayName}
              </span>
            ))}
          </span>
        ) : (
          <span className="tb-none">No servers connected</span>
        )}
        {asking && (
          <span
            className="tb-ask"
            role="group"
            aria-labelledby={`tb-ask-${agent.id}`}
          >
            <span id={`tb-ask-${agent.id}`}>
              {asking === "share"
                ? "Share with everyone in this workspace? This can’t be undone."
                : "Archive it? It leaves every list; existing chats keep working."}
            </span>
            <span className="tb-ask-btns">
              <Button
                size="sm"
                variant={asking === "share" ? "primary" : "danger"}
                working={working ? "Working…" : undefined}
                onClick={() => void confirm()}
              >
                {asking === "share" ? "Share" : "Archive"}
              </Button>
              {/* Neither can be undone, so Enter on arrival must not do it:
                  focus starts on Cancel, and Cancel hands it back to the
                  menu button that asked. */}
              <Button
                size="sm"
                variant="ghost"
                disabled={working}
                autoFocus
                onClick={() => {
                  setAsking(null);
                  setError("");
                  card.current
                    ?.querySelector<HTMLElement>(".tb-menu [aria-haspopup]")
                    ?.focus();
                }}
              >
                Cancel
              </Button>
            </span>
            {error && (
              <span className="tb-error" role="alert">
                {error}
              </span>
            )}
          </span>
        )}
        <span className="tb-foot-row">
          <span className="tb-meta num">{meta}</span>
          {actions.length > 0 && (
            <Menu
              label={`${agent.name} options`}
              items={actions}
              className="tb-menu"
              panelClassName="tb-menu-panel"
              onSelect={(id) => {
                if (id === "edit") onEdit();
                else setAsking(id as "share" | "archive");
              }}
              trigger={(props) => (
                <Button
                  {...props}
                  iconOnly
                  icon="list"
                  variant="ghost"
                  size="sm"
                  aria-label={`More for ${agent.name}`}
                />
              )}
            />
          )}
          <Button
            size="sm"
            disabled={live || !agent.available}
            onClick={onChat}
          >
            {live ? "Chatting" : agent.available ? "Chat" : "Model unavailable"}
          </Button>
        </span>
      </div>
    </li>
  );
}

// The push-pin at the top of a card (agents.js drawPins): a metal head on
// every card, the signal head only on the agent pinned to the chat. Printed
// artwork; its colours are the board's --pb-* material.
function Pin({ live }: { live: boolean }) {
  const id = "pin" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const tone = live ? "live" : "metal";
  return (
    <svg
      className={live ? "tb-pin is-live" : "tb-pin"}
      width="24"
      height="30"
      viewBox="-12 -12 24 30"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={id} cx=".35" cy=".3" r=".75">
          <stop offset="0" style={{ stopColor: `var(--pb-${tone}-hi)` }} />
          <stop offset=".45" style={{ stopColor: `var(--pb-${tone})` }} />
          <stop offset="1" style={{ stopColor: `var(--pb-${tone}-lo)` }} />
        </radialGradient>
      </defs>
      <ellipse cx="4" cy="15" rx="5" ry="2" className="tb-pin-cast" />
      <path
        d="M1 2l2 12"
        className="tb-pin-stem"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle r="10" fill={`url(#${id})`} />
      <circle r="10" fill="none" className="tb-pin-rim" />
      <ellipse
        cx="-3.5"
        cy="-3.5"
        rx="3.4"
        ry="2.2"
        className="tb-pin-gloss"
        transform="rotate(-35 -3.5 -3.5)"
      />
    </svg>
  );
}
