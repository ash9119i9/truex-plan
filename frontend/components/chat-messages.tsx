"use client";
import { visibleEntries, type Entry } from "@/lib/chat";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Fragment, useRef } from "react";
import { CommandResult } from "./command-result";
import { Visualization } from "./visualization";
import { splitVisualizations } from "@/lib/visualization";
import { splitSuggestions } from "@/lib/suggestions";
import { HelperGroup } from "./helper-group";
import { emptySubAgents, type SubAgentState } from "@/lib/subagents";
import { LiveUsage, TurnReceipt } from "./observability/receipt";
import { RequestHold } from "./request-card";
import { WorkGroup } from "./runtime-item";
import { StreamErrorCard } from "./error-ref";
import { StreamIcon } from "./stream-icon";
import { LiveDuration } from "./live-duration";
import { useClock } from "./use-clock";
import {
  clockTime,
  deliveryView,
  parseCommandText,
  turnNumbers,
  workView,
  type StreamError,
} from "@/lib/vm-stream";
import type {
  Goal,
  GoalReview,
  PendingRequest,
  RateLimitView,
  TurnTiming,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts";

type UserEntry = Extract<Entry, { kind: "message" }>;
const WORK = new Set(["thinking", "item", "approval", "agents"]);

// The conversation stream (convo-v2-wireframe-r2.html §1): user bubbles with
// delivery, steer and command results; one agent block per turn with its
// folded work log, helpers, answer, receipt and follow-ups. Errors and
// pending-request holds stay with the turn they belong to.
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
  onSuggest,
  suggestionsEnabled = true,
  traces = [],
  liveUsage = {},
  timings = [],
  rateLimits,
  pending = [],
  error,
  onRetryTurn,
  onRetryMessage,
  selectedTurnId,
  onSelectTurn,
}: {
  entries: Entry[];
  agentName: string;
  /** @deprecated The r2 avatar always uses the accent tone. */
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
  onSuggest?: (question: string) => void;
  suggestionsEnabled?: boolean;
  traces?: TurnTrace[];
  liveUsage?: Record<string, TurnUsage>;
  timings?: TurnTiming[];
  rateLimits?: RateLimitView | null;
  // Open requests; each shows a hold row at the end of the live work log.
  pending?: PendingRequest[];
  // The failed turn's error, shown inline in that turn.
  error?: StreamError | null;
  onRetryTurn?: () => void;
  // Resends a failed or unconfirmed message with the same text.
  onRetryMessage?: (entry: UserEntry) => void;
  selectedTurnId?: string | null;
  onSelectTurn?: (turnId: string) => void;
}) {
  const groups: {
    id: string;
    user?: UserEntry;
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
  const traceByTurn = new Map(traces.map((t) => [t.turnId, t]));
  const timingByTurn = new Map(timings.map((t) => [t.turnId, t]));
  const numbers = turnNumbers(entries);
  // A turn's receipt and error go under its last response block only.
  const lastOfTurn = new Map<string, number>();
  groups.forEach((g, i) => {
    if (!g.user && g.turnId) lastOfTurn.set(g.turnId, i);
  });
  const lastAgentIndex = groups.findLastIndex((g) => !g.user);
  // An error with no known turn stays with the latest response.
  const errorAt = !error
    ? -1
    : error.turnId && lastOfTurn.has(error.turnId)
      ? lastOfTurn.get(error.turnId)!
      : lastAgentIndex;
  // When the stream first saw each turn running, for the live timer.
  const liveStarts = useRef(new Map<string, number>());
  const activeTurn = running ? last?.turnId : undefined;
  if (activeTurn && !liveStarts.current.has(activeTurn))
    liveStarts.current.set(activeTurn, Date.now());
  const now = useClock(running);
  // Turns with an anchor, so each turn id is used once.
  const anchored = new Set<string>();

  const avatar = (
    <span className="st-av" aria-hidden="true">
      <StreamIcon name="bot" />
    </span>
  );
  const holds = pending.map((p) => (
    <li key={p.requestId}>
      <span className="node k-live" aria-hidden="true">
        <StreamIcon name="clock" sm />
      </span>
      <span className="what">
        <RequestHold request={p} />
      </span>
      <span className="t" />
    </li>
  ));

  function header(turnId: string | undefined, active: boolean) {
    const n = turnId ? numbers.get(turnId) : undefined;
    const trace = turnId ? traceByTurn.get(turnId) : undefined;
    const start = turnId ? liveStarts.current.get(turnId) : undefined;
    const at = trace?.startedAt ? clockTime(trace.startedAt) : "";
    const cls = [
      "st-turn",
      turnId && selectedTurnId === turnId && "on",
      active && "live",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div className="st-ah">
        <b>{agentName}</b>
        {n !== undefined &&
          (onSelectTurn && turnId ? (
            <button
              type="button"
              className={cls}
              aria-pressed={selectedTurnId === turnId}
              aria-label={`Turn ${n}, show in session panel`}
              onClick={() => onSelectTurn(turnId)}
            >
              Turn {n}
            </button>
          ) : (
            <span className={cls}>Turn {n}</span>
          ))}
        {at && !active && <span>{at}</span>}
        {active && (
          <span className="st-live">
            <span className="pulse" aria-hidden="true" />
            {start ? <LiveDuration ms={now - start} /> : "Working"}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="chat-messages">
      {groups.map((group, index) => {
        if (group.user) {
          const user = group.user;
          const d = deliveryView(user.delivery, (user as { at?: string }).at);
          const cmd = user.command
            ? parseCommandText(user.text, user.command.method)
            : null;
          const steered = user.turnId ? numbers.get(user.turnId) : undefined;
          return (
            <div
              key={`user:${group.id}`}
              id={`request-${user.id}`}
              className="st-u"
              role="article"
              aria-label="Your message"
            >
              {user.steer && (
                <span className="st-steer">
                  <StreamIcon name="steer" sm />
                  Steered
                  {steered !== undefined && <em>turn {steered}</em>}
                </span>
              )}
              <div className={d.bubble ? `bubble ${d.bubble}` : "bubble"}>
                {cmd ? (
                  <>
                    <span className="st-cmd">
                      <StreamIcon name="slash" sm />
                      {cmd.name}
                    </span>
                    {cmd.arg}
                  </>
                ) : (
                  user.text
                )}
              </div>
              {/* A command's card says whether it ran; its meta line would repeat it. */}
              {!user.command && (d.label || d.icon || d.spinner) && (
                <span
                  className={d.meta ? `st-meta ${d.meta}` : "st-meta"}
                  role={d.state === "accepted" ? undefined : "status"}
                >
                  {d.spinner && <span className="spinner" aria-hidden="true" />}
                  {d.state !== "accepted" && d.icon && (
                    <StreamIcon name={d.icon} sm />
                  )}
                  {d.label}
                  {d.state === "accepted" && d.icon && (
                    <>
                      <StreamIcon name="check" sm />
                      <span className="sr-only">Sent</span>
                    </>
                  )}
                  {d.retry && onRetryMessage && (
                    <button
                      type="button"
                      className="st-mini"
                      onClick={() => onRetryMessage(user)}
                    >
                      <StreamIcon name="retry" sm />
                      Retry
                    </button>
                  )}
                </span>
              )}
              {user.command && (
                <CommandResult
                  command={user.command}
                  text={user.text}
                  onCommand={onCommand}
                  onOpen={onOpen}
                  onRefresh={onRefresh}
                  currentGoal={goal}
                  goalReview={goalReview}
                />
              )}
            </div>
          );
        }
        const turnId = group.turnId;
        const active = running && index === groups.length - 1;
        const answers = group.entries.filter(
          (e): e is UserEntry => e.kind === "message" && !!e.text,
        );
        const answering = answers.length > 0;
        const trace = turnId ? traceByTurn.get(turnId) : undefined;
        const work = workView(
          group.entries.filter((e) => WORK.has(e.kind)),
          {
            active,
            answering,
            trace,
            liveUsage: turnId ? liveUsage[turnId] : null,
            subAgents,
            startedAt: turnId ? liveStarts.current.get(turnId) : undefined,
            now,
            waiting: active ? pending.length : 0,
          },
        );
        const isLastOfTurn = !!turnId && lastOfTurn.get(turnId) === index;
        // The goal timeline links to the first response of a turn.
        const anchor =
          turnId && !anchored.has(turnId) ? `turn-${turnId}` : undefined;
        if (turnId) anchored.add(turnId);
        // Follow-ups come from the last answer of the latest finished turn.
        const lastAnswer = answers.at(-1);
        const suggestions =
          onSuggest &&
          suggestionsEnabled &&
          !running &&
          index === groups.length - 1 &&
          lastAnswer?.final
            ? splitSuggestions(lastAnswer.text).suggestions
            : [];
        // Turns with no user message of their own (goal continuations) get a divider.
        const n = turnId ? numbers.get(turnId) : undefined;
        const prev = groups[index - 1];
        const divider =
          n !== undefined && n > 1 && prev && !prev.user && prev.turnId !== turnId;
        const trace0 = trace?.startedAt ? clockTime(trace.startedAt) : "";
        return (
          <Fragment key={`assistant:${group.id}`}>
            {divider && (
              <div className="st-div" role="separator">
                {`TURN ${n}${trace0 ? ` · ${trace0}` : ""}`}
              </div>
            )}
            <article
              className="st-a"
              id={anchor}
              tabIndex={anchor ? -1 : undefined}
              aria-label={`${agentName} response`}
            >
              {avatar}
              <div>
                {header(turnId, active)}
                {work && (
                  <WorkGroup
                    key={`${group.id}:${work.defaultOpen}`}
                    view={work}
                    holds={active ? holds : undefined}
                  />
                )}
                {group.entries.map((e) =>
                  e.kind === "agents" ? (
                    <HelperGroup
                      key={e.id}
                      id={e.id.replace(/[^\w-]/g, "-")}
                      threadIds={e.threadIds}
                      state={subAgents}
                      sessionId={sessionId}
                      onOpenAgent={onOpenAgent}
                    />
                  ) : null,
                )}
                {answers.map((e) => {
                  const streaming = !e.final && !e.done;
                  return (
                    <div className="st-ans markdown" key={e.id}>
                      {splitVisualizations(
                        splitSuggestions(e.text, streaming).body,
                        streaming,
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
                      {active && streaming && (
                        <span className="caret" aria-hidden="true" />
                      )}
                    </div>
                  );
                })}
                {errorAt === index && error && (
                  <StreamErrorCard
                    error={error}
                    onRetry={running ? undefined : onRetryTurn}
                  />
                )}
                {isLastOfTurn &&
                  turnId &&
                  (trace && !active ? (
                    <TurnReceipt
                      trace={trace}
                      sessionId={sessionId}
                      turnNumber={numbers.get(turnId)}
                      timing={timingByTurn.get(turnId) ?? null}
                      rateLimits={rateLimits}
                      agentName={agentName}
                    />
                  ) : active && liveUsage[turnId] ? (
                    <LiveUsage usage={liveUsage[turnId]} />
                  ) : null)}
                {!!suggestions.length && (
                  <nav className="st-fu" aria-label="Suggested follow-ups">
                    <span className="lbl">
                      <StreamIcon name="spark" sm />
                      Try next
                    </span>
                    {suggestions.map((q) => (
                      <button
                        key={q}
                        type="button"
                        className="chip"
                        aria-label={`Ask: ${q}`}
                        onClick={() => onSuggest!(q)}
                      >
                        {q}
                        <StreamIcon name="send" sm />
                      </button>
                    ))}
                  </nav>
                )}
              </div>
            </article>
          </Fragment>
        );
      })}
      {needsPlaceholder && (
        <div className="st-a" role="article" aria-label={`${agentName} response`}>
          {avatar}
          <div>
            {header(undefined, true)}
            <WorkGroup
              view={
                workView([], {
                  active: true,
                  answering: false,
                  waiting: pending.length,
                  now,
                })!
              }
              holds={holds}
            />
          </div>
        </div>
      )}
      {/* An error that arrived before any response still shows in the stream. */}
      {error && errorAt < 0 && (
        <div className="st-a" role="article" aria-label={`${agentName} response`}>
          {avatar}
          <div>
            {header(undefined, false)}
            <StreamErrorCard
              error={error}
              onRetry={running ? undefined : onRetryTurn}
            />
          </div>
        </div>
      )}
    </div>
  );
}
