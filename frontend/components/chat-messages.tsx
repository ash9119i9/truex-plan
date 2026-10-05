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
import { splitSuggestions } from "@/lib/suggestions";
import { SuggestedQuestions } from "./suggested-questions";
import { HelperGroup } from "./helper-group";
import { emptySubAgents, type SubAgentState } from "@/lib/subagents";
import { LiveUsage, TurnReceipt } from "./observability/receipt";
import { Icon } from "./v2/icon";
import type {
  Goal,
  GoalReview,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts";

export function ChatMessages({
  entries,
  agentName,
  agentHue,
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
  onStopAgent,
  helperStopDisabled = false,
  onSuggest,
  suggestionsEnabled = true,
  traces = [],
  liveUsage = {},
}: {
  entries: Entry[];
  agentName: string;
  /** Agent colour for the avatar; defaults to --accent-soft-2. */
  agentHue?: string;
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
  onStopAgent?: (threadId: string) => void;
  helperStopDisabled?: boolean;
  onSuggest?: (question: string) => void;
  suggestionsEnabled?: boolean;
  traces?: TurnTrace[];
  liveUsage?: Record<string, TurnUsage>;
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
  const traceByTurn = new Map(traces.map((t) => [t.turnId, t]));
  // A turn's receipt goes under its last response block only.
  const receiptAt = new Map<string, number>();
  groups.forEach((g, i) => {
    if (!g.user && g.turnId) receiptAt.set(g.turnId, i);
  });
  // Turns with an anchor, so each turn id is used once.
  const anchored = new Set<string>();
  const avatar = (
    <span
      className="agent-avatar"
      style={{ background: agentHue || "var(--accent-soft-2)" }}
      aria-hidden="true"
    >
      <Icon name="spark" size={13} stroke={2} />
    </span>
  );
  const working = (
    <ul className="steps" role="status">
      <li>
        <span className="spinner" aria-hidden="true" />
        Working
      </li>
    </ul>
  );
  return (
    <div className="chat-messages">
      {groups.map((group, index) => {
        if (group.user) {
          const user = group.user;
          const isGoal = user.command?.method.startsWith("thread/goal/");
          const notes = [
            user.steer && "Follow-up",
            user.delivery &&
              user.delivery !== "accepted" &&
              (user.delivery === "pending"
                ? "Sending…"
                : "Delivery unconfirmed"),
          ].filter(Boolean);
          return (
            <Fragment key={`user:${group.id}`}>
              <article
                id={`request-${user.id}`}
                className="msg user"
                aria-label="Your message"
              >
                <div className="bubble-wrap">
                  {user.command && (
                    <span className="goal-tag">
                      {isGoal && <Icon name="target" size={12} />}
                      {commandLabel(user.command.method)}
                    </span>
                  )}
                  <div className="bubble">{user.text}</div>
                  {!!notes.length && (
                    <span className="msg-note muted sm">
                      {notes.join(" · ")}
                    </span>
                  )}
                </div>
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
        // Follow-ups come from the last answer of the latest finished turn.
        const lastAnswer = content.findLast(
          (e) => e.kind === "message" && !!e.text,
        );
        const suggestions =
          onSuggest &&
          suggestionsEnabled &&
          !running &&
          index === groups.length - 1 &&
          lastAnswer?.kind === "message" &&
          lastAnswer.final
            ? splitSuggestions(lastAnswer.text).suggestions
            : [];
        return (
          <article
            className="msg agent"
            key={`assistant:${group.id}`}
            id={anchor}
            tabIndex={anchor ? -1 : undefined}
            aria-label={`${agentName} response`}
          >
            {avatar}
            <div className="grow">
              <div className="msg-meta">
                <span className="strong">{agentName}</span>
                {active && !answering && (
                  <span className="muted sm">thinking…</span>
                )}
              </div>
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
              {active &&
                !answering &&
                !thinking.some((e) => !e.done) &&
                working}
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
                    onStopAgent={onStopAgent}
                    stopDisabled={helperStopDisabled}
                  />
                ) : e.kind === "message" && e.text ? (
                  <div className="answer markdown" key={e.id}>
                    {splitVisualizations(
                      splitSuggestions(e.text, !e.final && !e.done).body,
                      !e.final && !e.done,
                    ).map((part, i) =>
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
                      <span className="caret" aria-hidden="true" />
                    )}
                  </div>
                ) : null,
              )}
              {group.turnId &&
                receiptAt.get(group.turnId) === index &&
                (traceByTurn.has(group.turnId) && !active ? (
                  <TurnReceipt
                    trace={traceByTurn.get(group.turnId)!}
                    sessionId={sessionId}
                  />
                ) : active && liveUsage[group.turnId] ? (
                  <LiveUsage usage={liveUsage[group.turnId]} />
                ) : null)}
              {!!suggestions.length && (
                <SuggestedQuestions
                  questions={suggestions}
                  onSelect={onSuggest!}
                />
              )}
            </div>
          </article>
        );
      })}
      {needsPlaceholder && (
        <div className="msg agent" aria-label={`${agentName} response`}>
          {avatar}
          <div className="grow">
            <div className="msg-meta">
              <span className="strong">{agentName}</span>
              <span className="muted sm">thinking…</span>
            </div>
            {working}
          </div>
        </div>
      )}
    </div>
  );
}
