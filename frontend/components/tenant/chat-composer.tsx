"use client";
import { useEffect, useRef, useState } from "react";
import {
  canSendDraft,
  draftProblem,
  MAX_MESSAGE_CHARS,
  sendsOnEnter,
  type SendFailure,
} from "@/lib/tenant-chat";
import { Icon } from "@/components/v2/icon";
import { SmoothTextarea } from "@/components/smooth-textarea";

// Shown from this many characters, before the limit is reached.
const COUNT_FROM = MAX_MESSAGE_CHARS - 2_000;

// Composer frame (Core components §2) for the tenant chat: text only. While a
// reply runs, Send becomes Stop; the chat takes one message at a time.
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  agentName,
  hero = false,
  busy,
  sending,
  ending,
  disabled,
  failure,
  stopError,
  focusKey,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  agentName: string | null;
  hero?: boolean;
  /** A reply is running. */
  busy: boolean;
  sending: boolean;
  /** The running reply is ending: a stop was asked for, or it finished and
   * is being saved. Either way there is nothing left to stop. */
  ending: "stopping" | "saving" | null;
  /** Nothing can be sent (no agent chosen, chat still loading). */
  disabled: boolean;
  failure: SendFailure | null;
  stopError: string;
  /** Focus moves to the textarea when this changes (opening a chat). */
  focusKey: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const touch = useTouch();
  const problem = draftProblem(value);
  const ready = canSendDraft(value) && !busy && !sending && !disabled;

  useEffect(() => {
    // Phones keep the keyboard closed until the person taps. A composer that
    // starts disabled (agents still loading) takes focus once it is usable.
    if (!touch && !disabled) input.current?.focus();
  }, [focusKey, touch, disabled]);

  const length = value.length;
  return (
    <form
      className="composer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSend();
      }}
    >
      <div
        className={["composer", hero && "is-hero", focused && "is-focus"]
          .filter(Boolean)
          .join(" ")}
      >
        <SmoothTextarea
          ref={input}
          autoGrow={240}
          rows={hero ? 3 : 2}
          value={value}
          aria-label={agentName ? `Message ${agentName}` : "Message"}
          aria-describedby="tchat-hint tchat-problem"
          aria-invalid={problem ? true : undefined}
          placeholder={
            agentName ? `Message ${agentName}` : "Choose an agent to start"
          }
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (
              !sendsOnEnter(
                {
                  key: e.key,
                  shiftKey: e.shiftKey,
                  altKey: e.altKey,
                  ctrlKey: e.ctrlKey,
                  metaKey: e.metaKey,
                  // keyCode 229: some browsers report IME input this way only.
                  isComposing: e.nativeEvent.isComposing || e.keyCode === 229,
                },
                touch,
              )
            )
              return;
            e.preventDefault();
            if (ready) onSend();
          }}
        />
        <span id="tchat-hint" className="sr-only">
          {touch
            ? "Use the send button to send."
            : "Enter to send, Shift + Enter for a new line."}
        </span>
        <div className="composer-bar">
          <span
            id="tchat-problem"
            className={problem ? "tchat-count is-bad" : "tchat-count"}
            aria-live="polite"
          >
            {problem ??
              (length >= COUNT_FROM
                ? `${length.toLocaleString("en-US")} / ${MAX_MESSAGE_CHARS.toLocaleString("en-US")}`
                : "")}
          </span>
          <span className="grow" />
          {sending && (
            <span className="muted sm" role="status">
              Sending…
            </span>
          )}
          {busy ? (
            <button
              type="button"
              className="send is-stop"
              onClick={onStop}
              disabled={ending !== null}
              aria-label={
                ending === "saving"
                  ? "Saving the reply"
                  : ending === "stopping"
                    ? "Stopping"
                    : "Stop the reply"
              }
              title={
                ending === "saving" ? "Saving the reply" : "Stop the reply"
              }
            >
              <Icon name="stop" size={12} stroke={3} />
            </button>
          ) : (
            <button
              type="submit"
              className="send"
              disabled={!ready}
              aria-label={sending ? "Sending" : "Send"}
            >
              <Icon name="arrowUp" size={17} stroke={2.25} />
            </button>
          )}
        </div>
      </div>
      {(failure || stopError) && (
        <p
          className={failure?.unknown ? "tchat-note" : "tchat-note is-bad"}
          role="alert"
        >
          {stopError || failure?.message}
        </p>
      )}
    </form>
  );
}

// A touch-first device: Enter makes a new line there.
function useTouch(): boolean {
  const [touch, setTouch] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setTouch(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return touch;
}
