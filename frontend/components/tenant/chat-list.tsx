"use client";
import { memo } from "react";
import { convoGroup, convoTime } from "@/lib/sidebar";
import { useSidebarDay } from "@/lib/use-sidebar-clock";
import type { ChatSummary } from "@/lib/tenant-chat";
import { Icon } from "@/components/v2/icon";

// The sidebar (Layout & shell §3): a new-chat button and the member's chats,
// newest activity first. Data comes in through props; nothing is fetched here.
export const ChatList = memo(function ChatList({
  chats,
  activeId,
  state,
  error,
  hasMore,
  loadingMore,
  onOpen,
  onNew,
  onRetry,
  onMore,
}: {
  chats: ChatSummary[];
  activeId: string | null;
  state: "loading" | "ready" | "error";
  error: string;
  hasMore: boolean;
  loadingMore: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
  onMore: () => void;
}) {
  const now = new Date(useSidebarDay());
  const today = chats.filter(
    (c) => convoGroup(c.lastMessageAt, now) === "Today",
  );
  const earlier = chats.filter(
    (c) => convoGroup(c.lastMessageAt, now) !== "Today",
  );
  const rows = (list: ChatSummary[]) =>
    list.map((chat) => {
      const active = chat.id === activeId;
      return (
        <div
          key={chat.id}
          className={active ? "convo-row is-active" : "convo-row"}
        >
          <button
            type="button"
            className={active ? "convo is-active" : "convo"}
            aria-current={active ? "page" : undefined}
            onClick={() => onOpen(chat.id)}
          >
            <span className="convo-title">{chat.title || "New chat"}</span>
            <span className="convo-time">
              {chat.activeRunId ? (
                <span
                  className="pulse tchat-pulse"
                  role="img"
                  aria-label="Answering"
                />
              ) : (
                convoTime(chat.lastMessageAt, now)
              )}
            </span>
          </button>
        </div>
      );
    });

  return (
    <>
      <button
        type="button"
        className="btn-new"
        onClick={onNew}
        aria-current={activeId === null ? "page" : undefined}
      >
        <Icon name="plus" size={16} stroke={2} />
        New chat
      </button>
      <nav className="side-scroll" aria-label="Chats">
        {state === "loading" && (
          <p className="tchat-side-note muted sm" aria-busy="true">
            Loading chats…
          </p>
        )}
        {state === "error" && (
          <p className="side-error" role="alert">
            {error} ·{" "}
            <button type="button" className="side-retry" onClick={onRetry}>
              Retry
            </button>
          </p>
        )}
        {state === "ready" && chats.length === 0 && (
          <p className="tchat-side-note muted sm">
            No chats yet. Your chats appear here.
          </p>
        )}
        {today.length > 0 && (
          <section className="side-group" aria-label="Today">
            <div className="eyebrow">Today</div>
            {rows(today)}
          </section>
        )}
        {earlier.length > 0 && (
          <section className="side-group" aria-label="Earlier">
            <div className="eyebrow">Earlier</div>
            {rows(earlier)}
          </section>
        )}
        {hasMore && state === "ready" && (
          <button
            type="button"
            className="side-show-more"
            onClick={onMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Show more"}
          </button>
        )}
      </nav>
    </>
  );
});
