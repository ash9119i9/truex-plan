"use client";
import { useEffect, useRef, useState } from "react";
import {
  canSendMessage,
  draftProblem,
  MAX_MESSAGE_CHARS,
  sendsOnEnter,
  type SendFailure,
} from "@/lib/tenant-chat";
import { fileTag, formatBytes } from "@/lib/tenant-files";
import {
  acceptList,
  filesNote,
  UPLOADS_OFF,
  type DraftFile,
  type UploadSettings,
} from "@/lib/tenant-uploads";
import { Icon } from "@/components/v2/icon";
import { SmoothTextarea } from "@/components/smooth-textarea";
import { useObjectUrl } from "./file-card";
import "@/styles/v2/chat-files.css";

// Shown from this many characters, before the limit is reached.
const COUNT_FROM = MAX_MESSAGE_CHARS - 2_000;

// Composer frame (Core components §2) for the tenant chat: text, and files
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
}) {
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
  return (
    <form
      className="composer-form"
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
        className={[
          "composer",
          hero && "is-hero",
          focused && "is-focus",
          dragging && "is-drop",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {files.length > 0 && (
          <ul className="composer-files" aria-label="Attached files">
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
        <SmoothTextarea
          ref={input}
          autoGrow={240}
          rows={hero ? 3 : 2}
          value={value}
          // The message being sent was taken from here and comes back if
          // it fails, so nothing typed meanwhile could be lost.
          readOnly={sending}
          aria-label={agentName ? `Message ${agentName}` : "Message"}
          aria-describedby="tchat-hint tchat-problem"
          aria-invalid={textProblem ? true : undefined}
          placeholder={
            agentName ? `Message ${agentName}` : "Choose an agent to start"
          }
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
        <span id="tchat-hint" className="sr-only">
          {touch
            ? "Use the send button to send."
            : "Enter to send, Shift + Enter for a new line."}
        </span>
        <div className="composer-bar">
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
              <button
                type="button"
                className="icon-btn ghost"
                onClick={() => picker.current?.click()}
                disabled={
                  disabled || sending || files.length >= uploads.maxFiles
                }
                aria-label="Attach files"
                title={`Attach files (up to ${uploads.maxFiles}, ${formatBytes(uploads.maxFileBytes)} each)`}
              >
                <Icon name="paperclip" size={16} />
              </button>
            </>
          )}
          <span
            id="tchat-problem"
            className={
              problem
                ? "tchat-count is-bad"
                : status
                  ? "tchat-count is-status"
                  : "tchat-count"
            }
            aria-live="polite"
          >
            {problem ??
              status ??
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
          {!sending && awaitingApproval && (
            <span className="muted sm" role="status">
              Waiting for your approval
            </span>
          )}
          {busy && (
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
          )}
          <button
            type="submit"
            className="send"
            disabled={!ready}
            aria-label={
              sending ? "Sending" : busy ? "Send to this reply" : "Send"
            }
            title={busy ? "Send to this reply" : undefined}
          >
            <Icon name="arrowUp" size={17} stroke={2.25} />
          </button>
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

// One attached file in the composer: its type (an image as itself), name
// and size, uploading or why it failed, and Remove.
function DraftFileChip({
  file,
  removable,
  onRemove,
}: {
  file: DraftFile;
  removable: boolean;
  onRemove: () => void;
}) {
  const tag = fileTag(file.name);
  const preview = useObjectUrl(file.preview);
  return (
    <li
      className={file.state === "failed" ? "draft-file is-bad" : "draft-file"}
      title={file.state === "failed" ? file.error : file.name}
    >
      {preview ? (
        <img className="file-tile file-thumb" src={preview} alt="" />
      ) : (
        <span className={`file-tile ft-${tag.tone}`} aria-hidden="true">
          {tag.label}
        </span>
      )}
      <span className="draft-file-text">
        <span className="draft-file-name">{file.name}</span>
        <span className="draft-file-meta">
          {file.state === "uploading" ? (
            <>
              <span className="spinner" aria-hidden="true" /> Uploading
            </>
          ) : file.state === "failed" ? (
            file.error
          ) : (
            formatBytes(file.size)
          )}
        </span>
      </span>
      <button
        type="button"
        className="icon-btn ghost"
        onClick={onRemove}
        disabled={!removable}
        aria-label={`Remove ${file.name}`}
      >
        <Icon name="x" size={13} />
      </button>
    </li>
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
