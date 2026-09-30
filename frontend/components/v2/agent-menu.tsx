"use client";
import { Icon } from "./icon";

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
