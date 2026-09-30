"use client";
import type React from "react";
import { Icon } from "./icon";
import { ChIcon } from "./chrome-icons";

// Agent menu (Core components §5 "Agent menu anatomy").
export type AgentMenuAgent = { id: string; name: string; description?: string; hue?: string };

export type AgentMenuProps = {
  agents: AgentMenuAgent[];
  currentId?: string | null;
  onPick: (id: string) => void;
  /** Shows the hover pencil on each row when given. */
  onEdit?: (id: string) => void;
  onAll?: () => void;
  onNew?: () => void;
};

export function AgentMenu({ agents, currentId, onPick, onEdit, onAll, onNew }: AgentMenuProps) {
  return (
    <div className="menu">
      <div className="eyebrow pad">Choose agent</div>
      {agents.map((a) => {
        const current = a.id === currentId;
        return (
          <div key={a.id} className={current ? "menu-row is-active" : "menu-row"}>
            <button
              type="button"
              className={current ? "menu-item is-active" : "menu-item"}
              aria-current={current ? "true" : undefined}
              onClick={() => onPick(a.id)}
            >
              {/* No hue → CSS default var(--accent-soft-2) */}
              <span className="agent-dot" style={a.hue ? { background: a.hue } : undefined} />
              <span className="grow">
                <span className="strong block">{a.name}</span>
                {a.description && <span className="muted sm">{a.description}</span>}
              </span>
              {current && <Icon name="check" size={15} />}
            </button>
            {onEdit && (
              <button
                type="button"
                className="icon-btn ghost menu-edit"
                aria-label={`Edit ${a.name}`}
                title="Edit"
                onClick={() => onEdit(a.id)}
              >
                <Icon name="pencil" size={14} />
              </button>
            )}
          </div>
        );
      })}
      {(onAll || onNew) && <div className="menu-sep" />}
      {onAll && (
        <button type="button" className="menu-item" onClick={onAll}>
          <span className="menu-plus solid">
            <Icon name="grid" size={12} />
          </span>
          <span className="grow strong">All agents</span>
        </button>
      )}
      {onNew && (
        <button type="button" className="menu-item" onClick={onNew}>
          <span className="menu-plus">
            <Icon name="plus" size={13} stroke={2} />
          </span>
          <span className="grow strong">New agent</span>
        </button>
      )}
    </div>
  );
}

// Agent popover card (convo-v2-wireframe-r2 §3 Board B "Opened"): drops out of the
// topbar status pill. Header with Edit agent, four fact tiles, then connected tools.
// Model settings live here now, not in the composer (§2 pin 7).
export type AgentCardFact = { label: string; value: string; mono?: boolean };

export type AgentCardProps = {
  name: string;
  /** Subtitle under the name. */
  subtitle?: string;
  model?: string | null;
  provider?: string | null;
  sandbox?: string | null;
  cwd?: string | null;
  onEdit?: () => void;
  /** Model tile becomes a button that opens model settings. */
  onModel?: () => void;
  /** Connected tools section (see ConnectedCarts). */
  tools?: React.ReactNode;
};

const SANDBOX_LABEL: Record<string, string> = {
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access",
};

export function sandboxLabel(mode?: string | null) {
  if (!mode) return "Default";
  return SANDBOX_LABEL[mode] ?? mode;
}

export function AgentCard({
  name,
  subtitle = "Agent for this session",
  model,
  provider,
  sandbox,
  cwd,
  onEdit,
  onModel,
  tools,
}: AgentCardProps) {
  const modelTile = (
    <>
      <ChIcon name="spark" />
      <div>
        <small>Model</small>
        <span>{model || "Default"}</span>
      </div>
    </>
  );
  return (
    <>
      <div className="ch-pop-head">
        <span className="ch-av">
          <ChIcon name="bot" />
        </span>
        <div className="ch-who">
          <b>{name}</b>
          <span>{subtitle}</span>
        </div>
        {onEdit && (
          <button className="btn soft" type="button" onClick={onEdit}>
            Edit agent
            <ChIcon name="chev" sm />
          </button>
        )}
      </div>
      <div className="ch-facts">
        {onModel ? (
          <button type="button" className="ch-fact" onClick={onModel} aria-label={`Model: ${model || "Default"}. Change model settings`}>
            {modelTile}
          </button>
        ) : (
          <div className="ch-fact">{modelTile}</div>
        )}
        <div className="ch-fact">
          <ChIcon name="globe" />
          <div>
            <small>Provider</small>
            <span>{provider || "Default"}</span>
          </div>
        </div>
        <div className="ch-fact">
          <ChIcon name="shield" />
          <div>
            <small>Sandbox</small>
            <span>{sandboxLabel(sandbox)}</span>
          </div>
        </div>
        <div className="ch-fact">
          <ChIcon name="term" />
          <div>
            <small>Project folder</small>
            <span className="mono" title={cwd || undefined}>{cwd || "None"}</span>
          </div>
        </div>
      </div>
      {tools}
    </>
  );
}
