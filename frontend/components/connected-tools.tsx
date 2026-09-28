"use client";
import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { api, warnFailure } from "@/lib/api";

type Server = { id: string; name: string; enabled: boolean };
const VISIBLE = 3;

// Compact summary of the MCP servers attached to the selected agent.
// The whole pill opens the MCP panel.
export function ConnectedTools({
  agentId,
  refreshKey,
  onManage,
}: {
  agentId: string;
  refreshKey: number;
  onManage: () => void;
}) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api(`/api/agents/${encodeURIComponent(agentId)}/mcp`)
      .then((data) => {
        if (!active) return;
        const profiles: Server[] = data.profiles || [];
        const ids: string[] = data.profileIds || [];
        setServers(
          ids.map(
            (id) =>
              profiles.find((p) => p.id === id) || {
                id,
                name: id,
                enabled: false,
              },
          ),
        );
        setFailed(false);
      })
      .catch((e) => {
        warnFailure("connected tools", e);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [agentId, refreshKey]);
  const list = servers || [];
  const summary = failed
    ? "Tools unavailable"
    : servers === null
      ? "Loading tools…"
      : list.length === 0
        ? "Connect tools"
        : "";
  const label = list.length
    ? `Connected tools: ${list
        .map((s) => s.name + (s.enabled ? "" : " (unavailable)"))
        .join(", ")}. Manage connected tools`
    : "Manage connected tools";
  return (
    <button
      type="button"
      className="connected-tools"
      onClick={onManage}
      aria-label={label}
      title="Manage connected tools (/mcp)"
    >
      <Plug size={14} aria-hidden="true" />
      {summary ? (
        <span className="connected-tools-empty">{summary}</span>
      ) : (
        <>
          {list.slice(0, VISIBLE).map((server) => (
            <span
              key={server.id}
              className={server.enabled ? "tool-chip" : "tool-chip off"}
              aria-hidden="true"
            >
              <i />
              {server.name}
            </span>
          ))}
          {list.length > VISIBLE && (
            <span className="tool-chip more" aria-hidden="true">
              +{list.length - VISIBLE}
            </span>
          )}
        </>
      )}
    </button>
  );
}
