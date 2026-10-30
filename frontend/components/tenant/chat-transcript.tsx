"use client";
import {
  createContext,
  Fragment,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  duration,
  orderTurn,
  turnErrorOf,
  workFlag,
  workingLabel,
  workLabel,
  type Slot,
} from "@/lib/turn";
import Link from "next/link";
import { initials } from "@/components/auth/workspace-frame";
import { Button } from "@/components/tx/button";
import { RefChip } from "@/components/tx/chip";
import { stripSuggestions, type FollowUpItem } from "@/lib/suggestions";
import { FollowUpRows } from "./follow-up-rows";
import {
  exchangeKey,
  exchangesOf,
  helperApprovalNote,
  helperLabel,
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
  type ApprovalView,
  type ChatMessage,
  type ChatRun,
  type ChatThread,
  type HelperAgent,
  type HelperStatus,
  type RunError,
  type LiveReply,
} from "@/lib/tenant-chat";
import { Spin } from "@/components/tx/live";
import { Icon, type IconName } from "@/components/tx/icon";
import { mask } from "@/lib/mask";
import {
  approvalOutcomeLabel,
  connectorBanner,
  connectorName,
  savedApprovalLabel,
  humanizeToolName,
  sentence,
  toolStepName,
  type ApprovalAnswer,
  type ApprovalDecision,
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
  codingRequestName,
  writingNote,
  allowForChatHint,
  fileLabel,
  type Activity,
} from "@/lib/tenant-coding";
import { filesByRun, isImage, type ChatFile } from "@/lib/tenant-files";
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
import { DocumentCard } from "./document-card";
import { recordOf } from "@/lib/request-dock";
import { Receipt } from "./receipt";
import "@/styles/app/tools.css";

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

// One empty list for every reply without files, so its row keeps its props.
const NO_FILES: ChatFile[] = [];
const noop = () => undefined;

export const Transcript = memo(function Transcript({
  thread,
  live,
  connection,
  loadingOlder,
  olderError,
  onLoadOlder,
  onReconnect,
  onResend,
  onFollowUp,
  tenantId,
  files,
  onNewChat,
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
  // Sends a Follow Up row as the next message, recording where it came from.
  onFollowUp: (runId: string, item: FollowUpItem) => Promise<boolean>;
  // This tab's tenant, for the Connected tools reconnect link.
  tenantId: string;
  // Every stored file version of the chat; each reply shows its own.
  files: readonly ChatFile[];
  // Leaves for a new chat (a failed reply that can't be retried).
  onNewChat?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  // Memoized with the files and recover below so each saved exchange gets
  // the same props on every stream frame and `Exchange` skips it.
  const exchanges = useMemo(() => exchangesOf(thread), [thread]);
  const runFiles = useMemo(() => filesByRun(files), [files]);
  const recover = useMemo(() => ({ newChat: onNewChat ?? noop }), [onNewChat]);
  // A live reply with nothing saved yet gets its own row, keyed like the
  // exchange it becomes, so it is not remounted when its messages arrive.
  const shown =
    live && !exchanges.some((e) => e.runId === live.runId)
      ? [...exchanges, { runId: live.runId, messages: [], run: null }]
      : exchanges;
  const agent = thread.chat.agent;
  const agentName = agent?.name ?? "Assistant";
  const connectors = thread.chat.connectors;
  const liveText =
    live?.items.reduce(
      (n, i) => n + (i.type === "reply" ? i.text.length : 0),
      0,
    ) ?? 0;
  const firstId = thread.messages[0]?.id;
  // Rows only under the latest completed answer, with no reply running and
  // no read-only block. `live` covers streaming and pending approvals; the
  // last message check keeps a stopped/failed or steered-away answer quiet.
  const followUps = (() => {
    if (live || thread.chat.activeRunId || thread.chat.readOnly) return null;
    const last = shown.at(-1);
    if (!last?.run || last.run.status !== "completed") return null;
    const items = last.run.followUps?.items ?? [];
    const answer = last.messages.at(-1);
    if (
      !items.length ||
      !answer ||
      answer.role !== "assistant" ||
      answer.state !== "complete"
    )
      return null;
    return { runId: last.run.id, items };
  })();

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
      className="cs-scroll"
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
      <div className="cs-thread-in">
        <div className="cs-thread">
          {thread.hasMore && (
            <div className="cs-load-older">
              <Button
                size="sm"
                onClick={loadOlder}
                working={loadingOlder ? "Loading…" : undefined}
              >
                Load earlier messages
              </Button>
              {olderError && (
                <p className="cs-msg-note is-bad" role="alert">
                  {olderError}
                </p>
              )}
            </div>
          )}
          {shown.map((exchange, index) => (
            <Exchange
              key={exchangeKey(exchange)}
              messages={exchange.messages}
              run={exchange.run}
              live={live?.runId === exchange.runId ? live : null}
              connection={connection}
              agentName={agentName}
              connectors={connectors}
              tenantId={tenantId}
              onReconnect={onReconnect}
              onResend={onResend}
              followUps={index === shown.length - 1 ? followUps : null}
              model={thread.chat.model?.displayName ?? null}
              recover={
                index === shown.length - 1 &&
                !live &&
                !thread.chat.activeRunId &&
                !thread.chat.readOnly
                  ? recover
                  : null
              }
              onFollowUp={onFollowUp}
              files={runFiles.get(exchange.runId) ?? NO_FILES}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

// Memoized: while a reply streams, only its own row re-renders.
const Exchange = memo(function Exchange({
  messages,
  run,
  live,
  connection,
  agentName,
  connectors,
  tenantId,
  onReconnect,
  onResend,
  followUps,
  onFollowUp,
  files,
  recover,
  model,
}: {
  messages: ChatMessage[];
  run: ChatRun | null;
  live: LiveReply | null;
  connection: Connection;
  agentName: string;
  connectors: ConnectorRef[];
  tenantId: string;
  onReconnect: () => void;
  onResend: (text: string) => void;
  followUps: { runId: string; items: readonly FollowUpItem[] } | null;
  onFollowUp: (runId: string, item: FollowUpItem) => Promise<boolean>;
  // The files this reply stored (newest version of each path).
  files: ChatFile[];
  recover: Recover | null;
  model: string | null;
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
        <AgentReply
          agentName={agentName}
          live={live}
          runId={live.runId}
          time={clock(messages[0]?.createdAt)}
        >
          <LiveBody
            live={live}
            run={run}
            connection={connection}
            connectors={connectors}
            tenantId={tenantId}
            onReconnect={onReconnect}
            files={files}
          />
        </AgentReply>
      ) : (
        <SavedExchange
          messages={messages}
          run={run}
          agentName={agentName}
          connectors={connectors}
          onResend={onResend}
          followUps={followUps}
          onFollowUp={onFollowUp}
          files={files}
          recover={recover}
          model={model}
        />
      )}
    </>
  );
});

// A member's message (DESIGN-SPEC 11.7): files, the bubble, then "You · HH:MM".
// A `not_sent` steer — one the assistant never read — is labelled and offers
// to send the same text again.
function UserBubble({
  message,
  onResend,
}: {
  message: ChatMessage;
  onResend: (text: string) => void;
}) {
  const note = messageStateNote(message);
  const time = clock(message.createdAt);
  return (
    <article className="cs-msg cs-msg-user" aria-label="Your message">
      {message.attachments && (
        <SentFiles runId={message.runId} files={message.attachments} />
      )}
      {message.text && <div className="pt-bubble">{message.text}</div>}
      <span className="pt-meta">You{time && ` · ${time}`}</span>
      {message.state === "not_sent" && (
        <p className="cs-msg-note cs-notsent">
          {note}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onResend(message.text)}
          >
            Resend
          </Button>
        </p>
      )}
    </article>
  );
}

// "HH:MM" in the reader's clock, or "" for a missing or bad date.
function clock(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
        <div className="dc-stack is-sent" aria-label="Attached files">
          {others.map((file, i) => (
            <DocumentCard
              key={file.fileId || `${i}:${file.name}`}
              name={file.name}
              size={file.size}
              state="ready"
              onOpen={open(file)}
            />
          ))}
        </div>
      )}
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
      <DocumentCard
        name={file.name}
        size={file.size}
        state="ready"
        onOpen={onOpen}
      />
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

// A steer shown inside the running reply before it is saved (DESIGN-SPEC
// 11.8): the member's bubble, in the reply's asks slot, marked as joining it.
function SteerBubble({ text }: { text: string }) {
  return (
    <div className="cs-msg-user is-steer">
      <div className="pt-bubble">{text}</div>
      <span className="pt-meta">You · added to this turn</span>
    </div>
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

// One step in a reply's work (DESIGN-SPEC 12.2, ToolActivityRow): a glyph and
// a word for its state, "‹Connector› · ‹Tool›", one extra line, and its time.
// Business-safe: never the raw call. The visible time and glyph are hidden from
// assistive technology; a sentence carries the state instead. Only a live
// running row is a status region (it announces when it settles).
// "waiting": still in progress, held on its approval card (warn, not live).
type StepState =
  "running" | "waiting" | "done" | "failed" | "declined" | "stopped";

const STEP_GLYPH: Record<StepState, IconName | null> = {
  running: null,
  waiting: "hand",
  done: "check",
  failed: "alert",
  declined: "ban",
  stopped: "stop",
};

function StepRow({
  state,
  name,
  sub,
  time,
  spoken,
  live,
  children,
}: {
  state: StepState;
  name: string;
  sub?: string | null;
  time?: string;
  spoken: string;
  live: boolean;
  children?: ReactNode;
}) {
  const glyph = STEP_GLYPH[state];
  return (
    <div
      className={`ta is-${state}`}
      role={
        live && (state === "running" || state === "waiting")
          ? "status"
          : undefined
      }
    >
      <span className="ta-ic" aria-hidden="true">
        {glyph ? <Icon name={glyph} size="sm" /> : <Spin />}
      </span>
      <span className="ta-main">
        <span className="ta-name">{name}</span>
        {sub && <span className="ta-sub">{sub}</span>}
      </span>
      {time && (
        <span className="ta-time num" aria-hidden="true">
          {time}
        </span>
      )}
      {/* the visible sub-line already says it: don't announce it twice */}
      {spoken !== sub && <span className="tx-sr">{spoken}</span>}
      {children}
    </div>
  );
}

// How a settled step ended, for the work fold's flag; `ended` marks a reply
// that is over, so a step still running there was stopped.
function toolOutcome(
  status: ToolCall["status"],
  errorCode: ToolCall["errorCode"],
  ended: boolean,
): Part["outcome"] {
  if (status === "inProgress") return ended ? "stopped" : undefined;
  if (status === "failed")
    return errorCode === "REFUSED" ? "declined" : "failed";
  return undefined;
}
function activityOutcome(
  status: Activity["status"],
  ended: boolean,
): Part["outcome"] {
  if (status === "inProgress") return ended ? "stopped" : undefined;
  if (status === "failed" || status === "declined") return status;
  return undefined;
}

export function ToolRow({
  call,
  live,
  approvalLabel,
  asking = false,
  stopped = false,
}: {
  call: ToolCall;
  live: boolean;
  approvalLabel?: string | null;
  /** Its approval card is open in the dock. */
  asking?: boolean;
  /** The reply ended while this call still ran. */
  stopped?: boolean;
}) {
  const state: StepState =
    call.status === "inProgress"
      ? stopped
        ? "stopped"
        : asking
          ? "waiting"
          : "running"
      : call.status === "completed"
        ? "done"
        : call.errorCode === "REFUSED"
          ? "declined"
          : "failed";
  const time = duration(call.durationMs);
  const sub =
    state === "stopped"
      ? "Stopped by you before it finished"
      : state === "declined"
        ? "Not allowed"
        : state === "failed"
          ? call.errorCode === "TIMEOUT"
            ? "It took too long"
            : "The tool call failed."
          : state === "waiting"
            ? "Waiting for your approval"
            : approvalLabel;
  const spoken =
    state === "waiting"
      ? "Waiting for your approval"
      : state === "running"
        ? "Running"
        : state === "done"
          ? time
            ? `Done in ${time}`
            : "Done"
          : state === "failed"
            ? `Failed: ${sub}`
            : state === "declined"
              ? "Not allowed"
              : "Stopped";
  return (
    <StepRow
      state={state}
      name={toolStepName(call.connector, call.tool)}
      sub={sub}
      time={state === "running" || state === "waiting" ? undefined : time}
      spoken={spoken}
      live={live}
    />
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
        <Icon name="lock" size="sm" className="tool-card-icon" />
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
                className="tx-btn"
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
            className="tx-btn tx-primary"
            disabled={busy}
            onClick={() => actions!.answer(messageId, "allow_once")}
          >
            Allow once
          </button>
          {block.grant === "chat" && (
            <button
              type="button"
              className="tx-btn"
              disabled={busy}
              onClick={() => actions!.answer(messageId, "allow_for_chat")}
            >
              Allow for this chat
            </button>
          )}
          <button
            type="button"
            className="tx-btn tx-danger"
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
        <p className="tx-hint tx-errmsg" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// The helper agents the lead started, as one group placed before its final
// answer (live and saved alike). Results are model-written: plain text only.
export function HelperGroup({
  helpers,
  live,
}: {
  helpers: readonly (HelperAgent & { key: string })[];
  live: boolean;
}) {
  if (!helpers.length) return null;
  const running = helpers.filter((h) => h.status === "running").length;
  const noun = (n: number) => (n === 1 ? "helper" : "helpers");
  const count = (status: HelperStatus) =>
    helpers.filter((h) => h.status === status).length;
  const flag = [
    count("failed") && `${count("failed")} failed`,
    count("stopped") && `${count("stopped")} stopped`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className={live ? "hg is-live" : "hg"} aria-label="Helpers">
      <p className="hg-head">
        {running ? <Spin /> : <Icon name="agent" size="sm" />}
        <span className="hg-title" role={live ? "status" : undefined}>
          {running
            ? `Running ${helpers.length} ${noun(helpers.length)}`
            : `Used ${helpers.length} ${noun(helpers.length)}`}
        </span>
        {flag && <span className="hg-flag">{flag}</span>}
      </p>
      <ul className="hg-lanes">
        {helpers.map((helper, index) => (
          <HelperLane key={helper.key} helper={helper} slot={index} />
        ))}
      </ul>
    </section>
  );
}

const LANE: Record<
  HelperStatus,
  { css: string; word: string; glyph: IconName | null }
> = {
  running: { css: "is-running", word: "Running", glyph: null },
  completed: { css: "is-done", word: "Done", glyph: "check" },
  failed: { css: "is-failed", word: "Failed", glyph: "x" },
  stopped: { css: "is-stopped", word: "Stopped", glyph: "stop" },
};

// One helper's lane: its identity tile (slots 1–5 by first appearance, then
// neutral), name and state, what it is doing now, and its result.
function HelperLane({ helper, slot }: { helper: HelperAgent; slot: number }) {
  const name = sentence(helperLabel(helper.path));
  const lane = LANE[helper.status];
  const id = slot < 5 ? `--id-${slot + 1}` : "--id-main";
  return (
    <li className={`hg-lane ${lane.css}`}>
      <span
        className="hg-tile"
        style={
          {
            "--hg-soft": `var(${id}-soft)`,
            "--hg-ink": `var(${id}-ink)`,
          } as CSSProperties
        }
        aria-hidden="true"
      >
        <Icon name="bot" size="sm" />
      </span>
      <span className="hg-who" aria-hidden="true">
        <span className="hg-name">{name}</span>
        <span className={`hg-badge ${lane.css}`}>
          {lane.glyph ? <Icon name={lane.glyph} size="sm" /> : <Spin />}
          {lane.word}
        </span>
      </span>
      <span className="tx-sr">
        {name}: {lane.word.toLowerCase()}.
      </span>
      {helper.status === "running" && helper.preview && (
        <span className="hg-preview">{mask(helper.preview)}</span>
      )}
      {helper.status === "failed" && !helper.result && (
        <span className="hg-error">The helper stopped before finishing.</span>
      )}
      {helper.result && (
        <details className="hg-result">
          <summary>Result</summary>
          <p>{helper.result}</p>
        </details>
      )}
    </li>
  );
}

// A skill the reply used. Only its name: what the model read stays private.
function SkillRow({ name }: { name: string }) {
  return (
    <StepRow
      state="done"
      name={`Used skill ${name}`}
      spoken="Done"
      live={false}
    />
  );
}

// One command or file change in the chat's workspace, live or saved. The
// command and its output are model-written: plain text, never HTML. Both sit
// behind Details so a long test run does not push the answer away.
export function ActivityRow({
  activity,
  live,
  approvalLabel,
  asking = false,
  stopped = false,
}: {
  activity: Activity;
  live: boolean;
  approvalLabel?: string | null;
  // Its approval card is open and already shows the command.
  asking?: boolean;
  /** The reply ended while this step still ran. */
  stopped?: boolean;
}) {
  const state: StepState =
    activity.status === "inProgress"
      ? stopped
        ? "stopped"
        : asking
          ? "waiting"
          : "running"
      : activity.status === "completed"
        ? "done"
        : activity.status === "declined"
          ? "declined"
          : "failed";
  const note = writingNote(activity);
  const time =
    activity.type === "command" && state !== "running" && state !== "waiting"
      ? duration(activity.durationMs)
      : "";
  const sub =
    state === "stopped"
      ? "Stopped by you before it finished"
      : state === "waiting"
        ? "Waiting for your approval"
        : state === "declined"
          ? "Not allowed"
          : [approvalLabel, note].filter(Boolean).join(" · ") || null;
  return (
    <StepRow
      state={state}
      name={mask(activityLabel(activity))}
      sub={sub}
      time={time}
      spoken={
        state === "waiting"
          ? "Waiting for your approval"
          : state === "running"
            ? "Running"
            : state === "done"
              ? time
                ? `Done in ${time}`
                : "Done"
              : state === "declined"
                ? "Not allowed"
                : state === "stopped"
                  ? "Stopped"
                  : "Failed"
      }
      live={live}
    >
      {activity.type === "command"
        ? // The row names the step; the command and its output are details
          // (12.2). While its approval card is open, the card shows them.
          !asking && (
            <details className="ta-details">
              <summary className="ta-toggle">
                Details
                <Icon name="chev-down" size="sm" className="ta-chev" />
              </summary>
              <span className="ta-label">Command</span>
              <pre>{mask(activity.command)}</pre>
              {activity.output && (
                <>
                  <span className="ta-label">
                    Output{activity.outputTruncated ? " (cut short)" : ""}
                  </span>
                  <pre>{mask(activity.output)}</pre>
                </>
              )}
            </details>
          )
        : activity.files.length > 1 && (
            <ul className="ta-files">
              {activity.files.map((file, i) => (
                <li key={`${file.path}:${i}`}>{mask(fileLabel(file))}</li>
              ))}
            </ul>
          )}
    </StepRow>
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
          <Icon name="plug" size="sm" />
          <span className="grow">{banner.message}</span>
          {banner.reconnect && (
            <Link className="link" href={`/t/${tenantId}/connected-tools`}>
              Reconnect
            </Link>
          )}
        </div>
      ))}
    </>
  );
}

// How the latest failed reply can be recovered from (TurnError's action).
type Recover = { newChat: () => void };

// A settled run's saved messages in seq order: member bubbles and assistant
// replies, interleaved, with the run's note and usage after the last reply.
function SavedExchange({
  messages,
  run,
  agentName,
  connectors,
  onResend,
  followUps,
  onFollowUp,
  files,
  recover,
  model,
}: {
  messages: ChatMessage[];
  run: ChatRun | null;
  agentName: string;
  connectors: ConnectorRef[];
  onResend: (text: string) => void;
  followUps: { runId: string; items: readonly FollowUpItem[] } | null;
  onFollowUp: (runId: string, item: FollowUpItem) => Promise<boolean>;
  files: ChatFile[];
  /** The latest reply's way out of a failure; null on older replies. */
  recover: Recover | null;
  /** The chat's model, for the receipt. */
  model: string | null;
}) {
  const failed = run?.status === "failed";
  const note = run && !failed ? outcomeNote(run.status, run.error) : null;
  const lastAsk = messages.findLast((m) => m.role === "user")?.text;
  const error =
    run && failed ? (
      <TurnError
        runId={run.id}
        error={run.error}
        onRetry={recover && lastAsk ? () => onResend(lastAsk) : undefined}
        onNewChat={recover?.newChat}
      />
    ) : null;
  const card =
    run && (files.length > 0 || run.unsavedFiles?.length) ? (
      <FileCard
        runId={run.id}
        files={files}
        writing={[]}
        unsaved={run.unsavedFiles}
      />
    ) : null;
  // The settled run's receipt: its time, tokens and model, opening the trace.
  const usage =
    run && isSettled(run.status) ? (
      <Receipt
        run={run}
        model={model}
        steps={messages.filter((m) => m.role === "tool" && !m.agent).length}
        helpers={messages.filter((m) => m.agent).length}
      />
    ) : null;
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
  const hasFooter = !!(note || usage || card || error);
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
            live={null}
            runId={block.messages[0].runId}
            time={clock(block.messages[0].createdAt)}
          >
            <SavedBody
              entries={block.messages}
              connectors={connectors}
              note={index === lastAgentIndex ? note : null}
              usage={index === lastAgentIndex ? usage : null}
              error={index === lastAgentIndex ? error : null}
              card={index === lastAgentIndex ? card : null}
              followUps={
                index === lastAgentIndex && followUps ? (
                  <FollowUpRows
                    items={followUps.items}
                    onSelect={(item) => onFollowUp(followUps.runId, item)}
                  />
                ) : null
              }
            />
          </AgentReply>
        ),
      )}
      {showLooseFooter && (
        <AgentReply agentName={agentName} live={null} runId={run?.id}>
          <SavedBody
            entries={[]}
            connectors={connectors}
            note={note}
            usage={usage}
            error={error}
            card={card}
          />
        </AgentReply>
      )}
    </>
  );
}

// One reply's frame (DESIGN-SPEC 11.7): the agent's head, then the slots under
// it. A live reply and its saved copy share it, so the reply is not remounted
// (and its entrance animation not replayed) when it settles.
export function AgentReply({
  agentName,
  live,
  time,
  runId,
  children,
}: {
  agentName: string;
  live: LiveReply | null;
  /** The run this reply belongs to (the Activity Panel's "Show in chat"). */
  runId?: string;
  /** When the reply started, "HH:MM". */
  time?: string;
  children: ReactNode;
}) {
  const streaming = !!live && live.phase !== "settled";
  return (
    <article
      className={
        streaming ? "cs-msg cs-msg-agent is-streaming" : "cs-msg cs-msg-agent"
      }
      aria-label={`${agentName} reply`}
      aria-busy={streaming || undefined}
      data-run={runId}
      tabIndex={-1}
    >
      <header className="pt-agent-head">
        <span className="cs-agent-av" aria-hidden="true">
          {initials(agentName)}
        </span>
        <span className="pt-agent-name">{agentName}</span>
        {time && <span className="pt-agent-meta num">{time}</span>}
      </header>
      <div className="cs-msg-body">{children}</div>
    </article>
  );
}

// The work a reply did (tool rows and the narration between them), folded
// under one summary (DESIGN-SPEC 10.3, 12): open while anything runs, closed
// once it is done, until the reader opens or closes it themselves.
function WorkFold({
  steps,
  running,
  waiting,
  flag,
  children,
}: {
  steps: number;
  running: number;
  /** A step is held on its approval card: open, with the warn hand. */
  waiting: boolean;
  flag: string;
  children: ReactNode;
}) {
  const active = running > 0 || waiting;
  const [open, setOpen] = useState(active);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpen(active);
  }, [active]);
  return (
    <details
      className="cs-work"
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        if (now === open) return;
        touched.current = true;
        setOpen(now);
      }}
    >
      <summary className="cs-work-sum">
        {waiting ? (
          <Icon name="hand" size="sm" className="cs-work-ic is-warn" />
        ) : running > 0 ? (
          <Spin />
        ) : (
          <Icon
            name={flag ? "alert" : "check"}
            size="sm"
            className={flag ? "cs-work-ic is-warn" : "cs-work-ic"}
          />
        )}
        {/* the working line below already says "Waiting for you" */}
        <span>{workLabel(steps, running + (waiting ? 1 : 0))}</span>
        {flag && <span className="cs-work-flag">{flag}</span>}
        <Icon name="chev-down" size="sm" className="cs-work-chev" />
      </summary>
      <div className="cs-work-log">{children}</div>
    </details>
  );
}

// A reply's parts in slot order, with the work folded. `parts` are in stream
// order; each says its slot and whether it is a work step that is running.
type Part = {
  key: string;
  slot: Slot;
  node: ReactNode;
  /** A tool, command or other step (narration is work but not a step). */
  step?: boolean;
  running?: boolean;
  /** Still in progress, held on its approval card. */
  waiting?: boolean;
  /** How a settled step ended, for the fold's flag. */
  outcome?: "failed" | "declined" | "stopped";
};

function Slots({ parts }: { parts: Part[] }) {
  const ordered = orderTurn(parts, (part) => part.slot);
  const work = ordered.filter((part) => part.slot === "tools");
  const steps = work.filter((part) => part.step);
  const running = steps.filter((part) => part.running).length;
  const waiting = steps.some((part) => part.waiting);
  const count = (outcome: Part["outcome"]) =>
    steps.filter((part) => part.outcome === outcome).length;
  const flag = workFlag({
    failed: count("failed"),
    declined: count("declined"),
    stopped: count("stopped"),
  });
  const out: ReactNode[] = [];
  let workShown = false;
  for (const part of ordered) {
    if (part.slot !== "tools")
      out.push(<Fragment key={part.key}>{part.node}</Fragment>);
    else if (!workShown) {
      workShown = true;
      // One call and nothing else: no fold head, the row shows directly.
      if (work.length === 1 && steps.length === 1) {
        out.push(
          <div key="work" className="cs-work is-solo">
            {work[0].node}
          </div>,
        );
        continue;
      }
      out.push(
        <WorkFold
          key="work"
          steps={steps.length}
          running={running}
          waiting={waiting}
          flag={flag}
        >
          {work.map((w) => (
            <Fragment key={w.key}>{w.node}</Fragment>
          ))}
        </WorkFold>,
      );
    }
  }
  return <>{out}</>;
}

// StreamingMarkdown is memoized on its text, so saved replies are not parsed
// again while another reply streams. The run's footer (note and usage) is
// passed in so it sits after the last reply of the exchange.
export function SavedBody({
  entries,
  connectors,
  note,
  usage,
  error,
  card,
  followUps,
}: {
  entries: ChatMessage[];
  connectors: ConnectorRef[];
  note: string | null;
  /** The run's receipt line, under its last reply. */
  usage: ReactNode;
  /** A failed run's TurnError, where the answer would be (11.7 slot 9). */
  error?: ReactNode;
  // The reply's file card, after its last paragraph.
  card: ReactNode;
  // Follow Up rows, under the latest completed answer only.
  followUps?: ReactNode;
}) {
  const progress = progressFlags(
    entries.map((m) => (m.role === "tool" ? "tool" : "reply")),
  );
  // Helper rows are saved together; they render as one group.
  const helpers = entries.flatMap((m) =>
    m.agent ? [{ ...m.agent, key: m.id }] : [],
  );
  const parts: Part[] = [];
  if (helpers.length)
    parts.push({
      key: "helpers",
      slot: "helpers",
      node: <HelperGroup helpers={helpers} live={false} />,
    });
  entries.forEach((entry, index) => {
    if (entry.agent) return;
    if (entry.role === "tool" && entry.network)
      parts.push({
        key: entry.id,
        slot: "asks",
        node: (
          <NetworkCard
            block={entry.network}
            messageId={entry.id}
            runId={entry.runId}
          />
        ),
      });
    else if (entry.role === "tool")
      parts.push({
        key: entry.id,
        slot: "tools",
        step: true,
        outcome: entry.activity
          ? activityOutcome(entry.activity.status, true)
          : entry.tool
            ? toolOutcome(entry.tool.status, entry.tool.errorCode, true)
            : undefined,
        node: entry.skill ? (
          <SkillRow name={entry.skill.name} />
        ) : entry.activity ? (
          <ActivityRow
            activity={entry.activity}
            live={false}
            stopped
            approvalLabel={
              entry.activity.approval
                ? savedApprovalLabel(entry.activity.approval)
                : null
            }
          />
        ) : (
          <ToolRow
            call={savedToolToCall(entry.tool!, connectors)}
            live={false}
            stopped
            approvalLabel={
              entry.tool!.approval
                ? savedApprovalLabel(entry.tool!.approval)
                : null
            }
          />
        ),
      });
    if (entry.role === "tool") {
      const decision = entry.network
        ? null
        : (entry.tool?.approval ?? entry.activity?.approval);
      if (decision)
        parts.push({
          key: `record:${entry.id}`,
          slot: "asks",
          node: (
            <ApprovalRecord
              id={entry.id}
              decision={decision}
              title={
                entry.tool
                  ? toolStepName(
                      connectorName(entry.tool.connector, connectors),
                      entry.tool.name,
                    )
                  : codingRequestName(entry.activity!.type)
              }
            />
          ),
        });
      return;
    }
    if (progress[index])
      parts.push({
        key: entry.id,
        slot: "tools",
        node: <ProgressNote text={entry.text} streaming={false} />,
      });
    else
      parts.push({
        key: entry.id,
        slot: "body",
        node: (
          <div className="pt-answer-body markdown">
            <StreamingMarkdown
              text={stripSuggestions(entry.text)}
              streaming={false}
            />
            {messageStateNote(entry) && (
              <p className="cs-msg-note">{messageStateNote(entry)}</p>
            )}
            <CopyTextButton
              text={stripSuggestions(entry.text)}
              label="Copy answer"
            />
          </div>
        ),
      });
  });
  // The turn's outcome (Stopped) is an ask-slot notice, above the answer.
  if (note)
    parts.push({
      key: "outcome",
      slot: "asks",
      node: <p className="cs-msg-note">{note}</p>,
    });
  return (
    <>
      <Slots parts={parts} />
      {error}
      {card}
      {usage}
      {followUps}
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
      <StreamingMarkdown
        text={stripSuggestions(text, streaming)}
        streaming={streaming}
      />
    </div>
  );
}

export function LiveBody({
  live,
  run,
  connection,
  connectors,
  tenantId,
  onReconnect,
  files,
}: {
  live: LiveReply;
  run: ChatRun | null;
  connection: Connection;
  connectors: ConnectorRef[];
  tenantId: string;
  onReconnect: () => void;
  files: ChatFile[];
}) {
  const writing = writingFiles(live);
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
  // The answer's replies (not narration before a tool): the caret trails the
  // last one (.is-live), and the working indicator shows until one has text.
  const answers = live.items.flatMap((item, index) =>
    item.type === "reply" && !progress[index] ? [item] : [],
  );
  const lastAnswerId = answers.at(-1)?.itemId ?? null;
  const answered = answers.some((item) => item.text.length > 0);
  const slow = useSlow(live.since, !answered);
  const runningTool = live.items.findLast(
    (item) => item.type === "tool" && item.status === "inProgress",
  );
  const waiting = Object.values(live.approvals).some(
    (approval) => approval.status === "pending",
  );
  const working = workingLabel({
    waiting,
    helpers: live.helpers.filter((h) => h.status === "running").length,
    tool:
      runningTool?.type === "tool"
        ? toolStepName(
            connectorName(runningTool.connector, connectors),
            runningTool.tool,
          )
        : null,
    slow,
  });
  const parts: Part[] = [];
  if (live.helpers.length)
    parts.push({
      key: "helpers",
      slot: "helpers",
      node: (
        <HelperGroup
          helpers={live.helpers.map((h) => ({ ...h, key: h.agentId }))}
          live={streaming}
        />
      ),
    });
  live.items.forEach((item, index) => {
    if (item.type === "reply" && progress[index])
      parts.push({
        key: item.itemId,
        slot: "tools",
        node: <ProgressNote text={item.text} streaming={false} />,
      });
    else if (item.type === "reply")
      parts.push({
        key: item.itemId,
        slot: "body",
        node: (
          <div
            className={
              streaming && item.itemId === lastAnswerId
                ? "pt-answer-body markdown is-live"
                : "pt-answer-body markdown"
            }
          >
            <StreamingMarkdown
              text={stripSuggestions(item.text, streaming)}
              streaming={streaming}
            />
            {/* Cut short by a steer Codex read; the model never saw it. */}
            {isCutShort(live, index) && (
              <p className="cs-msg-note">{LIVE_INTERRUPTED_NOTE}</p>
            )}
          </div>
        ),
      });
    else if (item.type === "tool") {
      const settled = approvalForItem(live, item.itemId);
      const pending = pendingApprovalForItem(live, item.itemId);
      parts.push({
        key: `tool:${item.itemId}`,
        slot: "tools",
        step: true,
        running: streaming && item.status === "inProgress" && !pending,
        waiting: streaming && item.status === "inProgress" && !!pending,
        outcome: toolOutcome(item.status, item.errorCode, !streaming),
        node: (
          <ToolRow
            call={{
              connector: connectorName(item.connector, connectors),
              tool: item.tool,
              status: item.status,
              durationMs: item.durationMs,
              errorCode: item.errorCode,
            }}
            live
            stopped={!streaming}
            approvalLabel={
              settled && settled.status !== "pending"
                ? approvalOutcomeLabel(settled.status)
                : null
            }
            asking={!!pending}
          />
        ),
      });
      if (settled && settled.status !== "pending")
        parts.push({
          key: `record:${item.itemId}`,
          slot: "asks",
          node: (
            <ApprovalRecord
              id={item.itemId}
              decision={settled.status}
              title={toolStepName(
                connectorName(item.connector, connectors),
                item.tool,
              )}
            />
          ),
        });
    } else if (item.type === "command" || item.type === "file_change") {
      const settled = approvalForItem(live, item.itemId);
      const pending = pendingApprovalForItem(live, item.itemId);
      parts.push({
        key: `activity:${item.itemId}`,
        slot: "tools",
        step: true,
        running: streaming && item.status === "inProgress" && !pending,
        waiting: streaming && item.status === "inProgress" && !!pending,
        outcome: activityOutcome(item.status, !streaming),
        node: (
          <ActivityRow
            activity={item}
            live
            stopped={!streaming}
            approvalLabel={
              settled && settled.status !== "pending"
                ? approvalOutcomeLabel(settled.status)
                : null
            }
            asking={!!pending}
          />
        ),
      });
      if (settled && settled.status !== "pending")
        parts.push({
          key: `record:${item.itemId}`,
          slot: "asks",
          node: (
            <ApprovalRecord
              id={item.itemId}
              decision={settled.status}
              title={codingRequestName(item.type)}
            />
          ),
        });
    } else if (item.type === "skill")
      parts.push({
        key: `skill:${item.slug}`,
        slot: "tools",
        step: true,
        node: <SkillRow name={item.name} />,
      });
    else if (item.type === "network")
      parts.push({
        key: `network:${item.kind}:${item.host}:${item.method}`,
        slot: "asks",
        node: <NetworkCard block={item} messageId={null} runId={live.runId} />,
      });
    else
      parts.push({
        key: `input:${item.clientMessageId}`,
        slot: "asks",
        node: (
          <SteerBubble
            text={item.text ?? steerText(run, item.clientMessageId) ?? ""}
          />
        ),
      });
  });
  if (live.outcome?.status !== "failed" && outcome)
    parts.push({
      key: "outcome",
      slot: "asks",
      node: <p className="cs-msg-note">{outcome}</p>,
    });
  return (
    <>
      <Slots parts={parts} />
      {streaming && !answered && (
        // Held on a request, nothing is working: the warn hand, no motion.
        <p
          className={waiting ? "cs-working is-waiting" : "cs-working"}
          role="status"
        >
          {waiting ? <Icon name="hand" size="sm" /> : <Spin />}
          <span className={waiting ? undefined : "tx-shimmer"}>{working}</span>
        </p>
      )}
      {live.outcome?.status === "failed" && (
        <TurnError runId={live.runId} error={live.outcome.error} />
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
      {connection === "lost" ? (
        <p className="cs-msg-note is-bad" role="alert">
          The connection to this reply was lost.{" "}
          <Button size="xs" variant="ghost" onClick={onReconnect}>
            Reconnect
          </Button>
        </p>
      ) : (
        note && (
          <p className="cs-msg-note" role="status">
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

// A failed reply, inline where the answer would be (DESIGN-SPEC 12.5): what
// failed, the platform's message through the shared masker, the one action
// (only on the latest reply), and a reference that copies itself.
export function TurnError({
  runId,
  error,
  onRetry,
  onNewChat,
}: {
  runId: string;
  error: RunError | null;
  onRetry?: () => void;
  onNewChat?: () => void;
}) {
  const view = turnErrorOf(error);
  return (
    <div className="te" role="alert">
      <p className="te-head">
        <Icon name="alert" size="sm" />
        <span className="te-title">{view.title}</span>
      </p>
      <p className="te-body">
        {mask(error?.message ?? "This reply failed. Try again.")}
      </p>
      <div className="te-foot">
        {view.action === "retry" && onRetry && (
          <Button size="sm" icon="retry" onClick={onRetry}>
            Try again
          </Button>
        )}
        {view.action === "new" && onNewChat && (
          <Button size="sm" onClick={onNewChat}>
            Start a new chat
          </Button>
        )}
        <RefChip value={`${runId} · ${view.code} · failed`} label="reference" />
      </div>
    </div>
  );
}

// A settled request's audit row in the reply's asks slot (DESIGN-SPEC 13.6).
// The platform records the decision but not who answered or when, so the
// foot says only "You answered" or "Closed".
export function ApprovalRecord({
  id,
  title,
  decision,
}: {
  id: string;
  title: string;
  decision: ApprovalDecision;
}) {
  const view = recordOf(decision);
  const glyph: IconName =
    view.tone === "ok" ? "check" : decision === "deny" ? "ban" : "clock";
  return (
    <div
      className="ar"
      role="group"
      aria-label="Your decision"
      id={`approval-${id}`}
    >
      <span className="ar-k">Your decision</span>
      <span className="ar-row">
        <span className={`ar-dot is-${view.tone}`} aria-hidden="true" />
        <span className="ar-title">{title}</span>
        <span className={`ar-badge is-${view.tone}`}>
          <Icon name={glyph} size="sm" />
          {view.badge}
        </span>
      </span>
      <span className="ar-foot">{view.summary}</span>
    </div>
  );
}
