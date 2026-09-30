"use client";
import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { api, warnFailure } from "@/lib/api";
import { ChIcon } from "./v2/chrome-icons";
import { connectedTools, type McpServerInput } from "@/lib/vm-chrome";

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

// Connected tools as mini cartridges, for the agent popover
// (convo-v2-wireframe-r2 §3 Board B pin 8). Profiles come from the agent's MCP
// list; `status` layers the latest mcp.status events (by server name) on top.
export function ConnectedCarts({
  agentId,
  refreshKey,
  status,
  onManage,
  onServer,
}: {
  agentId: string;
  refreshKey: number;
  /** Latest mcp.status per server name. */
  status?: Record<string, Pick<McpServerInput, "status" | "failureReason" | "toolCount">>;
  /** Footer "Open tools". */
  onManage: () => void;
  /** Problem cartridges open that server's settings; defaults to onManage. */
  onServer?: (id: string) => void;
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
              profiles.find((p) => p.id === id) || { id, name: id, enabled: false },
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
  const vm = connectedTools(
    (servers || []).map((s) => ({ ...s, ...status?.[s.name] })),
  );
  return (
    <>
      <div className="ch-sechd">
        <ChIcon name="plug" sm />
        Connected tools
        {vm.total > 0 && <span className="ch-count">{vm.count}</span>}
      </div>
      {failed ? (
        <p className="ch-pop-empty">Tools unavailable.</p>
      ) : servers === null ? (
        <p className="ch-pop-empty">Loading tools…</p>
      ) : vm.total === 0 ? (
        <p className="ch-pop-empty">No tools connected.</p>
      ) : (
        <div className="ch-carts">
          {vm.carts.map((c) => {
            const body = (
              <>
                {c.tape && <span className={c.tape === "failed" ? "ch-tape bad" : "ch-tape"}>{c.tape}</span>}
                <div className="ch-lab">
                  <ChIcon name={c.glyph} sm />
                  <b>{c.name}</b>
                  <small>{c.sub}</small>
                </div>
                <div className="ch-pins">
                  <span className="ch-teeth" />
                  <span className={c.led ? `ch-led ${c.led}` : "ch-led"} />
                </div>
              </>
            );
            const cls = ["ch-cart", c.tone, c.state === "failed" && "down"].filter(Boolean).join(" ");
            return c.tape ? (
              <button
                key={c.id}
                type="button"
                className={cls}
                onClick={() => (onServer ? onServer(c.id) : onManage())}
                aria-label={`${c.name}: ${c.sub}. Open server settings`}
              >
                {body}
              </button>
            ) : (
              <div key={c.id} className={cls} aria-label={`${c.name}: ${c.sub}`} role="group">
                {body}
              </div>
            );
          })}
        </div>
      )}
      {vm.footer ? (
        <div className="ch-pop-foot">
          <ChIcon name="alert" sm />
          <span>{vm.footer}</span>
          <span className="spacer" />
          <button className="btn" type="button" onClick={onManage}>
            Open tools
          </button>
        </div>
      ) : (
        <div className="ch-pop-foot ok">
          <span className="spacer" />
          <button className="btn" type="button" onClick={onManage}>
            Open tools
          </button>
        </div>
      )}
    </>
  );
}
