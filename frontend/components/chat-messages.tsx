"use client";
import { visibleEntries, type Entry } from "@/lib/chat";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Fragment } from "react";
import { CommandResult, commandLabel } from "./command-result";
import { ThinkingBlock } from "./thinking-block";
import { ApprovalRecordView } from "./approval-record";
import { Visualization } from "./visualization";
import { splitVisualizations } from "@/lib/visualization";
import { HelperGroup } from "./helper-group";
import { emptySubAgents, type SubAgentState } from "@/lib/subagents";
import type { Goal, GoalReview } from "../../shared/contracts";

export function ChatMessages({
  entries,
  agentName,
  running,
  onCommand,
  onOpen,
  onRefresh,
  sessionId,
  onPrompt,
  goal,
  goalReview,
  subAgents = emptySubAgents,
  onOpenAgent,
}: {
  entries: Entry[];
  agentName: string;
  running: boolean;
  onCommand?: (text: string) => void;
  onOpen?: (id: string) => void;
  onRefresh?: () => void;
  sessionId?: string;
  onPrompt?: (text: string) => void;
  goal?: Goal | null;
  goalReview?: GoalReview | null;
  subAgents?: SubAgentState;
  onOpenAgent?: (threadId: string) => void;
}) {
  const groups: {
    id: string;
    user?: Extract<Entry, { kind: "message" }>;
    entries: Entry[];
    turnId?: string;
  }[] = [];
  for (const entry of visibleEntries(entries).filter(
    (e) => e.kind !== "item",
  )) {
    if (entry.kind === "message" && entry.role === "user") {
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
        });
    }
  }
  const last = groups.at(-1);
  const needsPlaceholder = running && (!last || !!last.user);
  // Turns with an anchor, so each turn id is used once.
  const anchored = new Set<string>();
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
                  currentGoal={goal}
                  goalReview={goalReview}
                />
              )}
            </Fragment>
          );
        }
        const thinking = group.entries.filter((e) => e.kind === "thinking");
        const content = group.entries.filter((e) => e.kind !== "thinking");
        const active = running && index === groups.length - 1;
        const answering = content.some((e) => e.kind === "message" && !!e.text);
        // The goal timeline links to the first response of a turn.
        const anchor =
          group.turnId && !anchored.has(group.turnId)
            ? `turn-${group.turnId}`
            : undefined;
        if (group.turnId) anchored.add(group.turnId);
        return (
          <article
            className="assistant-turn"
            key={`assistant:${group.id}`}
            id={anchor}
            tabIndex={anchor ? -1 : undefined}
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
              e.kind === "approval" ? (
                <ApprovalRecordView key={e.id} record={e.record} />
              ) : e.kind === "agents" ? (
                <HelperGroup
                  key={e.id}
                  id={e.id.replace(/[^\w-]/g, "-")}
                  threadIds={e.threadIds}
                  state={subAgents}
                  sessionId={sessionId}
                  onOpenAgent={onOpenAgent}
                />
              ) : e.kind === "message" && e.text ? (
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
