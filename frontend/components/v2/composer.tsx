"use client";
import {
  useEffect,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "./icon";
import { RqIcon } from "./rq-icon";
import type { SlashCommand } from "@/lib/slash-commands";
import { composerActions, type TurnPhase } from "@/lib/vm-requests";

// Composer from convo-v2-wireframe-r2.html §2. Presentational only: the page
// owns the <form>, the textarea (children) and its keyboard handling. The
// send and Steer buttons are type="submit" inside that form. Open requests
// dock directly above it (never in the scroll) through `requests`, and the
// slash popover sits above it through `slash`. Model settings live in the
// agent popover, not here.

// Placeholder rotation (hero only). The first entry is the r2 copy.
export const PLACEHOLDERS = [
  "Ask, or type / for commands",
  "Summarize last week's pipeline changes",
  "Compare Q2 vs Q3 revenue by region",
  "Draft a reply to the customer escalation",
] as const;
export const GOAL_PLACEHOLDER =
  "Describe the outcome you want. The assistant works until it’s done.";
export const HELD_PLACEHOLDER = "Answer the request above to keep going";
export const STOPPING_PLACEHOLDER = "Steer is paused while the turn stops";

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
  stopping = false,
  held = false,
  canSend,
  onStop,
  hero = false,
  budget,
  chips,
  above,
  below,
  requests,
  slash,
  stopTitle,
  onFocusChange,
}: {
  /** The textarea (e.g. the page's SmoothTextarea). */
  children: ReactNode;
  goalMode: boolean;
  onGoalToggle: () => void;
  onGoalCancel: () => void;
  /** A turn is running: send becomes Steer and a separate Stop shows. */
  busy: boolean;
  /** Stop was pressed and the turn is settling (turn.state "interrupting"). */
  stopping?: boolean;
  /** An open request blocks the turn: the composer is held until it's answered. */
  held?: boolean;
  /** Enables send / Steer. */
  canSend: boolean;
  onStop: () => void;
  /** Empty-state variant: no dock zone, taller textarea. */
  hero?: boolean;
  /** Budget select, shown after the Goal chip in goal mode. */
  budget?: ReactNode;
  /** Extra chips after the Goal chip (approval mode picker, …). */
  chips?: ReactNode;
  /** Notes above the textarea (pending project, privacy note). */
  above?: ReactNode;
  /** Content between textarea and bar (notices). */
  below?: ReactNode;
  /** The docked request stack (RequestDock), shown above the composer. */
  requests?: ReactNode;
  /** The slash popover (SlashMenu) while open, shown above the composer. */
  slash?: ReactNode;
  stopTitle?: string;
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
  const phase: TurnPhase = stopping ? "stopping" : busy ? "running" : "idle";
  const actions = composerActions(phase, canSend, held);
  // Stop is also on Esc when the composer is empty (the page's own Escape
  // handling runs first on the textarea and closes menus / goal mode).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (
      e.key === "Escape" &&
      actions.stop === "stop" &&
      !slash &&
      !goalMode &&
      e.target instanceof HTMLTextAreaElement &&
      !e.target.value
    ) {
      e.preventDefault();
      onStop();
    }
  };
  const className = [
    "rq-composer",
    hero && "is-hero",
    held && "is-held",
    goalMode && "goal-mode",
    focused && "is-focus",
  ]
    .filter(Boolean)
    .join(" ");
  const placeholderLine = held ? (
    <div className="rq-ph">
      <RqIcon name="lock" />
      {HELD_PLACEHOLDER}
    </div>
  ) : stopping ? (
    <div className="rq-ph">{STOPPING_PLACEHOLDER}</div>
  ) : null;

  const composer = (
    <div
      className={className}
      onFocusCapture={track(true)}
      onBlurCapture={track(false)}
      onKeyDown={onKeyDown}
    >
      {goalMode && !held && (
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
      {!held && above}
      {placeholderLine ?? children}
      {!held && below}
      <div className="rq-cbar">
        <button
          type="button"
          className={`rq-chip${goalMode ? " on" : ""}`}
          aria-pressed={goalMode}
          disabled={held}
          onClick={onGoalToggle}
          title="Set this message as the conversation goal"
        >
          <RqIcon name="target" size="sm" />
          Goal
        </button>
        {goalMode && !held && budget}
        {chips}
        <span className="spacer" />
        {actions.send === "send" && (
          <button
            type="submit"
            className={`rq-round${actions.sendEnabled ? "" : " off"}`}
            disabled={!actions.sendEnabled}
            aria-label={goalMode ? "Start goal" : "Send"}
          >
            <RqIcon name="send" />
          </button>
        )}
        {actions.send === "steer" && (
          <button
            type="submit"
            className="rq-steer"
            disabled={!actions.sendEnabled}
            title="Add this to the current turn"
          >
            <RqIcon name="steer" size="sm" />
            Steer
          </button>
        )}
        {actions.send === "steer-off" && (
          <button type="button" className="rq-steer off" disabled>
            <RqIcon name="steer" size="sm" />
            Steer
          </button>
        )}
        {actions.stop === "stop" && (
          <button
            type="button"
            className="rq-round stop"
            onClick={onStop}
            aria-label="Stop"
            aria-keyshortcuts="Escape"
            title={stopTitle}
          >
            <RqIcon name="stop" size="sm" />
          </button>
        )}
        {actions.stop === "stopping" && (
          <span className="rq-stopping" role="status" aria-disabled="true">
            <span className="rq-spin" aria-hidden="true" />
            Stopping…
          </span>
        )}
      </div>
    </div>
  );
  if (hero && !requests && !slash) return composer;
  return (
    <div className="rq-dockzone">
      {slash}
      {requests}
      {composer}
    </div>
  );
}

/** Slash command popover, drawn above the composer while the draft starts with "/". */
export function SlashMenu({
  commands,
  activeIndex,
  onPick,
  id = "chat-commands",
  optionId = (index) => `chat-command-${index}`,
}: {
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (name: string) => void;
  /** Listbox id, for the textarea's aria-controls. */
  id?: string;
  /** Option ids, for the textarea's aria-activedescendant. */
  optionId?: (index: number) => string;
}) {
  if (!commands.length) return null;
  return (
    <div id={id} className="rq-slash" role="listbox" aria-label="Slash commands">
      <div className="rq-slash-h" aria-hidden="true">
        Commands
      </div>
      {commands.map((command, index) => {
        const active = index === activeIndex;
        const kbd = active ? "Enter" : command.shortcut;
        return (
          <button
            id={optionId(index)}
            key={command.name}
            type="button"
            role="option"
            aria-selected={active}
            className={`rq-cmdrow${active ? " is-active" : ""}`}
            // Keep focus in the textarea so typing keeps filtering.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(command.name)}
          >
            <span aria-hidden="true">
              <RqIcon name={command.icon} size="sm" />
            </span>
            <div>
              <b>{command.name}</b>
              <small>{command.description}</small>
            </div>
            {kbd ? (
              <span className="rq-kbd" aria-hidden="true">
                {kbd}
              </span>
            ) : (
              <span />
            )}
          </button>
        );
      })}
      <div className="rq-slash-f" aria-hidden="true">
        <span>
          <span className="rq-kbd">↑</span>
          <span className="rq-kbd">↓</span>move
        </span>
        <span>
          <span className="rq-kbd">Enter</span>pick
        </span>
        <span>
          <span className="rq-kbd">Esc</span>close
        </span>
      </div>
    </div>
  );
}
