"use client";
import { Spin } from "@/components/tx/live";
import { useId, useRef, useState, type CSSProperties } from "react";
import type { FollowUpItem } from "@/lib/suggestions";

// Up to three "↳ question" rows under the latest completed answer (DESIGN-SPEC
// 11.7). A click sends the row
// through the normal send path; every row disables at once and the picked one
// shows progress until the new reply replaces these rows.
export function FollowUpRows({
  items,
  onSelect,
}: {
  items: readonly FollowUpItem[];
  // Resolves true once the message was accepted (the rows then give way to
  // the new reply). False re-enables them, so a refused send can be retried.
  onSelect: (item: FollowUpItem) => Promise<boolean>;
}) {
  const labelId = useId();
  const [picked, setPicked] = useState<number | null>(null);
  const busy = useRef(false);

  const choose = async (item: FollowUpItem) => {
    if (busy.current) return;
    busy.current = true;
    setPicked(item.slot);
    let sent = false;
    try {
      sent = await onSelect(item);
    } catch {
      sent = false;
    }
    if (!sent) {
      busy.current = false;
      setPicked(null);
    }
  };

  return (
    <section className="cs-next" aria-labelledby={labelId}>
      <h3 className="tx-sr" id={labelId}>
        Follow Up
      </h3>
      <ul className="cs-next-list">
        {items.map((item, index) => {
          const busyHere = picked === item.slot;
          return (
            <li key={item.slot} style={{ "--i": index } as CSSProperties}>
              <button
                type="button"
                className={busyHere ? "cs-next-row is-picked" : "cs-next-row"}
                data-intent={item.intent}
                disabled={picked !== null}
                aria-busy={busyHere || undefined}
                title={item.text}
                onClick={() => void choose(item)}
              >
                {busyHere ? (
                  <Spin />
                ) : (
                  <span className="cs-next-mark" aria-hidden="true">
                    ↳
                  </span>
                )}
                <span className="cs-next-q">{item.text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
