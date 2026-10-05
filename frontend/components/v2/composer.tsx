"use client";
import { useEffect, useState, type FocusEvent, type ReactNode } from "react";
import { Icon } from "./icon";
import { SLASH_COMMANDS_ENABLED } from "@/lib/slash-commands";
import type { StopStatus } from "@/lib/turn-stop";

// Composer frame from docs/truex-design-spec.html (Core components §2).
// Presentational only: the page owns the <form>, the textarea (children) and
// its keyboard handling. The send button is type="submit" inside that form.

// Spec copy (Core §2, Placeholder rotation).
export const PLACEHOLDERS = [
  SLASH_COMMANDS_ENABLED
    ? "Ask anything, or type / for commands"
    : "Ask anything",
  "Summarize last week's pipeline changes",
  "Compare Q2 vs Q3 revenue by region",
  "Draft a reply to the customer escalation",
] as const;
export const GOAL_PLACEHOLDER =
  "Describe the outcome you want. The assistant works until it’s done.";

// Advances every 3200ms while `active` (hero, empty value, unfocused, not goal
// mode). Stopping keeps the index; the text swaps with no transition.
export function useRotatingPlaceholder(active: boolean) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % PLACEHOLDERS.length),
      3200,
    );
    return () => clearInterval(timer);
  }, [active]);
  return PLACEHOLDERS[index];
}

export function Composer({
  children,
  goalMode,
  onGoalToggle,
  onGoalCancel,
  busy,
  canSend,
  onStop,
  hero = false,
  budget,
  chips,
  above,
  below,
  stopTitle,
  stopStatus = null,
  onFocusChange,
}: {
  /** The textarea (e.g. the page's SmoothTextarea). */
  children: ReactNode;
  goalMode: boolean;
  onGoalToggle: () => void;
  onGoalCancel: () => void;
  /** A turn is running: shows the stop button. */
  busy: boolean;
  /** Enables the send button (and shows it next to stop while busy, for steering). */
  canSend: boolean;
  onStop: () => void;
  /** Empty-state variant: no max-width, taller textarea. */
  hero?: boolean;
  /** Budget select, shown after the Goal chip in goal mode. */
  budget?: ReactNode;
  /** Extra chips after the Goal chip (tools, approval mode picker, …). */
  chips?: ReactNode;
  /** Notes above the textarea (pending project, privacy note). */
  above?: ReactNode;
  /** Content between textarea and bar (slash menu, notices). */
  below?: ReactNode;
  stopTitle?: string;
  stopStatus?: StopStatus;
  /** Textarea focus, e.g. to pause useRotatingPlaceholder. */
  onFocusChange?: (focused: boolean) => void;
}) {
  const [focused, setFocused] = useState(false);
  // Only the textarea drives the focus state, not the chips or buttons.
  const track = (value: boolean) => (e: FocusEvent) => {
    if (e.target instanceof HTMLTextAreaElement) {
      setFocused(value);
      onFocusChange?.(value);
    }
  };
  const className = [
    "composer",
    hero && "is-hero",
    goalMode && "goal-mode",
    focused && "is-focus",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={className}
      onFocusCapture={track(true)}
      onBlurCapture={track(false)}
    >
      {goalMode && (
        <div className="composer-goal-head">
          <Icon name="target" size={15} />
          <span>
            <strong>New goal</strong>The assistant keeps working until the goal
            is done, paused or out of budget.
          </span>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={onGoalCancel}
            aria-label="Cancel goal"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {above}
      {children}
      {below}
      <div className="composer-bar">
        <button
          type="button"
          className="chip goal-chip"
          aria-pressed={goalMode}
          onClick={onGoalToggle}
          title="Set this message as the conversation goal"
        >
          <Icon name="target" size={14} />
          Goal
        </button>
        {goalMode && budget}
        {chips}
        <span className="grow" />
        {busy && (
          <button
            type="button"
            className={`send is-stop${stopStatus === "unconfirmed" ? " is-retry" : ""}`}
            onClick={onStop}
            aria-label={stopStatus === "unconfirmed" ? "Retry stop" : "Stop"}
            disabled={stopStatus === "pending"}
            title={stopTitle}
          >
            <Icon name="stop" size={12} stroke={3} />
            {stopStatus === "unconfirmed" && <span>Retry stop</span>}
          </button>
        )}
        {(!busy || canSend) && (
          <button
            type="submit"
            className="send"
            disabled={!canSend}
            aria-label={goalMode ? "Start goal" : "Send"}
          >
            <Icon name="arrowUp" size={17} stroke={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}
