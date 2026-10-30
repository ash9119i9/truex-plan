"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  canSendMessage,
  draftProblem,
  MAX_MESSAGE_CHARS,
  sendsOnEnter,
  type SendFailure,
} from "@/lib/tenant-chat";
import { docSize, splitName } from "@/lib/tenant-files";
import { documentKind } from "@/lib/document-kind";
import {
  acceptList,
  filesNote,
  UPLOADS_OFF,
  type DraftFile,
  type UploadSettings,
} from "@/lib/tenant-uploads";
import { Spin } from "@/components/tx/live";
import { Icon } from "@/components/tx/icon";
import { Button } from "@/components/tx/button";
import { classes } from "@/components/tx/classes";
import { SmoothTextarea } from "@/components/smooth-textarea";
import { useObjectUrl } from "./file-card";

// Shown from this many characters, before the limit is reached.
const COUNT_FROM = MAX_MESSAGE_CHARS - 2_000;

// Composer (DESIGN-SPEC 11.4, 11.5) for the tenant chat: text, and files
// when the platform takes them (each uploads as soon as it is picked). While
// a reply runs, Send becomes Stop; the chat takes one message at a time.
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
  awaitingApproval = false,
  disabled,
  failure,
  stopError,
  focusKey,
  uploads = UPLOADS_OFF,
  files = [],
  onAddFiles,
  onRemoveFile,
  fileError = "",
  bar,
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
  /** The running reply is paused on a write-tool approval card the member
   * hasn't answered. */
  awaitingApproval?: boolean;
  /** Nothing can be sent (no agent chosen, chat still loading). */
  disabled: boolean;
  failure: SendFailure | null;
  stopError: string;
  /** Focus moves to the textarea when this changes (opening a chat). */
  focusKey: string;
  uploads?: UploadSettings;
  /** The draft's attached files, in order. */
  files?: readonly DraftFile[];
  onAddFiles?: (picked: File[]) => void;
  onRemoveFile?: (key: string) => void;
  /** Why the last picked files weren't attached. */
  fileError?: string;
  /** Controls placed after Attach in the bar (the hero's agent picker). */
  bar?: ReactNode;
}) {
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const touch = useTouch();
  const attaching = uploads.enabled && !!onAddFiles;
  // Files go into the workspace before a reply starts, never into one that
  // is running.
  const filesWait =
    busy && files.length > 0
      ? "Files can be sent once the reply finishes."
      : null;
  const textProblem = draftProblem(value);
  const note = filesNote(files);
  // Problems need the member to change something and are shown as errors;
  // waiting for uploads or the reply is ordinary progress.
  const problem =
    textProblem ?? (note?.problem ? note.text : null) ?? (fileError || null);
  const status = problem ? null : (filesWait ?? note?.text ?? null);
  // A reply in progress no longer blocks sending: a message sent then steers
  // the running turn. Only an empty/too-long draft, files still uploading,
  // an in-flight send, or a disabled composer stops it.
  const ready = canSendMessage(value, files, busy) && !sending && !disabled;
  const add = (list: FileList | null | undefined) => {
    const picked = list ? Array.from(list) : [];
    if (picked.length && attaching && !disabled) onAddFiles!(picked);
  };

  useEffect(() => {
    // Phones keep the keyboard closed until the person taps. A composer that
    // starts disabled (agents still loading) takes focus once it is usable.
    if (!touch && !disabled) input.current?.focus();
  }, [focusKey, touch, disabled]);

  const length = value.length;
  const slim = !hero && !focused && !value && files.length === 0;
  const placeholder = !agentName
    ? "Choose an agent to start"
    : hero
      ? "Ask anything, or type / for commands"
      : busy && awaitingApproval
        ? "Add a note to this turn, or answer above"
        : busy
          ? "Steer this turn: add a note, or press Stop"
          : "Ask a follow-up or assign a step";
  return (
    <form
      className="cs-composer-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSend();
      }}
      onDragOver={(e) => {
        if (!attaching || disabled || !e.dataTransfer.types.includes("Files"))
          return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(e) => {
        if (!attaching || disabled) return;
        e.preventDefault();
        setDragging(false);
        add(e.dataTransfer.files);
      }}
    >
      <div
        className={classes(
          "tx-card pt-composer cs-composer",
          hero && "cs-composer-hero",
          slim && "is-slim",
          dragging && "is-drop",
        )}
      >
        {files.length > 0 && (
          <ul className="ac-tray" role="list" aria-label="Attached files">
            {files.map((file) => (
              <DraftFileChip
                key={file.key}
                file={file}
                removable={!sending}
                onRemove={() => onRemoveFile?.(file.key)}
              />
            ))}
          </ul>
        )}
        <label className="tx-sr" htmlFor={inputId}>
          {agentName ? `Message ${agentName}` : "Message"}
        </label>
        <SmoothTextarea
          ref={input}
          id={inputId}
          className="tx-input pt-composer-input"
          autoGrow={224}
          rows={1}
          value={value}
          // The message being sent was taken from here and comes back if
          // it fails, so nothing typed meanwhile could be lost.
          readOnly={sending}
          aria-describedby={`${inputId}-hint ${inputId}-problem`}
          aria-invalid={textProblem ? true : undefined}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            if (!attaching || e.clipboardData.files.length === 0) return;
            e.preventDefault();
            add(e.clipboardData.files);
          }}
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
        <span id={`${inputId}-hint`} className="tx-sr">
          {touch
            ? "Use the send button to send."
            : "Enter to send, Shift + Enter for a new line."}
        </span>
        <div className="pt-composer-bar">
          {attaching && (
            <>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                accept={acceptList(uploads)}
                onChange={(e) => {
                  add(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                iconOnly
                icon="paperclip"
                variant="ghost"
                size="sm"
                onClick={() => picker.current?.click()}
                disabled={
                  disabled || sending || files.length >= uploads.maxFiles
                }
                aria-label="Attach files"
                title={`Attach files · up to ${uploads.maxFiles}, ${docSize(uploads.maxFileBytes)} each`}
              />
            </>
          )}
          {bar}
          <span
            id={`${inputId}-problem`}
            className={classes(
              "cs-count",
              problem ? "is-bad" : status && "is-status",
            )}
            aria-live="polite"
          >
            {problem ??
              status ??
              (length >= COUNT_FROM
                ? `${length.toLocaleString("en-US")} / ${MAX_MESSAGE_CHARS.toLocaleString("en-US")}`
                : "")}
          </span>
          <span className="pt-spacer" />
          {busy && (
            <Button
              variant="ghost"
              size="sm"
              className="cs-stop"
              icon="stop"
              onClick={onStop}
              working={
                ending === "saving"
                  ? "Saving…"
                  : ending === "stopping"
                    ? "Stopping…"
                    : undefined
              }
            >
              Stop
            </Button>
          )}
          <Button
            type="submit"
            // One primary on the surface (9.1): while a request card is
            // docked above, its decision is the primary, not Send.
            variant={awaitingApproval ? undefined : "primary"}
            size="sm"
            disabled={!ready}
            kbd="↵"
            title={busy ? "Send. It joins the turn in progress" : undefined}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
      {(failure || stopError) && (
        <p
          className={classes("cs-composer-note", !failure?.unknown && "is-bad")}
          role="alert"
        >
          {stopError || failure?.message}
        </p>
      )}
    </form>
  );
}

// One attached file in the composer (DESIGN-SPEC 12.4): its kind (an image as
// itself), name with the extension pinned, its state, and Remove.
export function DraftFileChip({
  file,
  removable,
  onRemove,
}: {
  file: DraftFile;
  removable: boolean;
  onRemove: () => void;
}) {
  const { kind, label } = documentKind(file.name);
  const { base, ext } = splitName(file.name);
  const preview = useObjectUrl(file.preview);
  return (
    <li
      className={`ac is-${file.state === "ready" ? "ready" : file.state}`}
      role="listitem"
      title={file.state === "failed" ? file.error : file.name}
    >
      {preview ? (
        <img className="ac-tile ac-thumb" src={preview} alt="" />
      ) : (
        <span className="ac-tile" aria-hidden="true">
          <Icon name={KIND_ICON[kind]} size="sm" />
        </span>
      )}
      <span className="ac-text">
        <span className="ac-name">
          <span className="dc-base">{base}</span>
          {ext && <span className="dc-ext">{ext}</span>}
        </span>
        <span className="ac-meta">
          {file.state === "uploading" ? (
            <>
              <Spin /> Uploading
            </>
          ) : file.state === "failed" ? (
            <>
              <Icon name="alert" size="sm" /> Upload failed · {file.error}
            </>
          ) : (
            `${label} · ${docSize(file.size)}`
          )}
        </span>
      </span>
      <Button
        iconOnly
        icon="x"
        variant="ghost"
        size="xs"
        className="ac-remove"
        onClick={onRemove}
        disabled={!removable}
        aria-label={`Remove ${file.name}`}
      />
    </li>
  );
}

const KIND_ICON = {
  document: "file",
  sheet: "sheet",
  slides: "slides",
  code: "code",
  text: "text",
} as const;

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
