"use client";
import {
  memo,
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
        <div className="bubble">{message.text}</div>
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
  const title = approvalCardTitle(connectorLabel, approval.tool);
  const race =
    approval.race === "resolved"
      ? "Already answered"
      : approval.race === "not_found"
        ? "Expired"
        : null;
  return (
    <div
      ref={ref}
      className="approval-card"
      role="group"
      aria-label={title}
      tabIndex={-1}
    >
      <p className="approval-title">{title}</p>
      {approval.params.length > 0 && (
        <dl className="approval-params">
          {approval.params.map((p, i) => (
            <div key={`${p.name}:${i}`} className="approval-param">
              <dt>{p.name}</dt>
              {/* Plain text only: model-written, never rendered as HTML. */}
              <dd>{p.value}</dd>
            </div>
          ))}
        </dl>
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
          <button
            type="button"
            className="btn-soft"
            disabled={busy}
            onClick={() => onApprove(approval.approvalId, "allow_for_chat")}
          >
            Allow for this chat
          </button>
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
    </div>
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
}: {
  messages: ChatMessage[];
  run: ChatRun | null;
  agentName: string;
  hue: string;
  connectors: ConnectorRef[];
  onResend: (text: string) => void;
}) {
  const note = run ? outcomeNote(run.status, run.error) : null;
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
  const hasFooter = !!(note || usage);
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
}: {
  entries: ChatMessage[];
  connectors: ConnectorRef[];
  note: string | null;
  usage: string;
  failed: boolean;
}) {
  const progress = progressFlags(
    entries.map((m) => (m.role === "tool" ? "tool" : "reply")),
  );
  return (
    <>
      {entries.map((entry, index) =>
        entry.role === "tool" ? (
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
}: {
  live: LiveReply;
  run: ChatRun | null;
  connection: Connection;
  connectors: ConnectorRef[];
  tenantId: string;
  onReconnect: () => void;
  onApprove: (approvalId: string, decision: ApprovalAnswer) => void;
  approvalBusy: string | null;
}) {
  const replies = replyItems(live);
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
  const progress = progressFlags(live.items.map((item) => item.type));
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
        ) : (
          <SteerBubble
            key={`input:${item.clientMessageId}`}
            text={item.text ?? steerText(run, item.clientMessageId) ?? ""}
          />
        ),
      )}
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
