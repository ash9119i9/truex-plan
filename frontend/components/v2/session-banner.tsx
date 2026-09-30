"use client";
import { ChIcon } from "./chrome-icons";
import type { HealthVM } from "@/lib/vm-chrome";

// Session health (convo-v2-wireframe-r2 §3 Board C): the banner under the topbar
// for orphaned and dead sessions.
export function SessionBanner({
  health,
  onReconnect,
  onNewChat,
  reconnecting = false,
}: {
  health: HealthVM;
  onReconnect?: () => void;
  onNewChat?: () => void;
  reconnecting?: boolean;
}) {
  if (!health || health.kind === "archived") return null;
  if (health.kind === "dead")
    return (
      <div className="ch-ban dead" role="status">
        <span className="ch-ban-ic">
          <ChIcon name="lock" />
        </span>
        <div className="ch-ban-tx">
          <b>{health.title}</b>
          <span>{health.sub}</span>
        </div>
      </div>
    );
  return (
    <div className="ch-ban warn" role="alert">
      <span className="ch-ban-ic">
        <ChIcon name="plug" />
      </span>
      <div className="ch-ban-tx">
        <b>{health.title}</b>
        <span>{health.sub}</span>
      </div>
      <div className="ch-ban-act">
        {onReconnect && (
          <button className="btn primary" type="button" onClick={onReconnect} disabled={reconnecting}>
            <ChIcon name="retry" sm />
            Reconnect
          </button>
        )}
        {onNewChat && (
          <button className="btn ghost" type="button" onClick={onNewChat}>
            New chat
          </button>
        )}
      </div>
    </div>
  );
}

// Replaces the composer when the session can't take input: dead gets a read-only
// bar with Start a new chat, archived gets Unarchive. Orphaned keeps the composer
// (disabled, placeholder from HealthVM), so it returns null here.
export function SessionLockbar({
  health,
  onNewChat,
  onUnarchive,
  busy = false,
}: {
  health: HealthVM;
  onNewChat?: () => void;
  onUnarchive?: () => void;
  busy?: boolean;
}) {
  if (!health || health.kind === "orphaned") return null;
  if (health.kind === "dead")
    return (
      <div className="ch-lockbar">
        <ChIcon name="eye" />
        <span>Read only</span>
        {onNewChat && (
          <button className="btn" type="button" onClick={onNewChat}>
            <ChIcon name="plus" sm />
            Start a new chat
          </button>
        )}
      </div>
    );
  return (
    <div className="ch-lockbar">
      <ChIcon name="history" />
      <span>{health.text}</span>
      {onUnarchive && (
        <button className="btn primary" type="button" onClick={onUnarchive} disabled={busy}>
          Unarchive
        </button>
      )}
    </div>
  );
}
