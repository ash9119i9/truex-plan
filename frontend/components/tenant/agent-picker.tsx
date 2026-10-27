"use client";
import { useState, type CSSProperties } from "react";
import { userMessage } from "@/lib/api";
import { tintOf } from "@/lib/agent-look";
import {
  archiveTenantAgent,
  groupAgents,
  promoteTenantAgent,
  type TenantAgent,
} from "@/lib/tenant-agents";
import { Robot } from "@/components/v2/agent-badge";
import { Icon } from "@/components/v2/icon";
import "@/styles/v2/tenant-agents.css";

// The agents a member can start a chat with, grouped by who provides them.
// Sharing and archiving ask for confirmation inline, in the agent's row.

type Pending = { id: string; action: "share" | "archive" };

const GROUPS = [
  { key: "builtin", title: "Built-in", empty: null },
  {
    key: "personal",
    title: "Your agents",
    empty: "Agents you create for yourself appear here.",
  },
  {
    key: "tenant",
    title: "Shared in this workspace",
    empty: "Agents shared with everyone in this workspace appear here.",
  },
] as const;

export function AgentPicker({
  agents,
  selectedId,
  onSelect,
  onNew,
  onEdit,
  onChanged,
}: {
  agents: TenantAgent[];
  selectedId: string | null;
  onSelect: (agent: TenantAgent) => void;
  onNew: () => void;
  onEdit: (agent: TenantAgent) => void;
  /** An agent was shared or archived. */
  onChanged: (agent: TenantAgent) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const groups = groupAgents(agents);

  const confirm = async ({ id, action }: Pending) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const agent = await (action === "share"
        ? promoteTenantAgent(id)
        : archiveTenantAgent(id));
      setPending(null);
      onChanged(agent);
    } catch (e) {
      setError({ id, message: userMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="tap" aria-labelledby="tap-title">
      <div className="tap-head">
        <h2 id="tap-title" className="eyebrow">
          Choose an agent
        </h2>
        <button type="button" className="btn-soft" onClick={onNew}>
          <Icon name="plus" size={14} stroke={2} />
          New agent
        </button>
      </div>
      {GROUPS.map(({ key, title, empty }) => {
        const list = groups[key];
        if (list.length === 0 && !empty) return null;
        return (
          <div key={key} className="tap-group" role="group" aria-label={title}>
            <h3 className="tap-group-title">{title}</h3>
            {list.length === 0 ? (
              <p className="tap-empty muted sm">{empty}</p>
            ) : (
              <ul className="tap-list">
                {list.map((agent) => {
                  const selected = agent.id === selectedId;
                  const asking = pending?.id === agent.id ? pending : null;
                  const rowError = error?.id === agent.id ? error.message : "";
                  return (
                    <li
                      key={agent.id}
                      className={
                        "tap-row" +
                        (selected ? " is-active" : "") +
                        (agent.available ? "" : " is-unavailable")
                      }
                    >
                      <button
                        type="button"
                        className="tap-pick"
                        aria-pressed={selected}
                        disabled={!agent.available}
                        onClick={() => onSelect(agent)}
                      >
                        <span
                          className="tap-avatar"
                          style={
                            {
                              background: tintOf(agent.tint).bg,
                            } as CSSProperties
                          }
                          aria-hidden="true"
                        >
                          <Robot look={agent.look} size={34} />
                        </span>
                        <span className="tap-text">
                          <span className="strong block">{agent.name}</span>
                          <span className="muted sm tap-desc">
                            {agent.description}
                          </span>
                        </span>
                        <span className="tap-meta">
                          {agent.available ? (
                            agent.model?.shortLabel
                          ) : (
                            <span className="tap-tag">Model unavailable</span>
                          )}
                        </span>
                        {selected && <Icon name="check" size={15} />}
                      </button>
                      {(agent.canEdit ||
                        agent.canPromote ||
                        agent.canArchive) && (
                        <div
                          className="tap-actions"
                          role={asking ? "group" : undefined}
                          aria-labelledby={
                            asking ? `tap-ask-${agent.id}` : undefined
                          }
                        >
                          {asking ? (
                            <>
                              <span className="sm" id={`tap-ask-${agent.id}`}>
                                {asking.action === "share"
                                  ? "Share with everyone in this workspace? This can't be undone."
                                  : "Archive it? It leaves every list; existing chats keep working."}
                              </span>
                              <button
                                type="button"
                                className={
                                  asking.action === "share"
                                    ? "btn-solid"
                                    : "btn-danger"
                                }
                                disabled={busy === agent.id}
                                // Focus follows the question to its answer.
                                autoFocus
                                onClick={() => void confirm(asking)}
                              >
                                {busy === agent.id
                                  ? "Working…"
                                  : asking.action === "share"
                                    ? "Share"
                                    : "Archive"}
                              </button>
                              <button
                                type="button"
                                className="btn-soft"
                                disabled={busy === agent.id}
                                onClick={() => {
                                  setPending(null);
                                  setError(null);
                                }}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              {agent.canEdit && (
                                <button
                                  type="button"
                                  className="text-btn"
                                  onClick={() => onEdit(agent)}
                                  aria-label={`Edit ${agent.name}`}
                                >
                                  Edit
                                </button>
                              )}
                              {agent.canPromote && (
                                <button
                                  type="button"
                                  className="text-btn"
                                  onClick={() =>
                                    setPending({
                                      id: agent.id,
                                      action: "share",
                                    })
                                  }
                                  aria-label={`Share ${agent.name} with the workspace`}
                                >
                                  Share
                                </button>
                              )}
                              {agent.canArchive && (
                                <button
                                  type="button"
                                  className="text-btn"
                                  onClick={() =>
                                    setPending({
                                      id: agent.id,
                                      action: "archive",
                                    })
                                  }
                                  aria-label={`Archive ${agent.name}`}
                                >
                                  Archive
                                </button>
                              )}
                            </>
                          )}
                          {rowError && (
                            <p
                              className="field-hint is-bad tap-error"
                              role="alert"
                            >
                              {rowError}
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
