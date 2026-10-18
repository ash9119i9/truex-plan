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
  outcomeNote,
  SLOW_REPLY_MS,
  titleProblem,
  usageLine,
  type ChatMessage,
  type ChatRun,
  type ChatSummary,
  type ChatThread,
  type LiveReply,
} from "@/lib/tenant-chat";
import { Icon } from "@/components/v2/icon";
import {
  CopyTextButton,
  StreamingMarkdown,
} from "@/components/streaming-markdown";

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
}: {
  thread: ChatThread;
  live: LiveReply | null;
  connection: Connection;
  loadingOlder: boolean;
  olderError: string;
  onLoadOlder: () => void;
  onReconnect: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const exchanges = exchangesOf(thread);
  // A live reply with nothing saved yet gets its own row, keyed like the
  // exchange it becomes, so it is not remounted when its messages arrive.
  const shown =
    live && !exchanges.some((e) => e.runId === live.runId)
      ? [
          ...exchanges,
          { runId: live.runId, user: null, replies: [], run: null },
        ]
      : exchanges;
  const agent = thread.chat.agent;
  const agentName = agent?.name ?? "Assistant";
  const hue = tintOf(agent?.tint).bg;
  const liveText = live?.items.reduce((n, i) => n + i.text.length, 0) ?? 0;
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
  }, [thread.chat.id, firstId, thread.messages.length, liveText, live?.phase]);

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
            user={exchange.user}
            replies={exchange.replies}
            run={exchange.run}
            live={live?.runId === exchange.runId ? live : null}
            connection={connection}
            agentName={agentName}
            hue={hue}
            onReconnect={onReconnect}
          />
        ))}
      </div>
    </div>
  );
});

function Exchange({
  user,
  replies,
  run,
  live,
  connection,
  agentName,
  hue,
  onReconnect,
}: {
  user: ChatMessage | null;
  replies: ChatMessage[];
  run: ChatRun | null;
  live: LiveReply | null;
  connection: Connection;
  agentName: string;
  hue: string;
  onReconnect: () => void;
}) {
  return (
    <>
      {user && (
        <article className="msg user" aria-label="Your message">
          <div className="bubble-wrap">
            <div className="bubble">{user.text}</div>
          </div>
        </article>
      )}
      {live ? (
        <AgentReply agentName={agentName} hue={hue} live={live}>
          <LiveBody
            live={live}
            connection={connection}
            onReconnect={onReconnect}
          />
        </AgentReply>
      ) : (
        hasSavedReply(replies, run) && (
          <AgentReply agentName={agentName} hue={hue} live={null}>
            <SavedBody replies={replies} run={run} />
          </AgentReply>
        )
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

function hasSavedReply(replies: ChatMessage[], run: ChatRun | null): boolean {
  return replies.length > 0 || !!(run && outcomeNote(run.status, run.error));
}

// StreamingMarkdown is memoized on its text, so saved replies are not parsed
// again while another reply streams.
function SavedBody({
  replies,
  run,
}: {
  replies: ChatMessage[];
  run: ChatRun | null;
}) {
  const note = run ? outcomeNote(run.status, run.error) : null;
  const usage = run && isSettled(run.status) ? usageLine(run) : "";
  return (
    <>
      {replies.map((reply) => (
        <div key={reply.id} className="answer markdown">
          <StreamingMarkdown text={reply.text} streaming={false} />
          <CopyTextButton text={reply.text} label="Copy answer" />
        </div>
      ))}
      {note && (
        <p
          className={
            run?.status === "failed" ? "msg-foot tchat-failed" : "msg-foot"
          }
        >
          {note}
        </p>
      )}
      {usage && <p className="msg-foot">{usage}</p>}
    </>
  );
}

function LiveBody({
  live,
  connection,
  onReconnect,
}: {
  live: LiveReply;
  connection: Connection;
  onReconnect: () => void;
}) {
  const slow = useSlow(live.since, live.items.length === 0);
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
      {live.items.map((item, index) => (
        <div key={item.itemId} className="answer markdown">
          <StreamingMarkdown text={item.text} streaming={streaming} />
          {streaming && index === live.items.length - 1 && (
            <span className="caret" aria-hidden="true" />
          )}
        </div>
      ))}
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
