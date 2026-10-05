"use client";
import { useId, useState } from "react";
import { Icon } from "./v2/icon";

// Reasoning as one row of the spec's .steps list (Core §4): spinner while it
// streams, a done mark after. The row expands to show the full text.
export function ThinkingBlock({
  text,
  streaming,
}: {
  text: string | readonly { text: string }[];
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const hasText =
    typeof text === "string"
      ? /\S/.test(text)
      : text.some((part) => /\S/.test(part.text));
  if (!hasText && !streaming) return null;
  // Joining and counting a long streamed trace belongs to the open disclosure.
  const value = open
    ? (typeof text === "string"
        ? text
        : text
            .map((part) => part.text)
            .filter(Boolean)
            .join("\n\n")
      ).trim()
    : "";
  const words = open && value ? value.split(/\s+/).length : 0;
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
          <span className="grow">{streaming ? "Thinking…" : "Reasoning"}</span>
          {!streaming && (
            <span className="mono sm muted">
              {open ? `${words} word${words === 1 ? "" : "s"}` : "Complete"}
            </span>
          )}
          <Icon name="chevronR" size={13} className="step-caret" />
        </button>
      </li>
      <li id={contentId} className="thinking-body" hidden={!open}>
        {open && (value || "Thinking…")}
      </li>
    </ul>
  );
}
