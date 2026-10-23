"use client";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { tintOf } from "@/lib/agent-look";
import {
  exchangeKey,
  exchangesOf,
  isSettled,
  messageStateNote,
  outcomeNote,
  replyItems,
  SLOW_REPLY_MS,
  isCutShort,
  progressFlags,
  pendingApprovalForItem,
  approvalForItem,
  sentSteerId,
  steerText,
  titleProblem,
  usageLine,
  type ApprovalView,
  type ChatMessage,
  type ChatRun,
  type ChatSummary,
  type ChatThread,
  type LiveReply,
} from "@/lib/tenant-chat";
import { Icon } from "@/components/v2/icon";
import {
  approvalCardTitle,
  approvalOutcomeLabel,
  connectorBanner,
  connectorName,
  savedApprovalLabel,
  toolCardLabel,
  type ApprovalAnswer,
  type ConnectorFailureReason,
  type ConnectorRef,
  type SavedTool,
  type ToolCall,
} from "@/lib/tenant-connectors";
import {
  CopyTextButton,
  StreamingMarkdown,
} from "@/components/streaming-markdown";
// Connect card, tool rows, connector banner and picker styles.
import {
  activityLabel,
  writingNote,
  allowForChatHint,
  codingCardTitle,
  fileLabel,
  type Activity,
} from "@/lib/tenant-coding";
import {
  fileTag,
  filesOfRun,
  formatBytes,
  isImage,
  type ChatFile,
} from "@/lib/tenant-files";
import type { MessageAttachment } from "@/lib/tenant-uploads";
import {
  networkDetail,
  networkOutcome,
  networkTitle,
  type NetworkBlock,
  type NetworkDecision,
} from "@/lib/tenant-network";
import {
  FileActionsContext,
  FileCard,
  useImageBlob,
  useObjectUrl,
  type WritingFile,
} from "./file-card";
import "@/styles/v2/connectors.css";

// How the browser's own connection to a live reply is doing; the platform's
// phases (retrying, stopping, …) come in the reply itself.
export type Connection = "open" | "reconnecting" | "lost";

// Close enough to the end to keep following new text.
const STICK_PX = 80;

const PHASE_NOTE: Partial<Record<LiveReply["phase"], string>> = {
  retrying: "Retrying…",
  reconnecting: "Reconnecting to the assistant…",
  stopping: "Stopping…",
};

// The same "Cut short by your next message" label the saved reply shows,
// reused while the reply still streams so the cut text reads the same before
// and after it is saved.
const LIVE_INTERRUPTED_NOTE =
  messageStateNote({
    role: "assistant",
    state: "interrupted",
  } as ChatMessage) ?? "";

export function ChatHeader({
  chat,
  busy,
  creating = false,
  onRename,
  onArchive,
}: {
  chat: ChatSummary;
  /** A reply is running: archiving waits for it. */
  busy: boolean;
  /** The chat is being created by its first message: nothing to act on. */
  creating?: boolean;
  onRename: (title: string) => Promise<string | null>;
  onArchive: () => Promise<string | null>;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "archive">("view");
  const [title, setTitle] = useState(chat.title);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  // Another chat, or a rename from elsewhere, resets the form.
  useEffect(() => {
    setMode("view");
    setError("");
  }, [chat.id]);
  const problem = mode === "rename" ? titleProblem(title) : null;

  const run = async (action: () => Promise<string | null>) => {
    if (working) return;
    setWorking(true);
    setError("");
    const failed = await action();
    setWorking(false);
    if (failed) setError(failed);
    else setMode("view");
  };

  return (
    <div className="tchat-head">
      {mode === "rename" ? (
        <form
          className="tchat-rename"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) void run(() => onRename(title.trim()));
          }}
        >
          <label className="sr-only" htmlFor="tchat-title">
            Chat title
          </label>
          <input
            id="tchat-title"
            className="input"
            value={title}
            autoFocus
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setMode("view");
            }}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem || error ? "tchat-title-hint" : undefined}
          />
          <button
            type="submit"
            className="btn-solid"
            disabled={!!problem || working}
          >
            {working ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn-soft"
            onClick={() => setMode("view")}
            disabled={working}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <div className="tchat-head-text">
            <h1 className="tchat-title">{chat.title || "New chat"}</h1>
            <p className="muted sm">
              {[chat.agent?.name, chat.model?.displayName]
                .filter(Boolean)
                .join(" · ") || "Agent unavailable"}
            </p>
          </div>
          {creating ? null : mode === "archive" ? (
            <div
              className="tchat-head-actions"
              role="group"
              aria-labelledby="tchat-archive-q"
            >
              <span className="sm" id="tchat-archive-q">
                Archive this chat? It leaves your list and can&apos;t be
                continued.
              </span>
              <button
                type="button"
                className="btn-danger"
                autoFocus
                disabled={working}
                onClick={() => void run(onArchive)}
              >
                {working ? "Archiving…" : "Archive"}
              </button>
              <button
                type="button"
                className="btn-soft"
                disabled={working}
                onClick={() => setMode("view")}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="tchat-head-actions">
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  setTitle(chat.title);
                  setError("");
                  setMode("rename");
                }}
              >
                Rename
              </button>
              {chat.status === "active" && (
                <button
                  type="button"
                  className="text-btn"
                  disabled={busy}
                  title={
                    busy ? "Wait for the reply, or stop it, first." : undefined
                  }
                  onClick={() => {
                    setError("");
                    setMode("archive");
                  }}
                >
                  Archive
                </button>
              )}
            </div>
          )}
        </>
      )}
      {(problem || error) && (
        <p id="tchat-title-hint" className="field-hint is-bad" role="alert">
          {error || problem}
        </p>
      )}
    </div>
  );
}

export const Transcript = memo(function Transcript({
  thread,
  live,
  connection,
  loadingOlder,
  olderError,
  onLoadOlder,
  onReconnect,
  onResend,
  onApprove,
  approvalBusy,
  tenantId,
  files,
}: {
  thread: ChatThread;
  live: LiveReply | null;
  connection: Connection;
  loadingOlder: boolean;
  olderError: string;
  onLoadOlder: () => void;
  onReconnect: () => void;
  // Sends a not-sent message's text again as a new message.
  onResend: (text: string) => void;
  // Answers a pending write-tool approval card.
  onApprove: (approvalId: string, decision: ApprovalAnswer) => void;
  // The approvalId whose answer is in flight (its card's buttons disabled),
  // or null.
  approvalBusy: string | null;
  // This tab's tenant, for the Connected tools reconnect link.
  tenantId: string;
  // Every stored file version of the chat; each reply shows its own.
  files: readonly ChatFile[];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const exchanges = exchangesOf(thread);
  // A live reply with nothing saved yet gets its own row, keyed like the
  // exchange it becomes, so it is not remounted when its messages arrive.
  const shown =
    live && !exchanges.some((e) => e.runId === live.runId)
      ? [...exchanges, { runId: live.runId, messages: [], run: null }]
      : exchanges;
  const agent = thread.chat.agent;
  const agentName = agent?.name ?? "Assistant";
  const hue = tintOf(agent?.tint).bg;
  const connectors = thread.chat.connectors;
  const liveText =
    live?.items.reduce(
      (n, i) => n + (i.type === "reply" ? i.text.length : 0),
      0,
    ) ?? 0;
  const firstId = thread.messages[0]?.id;

  // A newly opened chat starts at its end.
  useLayoutEffect(() => {
    stick.current = true;
  }, [thread.chat.id]);

  // So does a message just sent, even if the reader had scrolled up.
  const newest = thread.messages.at(-1);
  const sentId = newest?.role === "user" ? newest.id : null;
  useLayoutEffect(() => {
    if (sentId) stick.current = true;
  }, [sentId]);
  // …and a follow-up sent into the running reply, which joins the live
  // reply rather than the saved messages.
  const steerId = sentSteerId(live);
  useLayoutEffect(() => {
    if (steerId) stick.current = true;
  }, [steerId]);

  // Older history keeps what was on screen in place; otherwise new text is
  // followed while the reader is at the end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop =
        anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [
    thread.chat.id,
    firstId,
    thread.messages.length,
    liveText,
    live?.phase,
    live?.items.length,
    // A new approval card (or its settling) changes the reply's height.
    live && Object.keys(live.approvals).length,
    // So does a reply's file card.
    files.length,
  ]);

  const loadOlder = () => {
    const el = scroller.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadOlder();
  };

  return (
    <div
      ref={scroller}
      className="scroll"
      role="log"
      aria-label="Conversation"
      aria-live="off"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}
    >
      <div className="thread">
        {thread.hasMore && (
          <div className="tchat-older">
            <button
              type="button"
              className="btn-soft"
              onClick={loadOlder}
              disabled={loadingOlder}
            >
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </button>
            {olderError && (
              <p className="field-hint is-bad" role="alert">
                {olderError}
              </p>
            )}
          </div>
        )}
        {shown.map((exchange) => (
          <Exchange
            key={exchangeKey(exchange)}
            messages={exchange.messages}
            run={exchange.run}
            live={live?.runId === exchange.runId ? live : null}
            connection={connection}
            agentName={agentName}
            hue={hue}
            connectors={connectors}
            tenantId={tenantId}
            onReconnect={onReconnect}
            onResend={onResend}
            onApprove={onApprove}
            approvalBusy={approvalBusy}
            files={filesOfRun(files, exchange.runId)}
          />
        ))}
      </div>
    </div>
  );
});

function Exchange({
  messages,
  run,
  live,
  connection,
  agentName,
  hue,
  connectors,
  tenantId,
  onReconnect,
  onResend,
  onApprove,
  approvalBusy,
  files,
}: {
  messages: ChatMessage[];
  run: ChatRun | null;
  live: LiveReply | null;
  connection: Connection;
  agentName: string;
  hue: string;
  connectors: ConnectorRef[];
  tenantId: string;
  onReconnect: () => void;
  onResend: (text: string) => void;
  onApprove: (approvalId: string, decision: ApprovalAnswer) => void;
  approvalBusy: string | null;
  // The files this reply stored (newest version of each path).
  files: ChatFile[];
}) {
  // A live run shows its saved user message(s) and the reply as it streams;
  // the replies Codex has written are in the live items, so the run's own
  // saved assistant messages are not shown twice.
  const userMessages = live ? messages.filter((m) => m.role === "user") : null;
  return (
    <>
      {live
        ? userMessages!.map((user) => (
            <UserBubble key={user.id} message={user} onResend={onResend} />
          ))
        : null}
      {live ? (
        <AgentReply agentName={agentName} hue={hue} live={live}>
          <LiveBody
            live={live}
            run={run}
            connection={connection}
            connectors={connectors}
            tenantId={tenantId}
            onReconnect={onReconnect}
            onApprove={onApprove}
            approvalBusy={approvalBusy}
            files={files}
          />
        </AgentReply>
      ) : (
        <SavedExchange
          messages={messages}
          run={run}
          agentName={agentName}
          hue={hue}
          connectors={connectors}
          onResend={onResend}
          files={files}
        />
      )}
    </>
  );
}

// A member's message bubble. A `not_sent` steer — one the assistant never
// read — is labelled and offers to send the same text again.
function UserBubble({
  message,
  onResend,
}: {
  message: ChatMessage;
  onResend: (text: string) => void;
}) {
  const note = messageStateNote(message);
  return (
    <article className="msg user" aria-label="Your message">
      <div className="bubble-wrap">
        {message.attachments && (
          <SentFiles runId={message.runId} files={message.attachments} />
        )}
        {message.text && <div className="bubble">{message.text}</div>}
        {message.state === "not_sent" && (
          <p className="msg-foot tchat-notsent">
            {note}
            <button
              type="button"
              className="text-btn"
              onClick={() => onResend(message.text)}
            >
              Resend
            </button>
          </p>
        )}
      </div>
    </article>
  );
}

// The files a member attached to a message, above its text: an image as
// itself, any other file as its tile and name. A saved one opens in the file
// viewer; one still being sent can't be opened yet.
function SentFiles({
  runId,
  files,
}: {
  runId: string;
  files: readonly MessageAttachment[];
}) {
  const actions = useContext(FileActionsContext);
  const images = files.filter((f) => isImage(f.name));
  const others = files.filter((f) => !isImage(f.name));
  const open = (file: MessageAttachment) =>
    actions && file.fileId
      ? () => actions.open({ runId, path: file.path, fileId: file.fileId })
      : undefined;
  return (
    <>
      {images.length > 0 && (
        <ul className="sent-images" aria-label="Attached images">
          {images.map((file, i) => (
            <li key={file.fileId || `${i}:${file.name}`}>
              <SentImage file={file} onOpen={open(file)} />
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="sent-files" aria-label="Attached files">
          {others.map((file, i) => {
            const onOpen = open(file);
            const body = <FileChipBody name={file.name} size={file.size} />;
            return (
              <li
                key={file.fileId || `${i}:${file.name}`}
                className="draft-file"
              >
                {onOpen ? (
                  <button
                    type="button"
                    className="sent-file-open"
                    onClick={onOpen}
                    aria-label={`Open ${file.name}`}
                  >
                    {body}
                  </button>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function FileChipBody({ name, size }: { name: string; size: number }) {
  const tag = fileTag(name);
  return (
    <>
      <span className={`file-tile ft-${tag.tone}`} aria-hidden="true">
        {tag.label}
      </span>
      <span className="draft-file-text">
        <span className="draft-file-name">{name}</span>
        <span className="draft-file-meta">{formatBytes(size)}</span>
      </span>
    </>
  );
}

// A sent image, shown from the bytes this browser still has or the saved
// version. Until it loads (or if it can't) it keeps its place as a plain
// frame, so the message doesn't jump; one that fails shows its file chip.
function SentImage({
  file,
  onOpen,
}: {
  file: MessageAttachment;
  onOpen: (() => void) | undefined;
}) {
  const blob = useImageBlob(file.preview, file.fileId || undefined);
  const url = useObjectUrl(blob instanceof Blob ? blob : null);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  if (broken || blob === "failed")
    return (
      <span className="draft-file">
        <FileChipBody name={file.name} size={file.size} />
      </span>
    );
  const image = url ? (
    <img
      src={url}
      alt={file.name}
      decoding="async"
      onError={() => setBroken(true)}
    />
  ) : (
    <span className="sent-image-wait" aria-label={`${file.name}, loading`} />
  );
  return onOpen ? (
    <button
      type="button"
      className="sent-image"
      onClick={onOpen}
      aria-label={`Open ${file.name}`}
      title={file.name}
    >
      {image}
    </button>
  ) : (
    <span className="sent-image" title={file.name}>
      {image}
    </span>
  );
}

// A steer shown inside the running reply before it is saved: the same bubble
// as a sent message, placed where Codex read it.
function SteerBubble({ text }: { text: string }) {
  return (
    <article className="msg user" aria-label="Your message">
      <div className="bubble-wrap">
        <div className="bubble">{text}</div>
      </div>
    </article>
  );
}

// A saved tool message's payload rendered as a ToolCall, with the connector's
// display name resolved from the chat's connector list (slug fallback).
function savedToolToCall(
  tool: SavedTool,
  connectors: ConnectorRef[],
): ToolCall {
  return {
    connector: connectorName(tool.connector, connectors),
    tool: tool.name,
    status: tool.status,
    durationMs: tool.durationMs,
    errorCode: tool.errorCode,
  };
}

// A compact inline row for one connector tool call, live or saved. The label
// carries the meaning for a screen reader; the spinner is decorative. Only a
// live in-progress row is a status region (it announces when it settles); a
// saved row is static and is not announced. `approvalLabel` is the decision
// a write-tool call settled with ("Allowed", "Not run", …), shown after the
// call label.
function ToolRow({
  call,
  live,
  approvalLabel,
}: {
  call: ToolCall;
  live: boolean;
  approvalLabel?: string | null;
}) {
  const running = call.status === "inProgress";
  const label = toolCardLabel(call);
  return (
    <div
      className={call.status === "failed" ? "tool-card is-failed" : "tool-card"}
      role={live && running ? "status" : undefined}
    >
      {running ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <Icon
          name={call.status === "failed" ? "x" : "check"}
          size={13}
          className="tool-card-icon"
        />
      )}
      <span>{label}</span>
      {approvalLabel && (
        <span className="tool-card-approval">· {approvalLabel}</span>
      )}
    </div>
  );
}

// What a network card on a saved reply can do. Provided by the chat screen;
// absent (no buttons) where a transcript is shown read-only.
export interface NetworkActions {
  answer: (messageId: string, decision: NetworkDecision) => void;
  // The message whose answer is in flight, or null.
  busy: string | null;
  // Why the last answer to a card failed, by message.
  errors: Readonly<Record<string, string>>;
  // Sends "Try again" as the next message; null while a reply is running or
  // the chat can't continue. Offered only on the chat's latest reply.
  tryAgain: (() => void) | null;
  latestRunId: string | null;
}

export const NetworkActionsContext = createContext<NetworkActions | null>(null);

// A sandbox request Truex blocked. Live (`messageId` null) it only reports
// the block: the card can be answered once the reply is saved. Saved, it
// offers the answers the block allows; an allow applies from the next reply.
// Host and connector names come from the runtime: plain text only.
function NetworkCard({
  block,
  messageId,
  runId,
}: {
  block: NetworkBlock;
  messageId: string | null;
  runId: string;
}) {
  const actions = useContext(NetworkActionsContext);
  const title = networkTitle(block);
  const busy = !!messageId && actions?.busy === messageId;
  const error = messageId ? actions?.errors[messageId] : undefined;
  const open = !!messageId && !!actions && !block.decision;
  return (
    <div className="approval-card network-card" role="group" aria-label={title}>
      <p className="approval-title network-title">
        <Icon name="lock" size={13} className="tool-card-icon" />
        <span>{title}</span>
      </p>
      <p className="approval-hint network-detail">{networkDetail(block)}</p>
      {block.decision ? (
        <div className="approval-actions">
          <p className="approval-outcome" role="status">
            {networkOutcome(block.decision)}
          </p>
          {block.decision !== "keep_blocked" &&
            actions?.tryAgain &&
            actions.latestRunId === runId && (
              <button
                type="button"
                className="btn-soft"
                onClick={actions.tryAgain}
              >
                Try again
              </button>
            )}
        </div>
      ) : !messageId ? (
        <p className="approval-outcome">
          {block.grant === "none"
            ? "This can't be allowed."
            : "You can allow it when this reply finishes."}
        </p>
      ) : open && block.grant !== "none" ? (
        <div className="approval-actions">
          <button
            type="button"
            className="btn-solid"
            disabled={busy}
            onClick={() => actions!.answer(messageId, "allow_once")}
          >
            Allow once
          </button>
          {block.grant === "chat" && (
            <button
              type="button"
              className="btn-soft"
              disabled={busy}
              onClick={() => actions!.answer(messageId, "allow_for_chat")}
            >
              Allow for this chat
            </button>
          )}
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() => actions!.answer(messageId, "keep_blocked")}
          >
            Keep blocked
          </button>
        </div>
      ) : (
        block.grant === "none" && (
          <p className="approval-outcome">This can't be allowed.</p>
        )
      )}
      {error && (
        <p className="field-hint is-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// A skill the reply used. Only its name: what the model read stays private.
function SkillRow({ name }: { name: string }) {
  return (
    <div className="tool-card">
      <Icon name="book" size={13} className="tool-card-icon" />
      <span>Used skill {name}</span>
    </div>
  );
}

// The inline approval card shown at a write tool's row while it waits for the
// member. Params are model-written and untrusted, so they are rendered as
// plain text, wrapped, never HTML. The card takes focus when it appears
// (without scrolling the reader away), the three answers are real buttons,
// and Escape is deliberately NOT bound to Deny (too easy to hit). While an
// answer is in flight the buttons are disabled; a lost first-answer race
// (409/404) shows "Already answered"/"Expired" instead.
function ApprovalCard({
  approval,
  connectorLabel,
  busy,
  onApprove,
}: {
  approval: ApprovalView;
  connectorLabel: string;
  busy: boolean;
  onApprove: (approvalId: string, decision: ApprovalAnswer) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus the card when it appears so a keyboard user reaches the buttons
  // without hunting; preventScroll keeps a reader who scrolled up in place.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const coding = approval.kind !== "mcp";
  const title = coding
    ? codingCardTitle(approval.tool)
    : approvalCardTitle(connectorLabel, approval.tool);
  const race =
    approval.race === "resolved"
      ? "Already answered"
      : approval.race === "not_found"
        ? "Expired"
        : null;
  const command =
    approval.kind === "command"
      ? approval.params.find((p) => p.name === "command")?.value
      : undefined;
  const hint =
    coding && approval.allowForChat ? allowForChatHint(approval.tool) : null;
  return (
    <div
      ref={ref}
      className="approval-card"
      role="group"
      aria-label={title}
      tabIndex={-1}
    >
      <p className="approval-title">{title}</p>
      {command !== undefined ? (
        // Plain text only: model-written, shown exactly as it will run.
        <pre className="approval-command">{command}</pre>
      ) : (
        approval.params.length > 0 && (
          <dl className="approval-params">
            {approval.params.map((p, i) => (
              <div key={`${p.name}:${i}`} className="approval-param">
                <dt>{p.name}</dt>
                {/* Plain text only: model-written, never rendered as HTML. */}
                <dd>{p.value}</dd>
              </div>
            ))}
          </dl>
        )
      )}
      {race ? (
        <p className="approval-outcome" role="status">
          {race}
        </p>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="btn-solid"
            disabled={busy}
            onClick={() => onApprove(approval.approvalId, "allow")}
          >
            Allow once
          </button>
          {approval.allowForChat && (
            <button
              type="button"
              className="btn-soft"
              disabled={busy}
              onClick={() => onApprove(approval.approvalId, "allow_for_chat")}
            >
              Allow for this chat
            </button>
          )}
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() => onApprove(approval.approvalId, "deny")}
          >
            Deny
          </button>
        </div>
      )}
      {hint && !race && <p className="approval-hint">{hint}</p>}
    </div>
  );
}

// One command or file change in the chat's workspace, live or saved. The
// command and its output are model-written: plain text, never HTML. Output
// is collapsed by default so a long test run does not push the answer away.
function ActivityRow({
  activity,
  live,
  approvalLabel,
  asking = false,
}: {
  activity: Activity;
  live: boolean;
  approvalLabel?: string | null;
  // Its approval card is open and already shows the command.
  asking?: boolean;
}) {
  const running = activity.status === "inProgress";
  const failed = activity.status === "failed" || activity.status === "declined";
  const note = writingNote(activity);
  return (
    <div
      className={
        failed ? "tool-card activity-card is-failed" : "tool-card activity-card"
      }
      role={live && running ? "status" : undefined}
    >
      <div className="activity-head">
        {running ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <Icon
            name={
              failed ? "x" : activity.type === "command" ? "check" : "pencil"
            }
            size={13}
            className="tool-card-icon"
          />
        )}
        <span>
          {asking && running
            ? "Waiting for your approval"
            : activityLabel(activity)}
        </span>
        {approvalLabel && (
          <span className="tool-card-approval">· {approvalLabel}</span>
        )}
        {/* Updates twice a second; kept out of the status announcement. */}
        {note && (
          <span className="tool-card-approval" aria-hidden="true">
            · {note}
          </span>
        )}
      </div>
      {activity.type === "command" ? (
        <>
          {!asking && (
            <pre className="activity-command">{activity.command}</pre>
          )}
          {activity.output && (
            <details className="activity-output">
              <summary>
                Output{activity.outputTruncated ? " (cut short)" : ""}
              </summary>
              <pre>{activity.output}</pre>
            </details>
          )}
        </>
      ) : (
        activity.files.length > 1 && (
          <ul className="activity-files">
            {activity.files.map((file, i) => (
              <li key={`${file.path}:${i}`}>{fileLabel(file)}</li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

// A live command or file change with its approval card, like a tool row.
function ActivityApprovalRow({
  activity,
  pending,
  settled,
  onApprove,
  approvalBusy,
}: {
  activity: Activity;
  pending: ApprovalView | null;
  settled: ApprovalView | null;
  onApprove: (approvalId: string, decision: ApprovalAnswer) => void;
  approvalBusy: string | null;
}) {
  const label =
    settled && settled.status !== "pending"
      ? approvalOutcomeLabel(settled.status)
      : null;
  return (
    <>
      <ActivityRow
        activity={activity}
        live
        approvalLabel={label}
        asking={!!pending}
      />
      {pending && (
        <ApprovalCard
          approval={pending}
          connectorLabel="Workspace"
          busy={approvalBusy === pending.approvalId}
          onApprove={onApprove}
        />
      )}
    </>
  );
}

// The banners for connectors that failed during this reply, shown once per
// connector. An auth failure links to Connected tools to reconnect.
function ConnectorBanners({
  failures,
  connectors,
  tenantId,
}: {
  failures: Record<string, ConnectorFailureReason>;
  connectors: ConnectorRef[];
  tenantId: string;
}) {
  const banners = Object.entries(failures).flatMap(([slug, reason]) => {
    const banner = connectorBanner(
      "failed",
      reason,
      connectorName(slug, connectors),
    );
    return banner ? [{ slug, banner }] : [];
  });
  if (!banners.length) return null;
  return (
    <>
      {banners.map(({ slug, banner }) => (
        <div
          key={slug}
          className="connector-banner"
          role="status"
          aria-live="polite"
        >
          <Icon name="plug" size={14} aria-hidden="true" />
          <span className="grow">{banner.message}</span>
          {banner.reconnect && (
            <a className="link" href={`/t/${tenantId}/connected-tools`}>
              Reconnect
            </a>
          )}
        </div>
      ))}
    </>
  );
}

// A settled run's saved messages in seq order: member bubbles and assistant
// replies, interleaved, with the run's note and usage after the last reply.
function SavedExchange({
  messages,
  run,
  agentName,
  hue,
  connectors,
  onResend,
  files,
}: {
  messages: ChatMessage[];
  run: ChatRun | null;
  agentName: string;
  hue: string;
  connectors: ConnectorRef[];
  onResend: (text: string) => void;
  files: ChatFile[];
}) {
  const note = run ? outcomeNote(run.status, run.error) : null;
  const card =
    run && (files.length > 0 || run.unsavedFiles?.length) ? (
      <FileCard
        runId={run.id}
        files={files}
        writing={[]}
        unsaved={run.unsavedFiles}
      />
    ) : null;
  const usage = run && isSettled(run.status) ? usageLine(run) : "";
  // Everything between two user messages (progress replies, tool rows and
  // the answer) shares one reply frame, in saved order, as it did while
  // live. The run footer rides the last frame so it sits at the end of the
  // exchange.
  const blocks: Array<
    | { kind: "user"; message: ChatMessage }
    | { kind: "agent"; messages: ChatMessage[] }
  > = [];
  for (const message of messages) {
    if (message.role === "user") blocks.push({ kind: "user", message });
    else {
      const last = blocks.at(-1);
      if (last?.kind === "agent") last.messages.push(message);
      else blocks.push({ kind: "agent", messages: [message] });
    }
  }
  const lastAgentIndex = blocks.map((b) => b.kind).lastIndexOf("agent");
  const hasFooter = !!(note || usage || card);
  // An empty settled run (no replies saved) still shows its footer.
  const showLooseFooter = hasFooter && lastAgentIndex < 0;
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === "user" ? (
          <UserBubble
            key={block.message.id}
            message={block.message}
            onResend={onResend}
          />
        ) : (
          <AgentReply
            key={block.messages[0].id}
            agentName={agentName}
            hue={hue}
            live={null}
          >
            <SavedBody
              entries={block.messages}
              connectors={connectors}
              note={index === lastAgentIndex ? note : null}
              usage={index === lastAgentIndex ? usage : ""}
              failed={run?.status === "failed"}
              card={index === lastAgentIndex ? card : null}
            />
          </AgentReply>
        ),
      )}
      {showLooseFooter && (
        <AgentReply agentName={agentName} hue={hue} live={null}>
          <SavedBody
            entries={[]}
            connectors={connectors}
            note={note}
            usage={usage}
            failed={run?.status === "failed"}
            card={card}
          />
        </AgentReply>
      )}
    </>
  );
}

// One reply's frame. A live reply and its saved copy share it, so the reply
// is not remounted (and its entrance animation not replayed) when it settles.
function AgentReply({
  agentName,
  hue,
  live,
  children,
}: {
  agentName: string;
  hue: string;
  live: LiveReply | null;
  children: ReactNode;
}) {
  const streaming = !!live && live.phase !== "settled";
  return (
    <article
      className="msg agent"
      aria-label={`${agentName} reply`}
      aria-busy={streaming || undefined}
    >
      <span
        className="agent-avatar"
        style={{ background: hue } as CSSProperties}
        aria-hidden="true"
      >
        <Icon name="spark" size={13} stroke={2} />
      </span>
      <div className="grow">
        <div className="msg-meta">
          <span className="strong">{agentName}</span>
          {streaming && !live.items.length && (
            <span className="muted sm">thinking…</span>
          )}
        </div>
        {children}
      </div>
    </article>
  );
}

// StreamingMarkdown is memoized on its text, so saved replies are not parsed
// again while another reply streams. The run's footer (note and usage) is
// passed in so it sits after the last reply of the exchange.
function SavedBody({
  entries,
  connectors,
  note,
  usage,
  failed,
  card,
}: {
  entries: ChatMessage[];
  connectors: ConnectorRef[];
  note: string | null;
  usage: string;
  failed: boolean;
  // The reply's file card, after its last paragraph.
  card: ReactNode;
}) {
  const progress = progressFlags(
    entries.map((m) => (m.role === "tool" ? "tool" : "reply")),
  );
  return (
    <>
      {entries.map((entry, index) =>
        entry.role === "tool" && entry.skill ? (
          <SkillRow key={entry.id} name={entry.skill.name} />
        ) : entry.role === "tool" && entry.network ? (
          <NetworkCard
            key={entry.id}
            block={entry.network}
            messageId={entry.id}
            runId={entry.runId}
          />
        ) : entry.role === "tool" && entry.activity ? (
          <ActivityRow
            key={entry.id}
            activity={entry.activity}
            live={false}
            approvalLabel={
              entry.activity.approval
                ? savedApprovalLabel(entry.activity.approval)
                : null
            }
          />
        ) : entry.role === "tool" ? (
          <ToolRow
            key={entry.id}
            call={savedToolToCall(entry.tool!, connectors)}
            live={false}
            approvalLabel={
              entry.tool!.approval
                ? savedApprovalLabel(entry.tool!.approval)
                : null
            }
          />
        ) : progress[index] ? (
          <ProgressNote key={entry.id} text={entry.text} streaming={false} />
        ) : (
          <div key={entry.id} className="answer markdown">
            <StreamingMarkdown text={entry.text} streaming={false} />
            {messageStateNote(entry) && (
              <p className="msg-foot">{messageStateNote(entry)}</p>
            )}
            <CopyTextButton text={entry.text} label="Copy answer" />
          </div>
        ),
      )}
      {card}
      {note && (
        <p className={failed ? "msg-foot tchat-failed" : "msg-foot"}>{note}</p>
      )}
      {usage && <p className="msg-foot">{usage}</p>}
    </>
  );
}

// A reply the model wrote before calling a tool: narration of what it is
// about to do, shown quietly between the tool rows and never offered as an
// answer to copy.
function ProgressNote({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <div className="progress-note markdown">
      <StreamingMarkdown text={text} streaming={streaming} />
    </div>
  );
}

// A live tool row with its write-tool approval, if any. A pending approval
// (not auto-answered) shows the card below the row; a settled one shows its
// outcome label on the row. An auto allow-for-chat shows the label, no card.
function ToolApprovalRow({
  call,
  pending,
  settled,
  onApprove,
  approvalBusy,
}: {
  call: ToolCall;
  pending: ApprovalView | null;
  settled: ApprovalView | null;
  onApprove: (approvalId: string, decision: ApprovalAnswer) => void;
  approvalBusy: string | null;
}) {
  const label =
    settled && settled.status !== "pending"
      ? approvalOutcomeLabel(settled.status)
      : null;
  return (
    <>
      <ToolRow call={call} live approvalLabel={label} />
      {pending && (
        <ApprovalCard
          approval={pending}
          connectorLabel={call.connector}
          busy={approvalBusy === pending.approvalId}
          onApprove={onApprove}
        />
      )}
    </>
  );
}

function LiveBody({
  live,
  run,
  connection,
  connectors,
  tenantId,
  onReconnect,
  onApprove,
  approvalBusy,
  files,
}: {
  live: LiveReply;
  run: ChatRun | null;
  connection: Connection;
  connectors: ConnectorRef[];
  tenantId: string;
  onReconnect: () => void;
  onApprove: (approvalId: string, decision: ApprovalAnswer) => void;
  approvalBusy: string | null;
  files: ChatFile[];
}) {
  const replies = replyItems(live);
  const writing = writingFiles(live);
  const slow = useSlow(live.since, replies.length === 0);
  const streaming = live.phase !== "settled";
  const note =
    connection === "reconnecting"
      ? "Reconnecting…"
      : live.saveFailed
        ? "Saving this reply failed. Trying again…"
        : PHASE_NOTE[live.phase];
  const outcome = live.outcome
    ? outcomeNote(live.outcome.status, live.outcome.error)
    : null;
  const lastReplyId = replies.at(-1)?.itemId;
  const progress = progressFlags(
    live.items.map((item) =>
      item.type === "command" ||
      item.type === "file_change" ||
      item.type === "skill" ||
      item.type === "network"
        ? "tool"
        : item.type,
    ),
  );
  return (
    <>
      {!live.items.length && streaming && (
        <ul className="steps" role="status">
          <li>
            <span className="spinner" aria-hidden="true" />
            {slow ? "Still working…" : "Working"}
          </li>
        </ul>
      )}
      {live.items.map((item, index) =>
        item.type === "reply" && progress[index] ? (
          <ProgressNote key={item.itemId} text={item.text} streaming={false} />
        ) : item.type === "reply" ? (
          <div key={item.itemId} className="answer markdown">
            <StreamingMarkdown text={item.text} streaming={streaming} />
            {streaming && item.itemId === lastReplyId && (
              <span className="caret" aria-hidden="true" />
            )}
            {/* Cut short by a steer Codex read; the model never saw it. */}
            {isCutShort(live, index) && (
              <p className="msg-foot">{LIVE_INTERRUPTED_NOTE}</p>
            )}
          </div>
        ) : item.type === "tool" ? (
          <ToolApprovalRow
            key={`tool:${item.itemId}`}
            call={{
              connector: connectorName(item.connector, connectors),
              tool: item.tool,
              status: item.status,
              durationMs: item.durationMs,
              errorCode: item.errorCode,
            }}
            pending={pendingApprovalForItem(live, item.itemId)}
            settled={approvalForItem(live, item.itemId)}
            onApprove={onApprove}
            approvalBusy={approvalBusy}
          />
        ) : item.type === "command" || item.type === "file_change" ? (
          <ActivityApprovalRow
            key={`activity:${item.itemId}`}
            activity={item}
            pending={pendingApprovalForItem(live, item.itemId)}
            settled={approvalForItem(live, item.itemId)}
            onApprove={onApprove}
            approvalBusy={approvalBusy}
          />
        ) : item.type === "skill" ? (
          <SkillRow key={`skill:${item.slug}`} name={item.name} />
        ) : item.type === "network" ? (
          <NetworkCard
            key={`network:${item.kind}:${item.host}:${item.method}`}
            block={item}
            messageId={null}
            runId={live.runId}
          />
        ) : (
          <SteerBubble
            key={`input:${item.clientMessageId}`}
            text={item.text ?? steerText(run, item.clientMessageId) ?? ""}
          />
        ),
      )}
      <FileCard
        runId={live.runId}
        files={files}
        writing={writing}
        unsaved={live.unsaved}
      />
      <ConnectorBanners
        failures={live.connectorFailures}
        connectors={connectors}
        tenantId={tenantId}
      />
      {outcome && (
        <p
          className={
            live.outcome?.status === "failed"
              ? "msg-foot tchat-failed"
              : "msg-foot"
          }
        >
          {outcome}
        </p>
      )}
      {connection === "lost" ? (
        <p className="msg-foot tchat-failed" role="alert">
          The connection to this reply was lost.{" "}
          <button type="button" className="text-btn" onClick={onReconnect}>
            Reconnect
          </button>
        </p>
      ) : (
        note && (
          <p className="msg-foot" role="status">
            {note}
          </p>
        )
      )}
    </>
  );
}

// New files the reply is still writing, for its file card.
function writingFiles(live: LiveReply): WritingFile[] {
  const out: WritingFile[] = [];
  for (const item of live.items)
    if (item.type === "file_change" && item.status === "inProgress")
      for (const file of item.files)
        if (file.kind === "add") out.push({ path: file.path });
  return out;
}

// True once a reply has shown nothing for SLOW_REPLY_MS.
function useSlow(since: number, empty: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!empty) return;
    const wait = since + SLOW_REPLY_MS - Date.now();
    if (wait <= 0) {
      setSlow(true);
      return;
    }
    const timer = setTimeout(() => setSlow(true), wait);
    return () => clearTimeout(timer);
  }, [since, empty]);
  return slow;
}
