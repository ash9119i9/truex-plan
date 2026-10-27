"use client";
import { useId, useRef, useState } from "react";
import type { FollowUpItem } from "@/lib/suggestions";

const ACT = (
  <>
    <path d="M7 17 17 7" />
    <path d="M8 7h9v9" />
  </>
);
const REPLY = (
  <>
    <path d="M5 4v7a4 4 0 0 0 4 4h11" />
    <path d="m15 10 5 5-5 5" />
  </>
);

function Glyph({ kind }: { kind: "act" | "reply" | "go" | "spin" }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "act" ? ACT : kind === "reply" ? REPLY : null}
      {kind === "go" ? (
        <>
          <path d="M5 12h14" />
          <path d="m13 6 6 6-6 6" />
        </>
      ) : null}
      {kind === "spin" ? <path d="M21 12a9 9 0 1 1-6.2-8.6" /> : null}
    </svg>
  );
}

// Up to three rows under the latest completed answer. A click sends the row
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
    <section className="tchat-followup" aria-labelledby={labelId}>
      <h3 className="tchat-followup-label" id={labelId}>
        Follow Up
      </h3>
      <ul className="tchat-followup-list">
        {items.map((item) => {
          const busyHere = picked === item.slot;
          return (
            <li key={item.slot}>
              <button
                type="button"
                className={busyHere ? "tchat-fu-row is-picked" : "tchat-fu-row"}
                data-intent={item.intent}
                disabled={picked !== null}
                aria-busy={busyHere || undefined}
                title={item.text}
                onClick={() => void choose(item)}
              >
                <span className="tchat-fu-kind" aria-hidden="true">
                  <Glyph kind={item.intent === "act" ? "act" : "reply"} />
                </span>
                <span className="tchat-fu-text">{item.text}</span>
                <span className="tchat-fu-go" aria-hidden="true">
                  <Glyph kind={busyHere ? "spin" : "go"} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
