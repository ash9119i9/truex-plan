"use client";
import { useId, useState } from "react";
import { Icon } from "./v2/icon";

// Reasoning as one row of the spec's .steps list (Core §4): spinner while it
// streams, a done mark after. The row expands to show the full text.
export function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const value = text.trim();
  if (!value && !streaming) return null;
  const words = value.split(/\s+/).length;
  return (
    <ul className="steps thinking" data-open={open}>
      <li className={streaming ? undefined : "is-done"}>
        <button
          type="button"
          className="step-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={contentId}
        >
          {streaming ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <span className="step-mark" aria-hidden="true">
              <Icon name="check" size={11} stroke={2.5} />
            </span>
          )}
          <span className="grow">Thinking</span>
          {!streaming && (
            <span className="mono sm muted">
              {words} word{words === 1 ? "" : "s"}
            </span>
          )}
          <Icon name="chevronR" size={13} className="step-caret" />
        </button>
      </li>
      <li id={contentId} className="thinking-body" hidden={!open}>
        {value || "Thinking…"}
      </li>
    </ul>
  );
}
