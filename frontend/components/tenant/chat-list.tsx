"use client";
import { memo, useId, useState } from "react";
import { historyGroups, sessionTime } from "@/lib/sidebar";
import { useSidebarNow } from "@/lib/use-sidebar-clock";
import type { ChatSummary } from "@/lib/tenant-chat";
import { goalBadge } from "@/lib/tenant-goal";
import { Pulse } from "@/components/tx/live";
import { Pill } from "@/components/tx/pill";

// The sidebar history (DESIGN-SPEC 11.2): Today and Previous show; the older
// groups fold behind "View all conversations". Data comes in through props.
export const ChatList = memo(function ChatList({
  chats,
  activeId,
  unread,
  state,
  error,
  hasMore,
  loadingMore,
  onOpen,
  onRetry,
  onMore,
}: {
  chats: ChatSummary[];
  activeId: string | null;
  // Chats whose reply finished while another chat was open.
  unread?: ReadonlySet<string>;
  state: "loading" | "ready" | "error";
  error: string;
  hasMore: boolean;
  loadingMore: boolean;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onMore: () => void;
}) {
  const olderId = useId();
  // null until the person folds or opens it; then their choice holds.
  const [choice, setChoice] = useState<boolean | null>(null);
  const now = new Date(useSidebarNow());
  const groups = historyGroups(chats, (chat) => chat.lastMessageAt, now);
  const recent = groups.filter((group) => !group.older);
  const older = groups.filter((group) => group.older);
  // With nothing recent there is nothing to fold behind. An open chat in an
  // older group opens the fold, so the current row starts in view.
  const folds = recent.length > 0 && older.length > 0;
  const activeIsOlder = older.some((group) =>
    group.rows.some((chat) => chat.id === activeId),
  );
  const expanded = !folds || (choice ?? activeIsOlder);

  const group = (label: string, rows: ChatSummary[]) => (
    <div key={label} className="pt-rail-group" role="group" aria-label={label}>
      <div className="cs-side-label" aria-hidden="true">
        {label}
      </div>
      {rows.map((chat) => (
        <button
          key={chat.id}
          type="button"
          className="tx-btn tx-ghost pt-session cs-session"
          aria-current={chat.id === activeId ? "page" : undefined}
          data-unread={unread?.has(chat.id) || undefined}
          onClick={() => onOpen(chat.id)}
        >
          <span className="pt-session-title">{chat.title || "New chat"}</span>
          {unread?.has(chat.id) && <span className="tx-sr">, new reply</span>}
          {goalBadge(chat.goal) && (
            <Pill tone="line" size="sm" className="cs-goal-badge">
              {goalBadge(chat.goal)!.text}
            </Pill>
          )}
          {chat.activeRunId ? (
            <span className="pt-session-time" role="img" aria-label="Answering">
              <Pulse />
            </span>
          ) : (
            <span className="pt-session-time">
              {sessionTime(chat.lastMessageAt, now)}
            </span>
          )}
        </button>
      ))}
    </div>
  );

  if (state === "loading")
    return (
      <p className="cs-side-note" aria-busy="true">
        Loading conversations…
      </p>
    );
  if (state === "error")
    return (
      <p className="cs-side-note" role="alert">
        {error}{" "}
        <button
          type="button"
          className="tx-btn tx-ghost tx-xs cs-side-retry"
          onClick={onRetry}
        >
          Try again
        </button>
      </p>
    );
  if (chats.length === 0)
    return (
      <p className="cs-side-note">
        No conversations yet. They appear here once you send a message.
      </p>
    );

  const more = hasMore && expanded && (
    <button
      type="button"
      className="tx-btn tx-ghost tx-xs cs-view-all"
      onClick={onMore}
      disabled={loadingMore}
      aria-busy={loadingMore || undefined}
    >
      {loadingMore ? "Loading…" : "Show older conversations"}
    </button>
  );

  return (
    <>
      {recent.map((g) => group(g.label, g.rows))}
      {folds ? (
        <div className="cs-older" id={olderId} hidden={!expanded}>
          {older.map((g) => group(g.label, g.rows))}
          {more}
        </div>
      ) : (
        <>
          {older.map((g) => group(g.label, g.rows))}
          {more}
        </>
      )}
      {folds && (
        <button
          type="button"
          className="tx-btn tx-ghost tx-xs cs-view-all"
          aria-expanded={expanded}
          aria-controls={olderId}
          onClick={() => setChoice(!expanded)}
        >
          {expanded ? "Show less" : "View all conversations"}
        </button>
      )}
    </>
  );
});
