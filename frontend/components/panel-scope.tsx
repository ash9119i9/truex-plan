"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { PanelIcon } from "./panel-icons";
import type { Scope, TurnVM } from "@/lib/vm-panel";

// Wireframe r2 section 4, Board A: the "This turn | Session" control under the
// tabs, the turn rail (This turn only) and "Back to live".
export function ScopeBar({
  scope,
  locked = false,
  onScope,
  turns,
  selectedId,
  onPick,
  backToLive = false,
  onLive,
  ctx,
}: {
  scope: Scope;
  // Goal: Session is locked, with the reason in `ctx`.
  locked?: boolean;
  onScope: (scope: Scope) => void;
  turns: TurnVM[];
  selectedId: string | null;
  onPick: (turnId: string) => void;
  backToLive?: boolean;
  onLive?: () => void;
  ctx?: ReactNode;
}) {
  const rail = useRef<HTMLDivElement>(null);
  // Keep the selected chip visible when the rail scrolls sideways.
  useEffect(() => {
    rail.current
      ?.querySelector<HTMLElement>(".turn.on")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId, scope]);
  const turnScope = scope === "turn" && !locked;
  return (
    <div className="pn-scope">
      <div className="pn-scope-row">
        <span
          className={`seg${locked ? " pn-seg-off" : ""}`}
          role="group"
          aria-label="Scope"
        >
          <button
            type="button"
            className={turnScope ? "on" : undefined}
            aria-pressed={turnScope}
            disabled={locked}
            onClick={() => onScope("turn")}
          >
            {!locked && <PanelIcon name="target" />}
            This turn
          </button>
          <button
            type="button"
            className={!turnScope ? "on" : undefined}
            aria-pressed={!turnScope}
            disabled={locked}
            onClick={() => onScope("session")}
          >
            <PanelIcon name={locked ? "lock" : "sigma"} />
            Session
          </button>
        </span>
        {ctx ? (
          <span className="pn-ctx">{ctx}</span>
        ) : (
          turnScope &&
          backToLive &&
          onLive && (
            <>
              <span className="spacer" />
              <button type="button" className="pn-live" onClick={onLive}>
                Back to live
              </button>
            </>
          )
        )}
      </div>
      {turnScope && turns.length > 0 && (
        <div className="turns" role="group" aria-label="Turns" ref={rail}>
          {turns.map((t) => {
            const on = t.id === selectedId;
            const live = t.status === "live";
            return (
              <button
                key={t.id}
                type="button"
                className={`turn${!live && !on ? " old" : ""}${live ? " live" : ""}${on ? " on" : ""}`}
                aria-pressed={on}
                aria-label={`Turn ${t.index + 1}${live ? ", running" : t.clock ? `, ${t.clock}` : ""}`}
                onClick={() => onPick(t.id)}
              >
                {t.label}
                <i>{live ? "now" : t.clock}</i>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
