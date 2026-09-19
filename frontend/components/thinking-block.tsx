"use client";
import { useId, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
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
    <section className="thinking" data-open={open} data-streaming={streaming}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <Brain size={13} />
        <b>{streaming ? "Thinking" : "Thinking"}</b>
        {streaming ? (
          <span className="thinking-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span>
            {words} word{words === 1 ? "" : "s"}
          </span>
        )}
        <ChevronRight size={13} className="thinking-caret" />
      </button>
      <div id={contentId} className="thinking-body" hidden={!open}>
        {value || "Thinking…"}
      </div>
    </section>
  );
}
