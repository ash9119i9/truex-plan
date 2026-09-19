"use client";
import { visibleEntries, type Entry } from "@/lib/chat";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RuntimeItem } from "./runtime-item";
import { ThinkingBlock } from "./thinking-block";

export function ChatMessages({
  entries,
  agentName,
  running,
}: {
  entries: Entry[];
  agentName: string;
  running: boolean;
}) {
  const groups: {
    id: string;
    user?: Extract<Entry, { kind: "message" }>;
    entries: Entry[];
    turnId?: string;
  }[] = [];
  for (const entry of visibleEntries(entries)) {
    if (entry.kind === "message" && entry.role === "user") {
      groups.push({ id: entry.id, user: entry, entries: [] });
    } else {
      const last = groups.at(-1);
      if (last && !last.user && last.turnId === entry.turnId)
        last.entries.push(entry);
      else
        groups.push({ id: entry.id, turnId: entry.turnId, entries: [entry] });
    }
  }
  const last = groups.at(-1);
  const needsPlaceholder = running && (!last || !!last.user);
  return (
    <div className="chat-messages">
      {groups.map((group, index) => {
        if (group.user) {
          const user = group.user;
          return (
            <article
              className="message user"
              key={`user:${group.id}`}
              aria-label="Your message"
            >
              <div className="message-label">
                You
                {user.steer && <span> · Follow-up</span>}
                {user.delivery && user.delivery !== "accepted" && (
                  <span>
                    {" "}
                    ·{" "}
                    {user.delivery === "pending"
                      ? "Sending…"
                      : "Delivery unconfirmed"}
                  </span>
                )}
              </div>
              <div className="message-text">{user.text}</div>
            </article>
          );
        }
        const thinking = group.entries.filter((e) => e.kind === "thinking");
        const content = group.entries.filter((e) => e.kind !== "thinking");
        const active = running && index === groups.length - 1;
        const answering = content.some((e) => e.kind === "message" && !!e.text);
        return (
          <article
            className="assistant-turn"
            key={`assistant:${group.id}`}
            aria-label={`${agentName} response`}
          >
            <div className="message-label">{agentName}</div>
            {!!thinking.length && (
              <ThinkingBlock
                text={thinking
                  .map((e) => e.text)
                  .filter(Boolean)
                  .join("\n\n")}
                streaming={
                  active && !answering && thinking.some((e) => !e.done)
                }
              />
            )}
            {content.map((e) =>
              e.kind === "item" ? (
                <RuntimeItem key={e.id} item={e.item} />
              ) : e.kind === "message" && e.text ? (
                <div className="message assistant" key={e.id}>
                  <div className="message-text markdown">
                    <Markdown remarkPlugins={[remarkGfm]}>{e.text}</Markdown>
                    {active && !e.final && !e.done && (
                      <span className="cursor" aria-hidden="true" />
                    )}
                  </div>
                </div>
              ) : null,
            )}
            {active && !answering && !thinking.some((e) => !e.done) && (
              <p className="chat-working" role="status">
                Working
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </p>
            )}
          </article>
        );
      })}
      {needsPlaceholder && (
        <div className="assistant-turn" role="status">
          <div className="message-label">{agentName}</div>
          <p className="chat-working">
            Working
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
