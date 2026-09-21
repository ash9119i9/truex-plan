"use client";
import { visibleEntries, type Entry } from "@/lib/chat";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Fragment } from "react";
import { CommandResult, commandLabel } from "./command-result";
import { ThinkingBlock } from "./thinking-block";
import { Visualization } from "./visualization";
import { splitVisualizations } from "@/lib/visualization";

export function ChatMessages({
  entries,
  agentName,
  running,
  onCommand,
  onOpen,
  onRefresh,
  sessionId,
  onPrompt,
}: {
  entries: Entry[];
  agentName: string;
  running: boolean;
  onCommand?: (text: string) => void;
  onOpen?: (id: string) => void;
  onRefresh?: () => void;
  sessionId?: string;
  onPrompt?: (text: string) => void;
}) {
  const groups: {
    id: string;
    user?: Extract<Entry, { kind: "message" }>;
    entries: Entry[];
    turnId?: string;
    goal?: { id: string; objective: string };
  }[] = [];
  let goal: { id: string; objective: string } | undefined;
  for (const entry of visibleEntries(entries).filter(
    (e) => e.kind !== "item",
  )) {
    if (entry.kind === "message" && entry.role === "user") {
      const command = entry.command;
      if (
        command &&
        (command.state === "succeeded" || command.state === "running")
      ) {
        if (
          command.method === "thread/goal/set" &&
          typeof command.params.objective === "string"
        )
          goal = { id: entry.id, objective: command.params.objective };
        if (command.method === "thread/goal/get" && command.result?.goal)
          goal = { id: entry.id, objective: command.result.goal.objective };
        if (
          command.method === "thread/goal/clear" ||
          (command.method === "thread/goal/get" &&
            command.state === "succeeded" &&
            !command.result?.goal)
        )
          goal = undefined;
      }
      groups.push({ id: entry.id, user: entry, entries: [] });
    } else {
      const last = groups.at(-1);
      if (last && !last.user && last.turnId === entry.turnId)
        last.entries.push(entry);
      else
        groups.push({
          id: entry.id,
          turnId: entry.turnId,
          entries: [entry],
          goal,
        });
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
            <Fragment key={`user:${group.id}`}>
              <article
                id={`request-${user.id}`}
                className="message user"
                aria-label="Your message"
              >
                <div className="message-label">
                  You
                  {user.command && (
                    <span className="command-badge">
                      {commandLabel(user.command.method)}
                    </span>
                  )}
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
              {user.command && (
                <CommandResult
                  command={user.command}
                  onCommand={onCommand}
                  onOpen={onOpen}
                  onRefresh={onRefresh}
                />
              )}
            </Fragment>
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
            {group.goal && (
              <a className="goal-context" href={`#request-${group.goal.id}`}>
                Goal: {group.goal.objective}
              </a>
            )}
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
              e.kind === "message" && e.text ? (
                <div className="message assistant" key={e.id}>
                  <div className="message-text markdown">
                    {splitVisualizations(e.text, !e.final && !e.done).map(
                      (part, i) =>
                        part.type === "visualization" ? (
                          sessionId ? (
                            <Visualization
                              key={part.id + ":" + i}
                              sessionId={sessionId}
                              id={part.id}
                              onPrompt={onPrompt}
                            />
                          ) : (
                            <p key={i}>
                              Open this conversation to view the visualization.
                            </p>
                          )
                        ) : (
                          <Markdown key={i} remarkPlugins={[remarkGfm]}>
                            {part.text}
                          </Markdown>
                        ),
                    )}
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
