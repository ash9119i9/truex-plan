"use client";
import type { Entry } from "@/lib/chat";
import { createChatGroupSelector, type ChatGroup } from "@/lib/chat-groups";
import { CopyTextButton, StreamingMarkdown } from "./streaming-markdown";
import {
  Fragment,
  memo,
  useMemo,
  createContext,
  useContext,
  useCallback,
  useId,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type LegendListProps,
  type LegendListRenderItemProps,
} from "@legendapp/list/react";
import { CommandResult, commandLabel } from "./command-result";
import { ThinkingBlock } from "./thinking-block";
import { ApprovalRecordView } from "./approval-record";
import dynamic from "next/dynamic";

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

const Visualization = dynamic(
  () => import("./visualization").then((module) => module.Visualization),
  {
    loading: () => <p role="status">Loading visual…</p>,
  },
);

const emptyTraces: TurnTrace[] = [];
const emptyUsage: Record<string, TurnUsage> = {};

export interface ChatTimelineProps {
  identity: string;
  listRef: RefObject<LegendListRef | null>;
  onViewport: (node: HTMLElement | null) => void;
  onScroll: () => void;
  following: boolean;
  initialScrollOffset?: number;
  initialScrollIndex?: LegendListProps<ChatGroup>["initialScrollIndex"];
  header?: ReactNode;
  footer?: ReactNode;
  onLoad?: () => void;
}

interface ChatMessagesProps {
  timeline?: ChatTimelineProps;
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
  onSuggest?: (question: string) => void;
  suggestionsEnabled?: boolean;
  traces?: TurnTrace[];
  liveUsage?: Record<string, TurnUsage>;
}

export const ChatMessages = memo(function ChatMessages({
  entries,
  timeline,
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
  onSuggest,
  suggestionsEnabled = true,
  traces = emptyTraces,
  liveUsage = emptyUsage,
}: ChatMessagesProps) {
  const selectGroups = useMemo(
    () => createChatGroupSelector(),
    [timeline?.identity ?? sessionId],
  );
  const groups = useMemo(() => selectGroups(entries), [entries, selectGroups]);
  const traceByTurn = useMemo(
    () => new Map(traces.map((t) => [t.turnId, t])),
    [traces],
  );
  const presentation = useMemo(() => {
    const receiptAt = new Map<string, number>();
    groups.forEach((g, i) => {
      if (!g.user && g.turnId) receiptAt.set(g.turnId, i);
    });
    const anchored = new Set<string>();
    return groups.map((group, i) => {
      const anchor =
        !group.user && group.turnId && !anchored.has(group.turnId)
          ? `turn-${group.turnId}`
          : undefined;
      if (!group.user && group.turnId) anchored.add(group.turnId);
      return {
        anchor,
        receipt: !!group.turnId && receiptAt.get(group.turnId) === i,
      };
    });
  }, [groups]);
  const last = groups.at(-1);
  const needsPlaceholder = running && (!last || !!last.user);
  const shared = useMemo(
    () => ({
      groups,
      presentation,
      traceByTurn,
      agentName,
      agentHue,
      running,
      onCommand,
      onOpen,
      onRefresh,
      goal,
      goalReview,
      sessionId,
      onPrompt,
      subAgents,
      onOpenAgent,
      onSuggest,
      suggestionsEnabled,
      liveUsage,
    }),
    [
      groups,
      presentation,
      traceByTurn,
      agentName,
      agentHue,
      running,
      onCommand,
      onOpen,
      onRefresh,
      goal,
      goalReview,
      sessionId,
      onPrompt,
      subAgents,
      onOpenAgent,
      onSuggest,
      suggestionsEnabled,
      liveUsage,
    ],
  );
  const listRef = timeline?.listRef;
  const onViewport = timeline?.onViewport;
  const setList = useCallback(
    (list: LegendListRef | null) => {
      if (listRef) listRef.current = list;
      onViewport?.(list?.getScrollableNode() ?? null);
    },
    [listRef, onViewport],
  );
  const placeholder = needsPlaceholder ? (
    <div className="msg agent" aria-label={`${agentName} response`}>
      <AgentAvatar hue={agentHue} />
      <div className="grow">
        <div className="msg-meta">
          <span className="strong">{agentName}</span>
          <span className="muted sm">thinking…</span>
        </div>
        <Working />
      </div>
    </div>
  ) : null;
  if (timeline)
    return (
      <TimelineContext value={shared}>
        <LegendList<ChatGroup>
          key={timeline.identity}
          ref={setList}
          data={groups}
          keyExtractor={timelineKey}
          getItemType={timelineType}
          renderItem={renderTimelineItem}
          estimatedItemSize={90}
          initialScrollOffset={timeline.initialScrollOffset}
          initialScrollIndex={timeline.initialScrollIndex}
          initialScrollAtEnd={
            timeline.initialScrollOffset === undefined &&
            timeline.initialScrollIndex === undefined
          }
          maintainScrollAtEnd={timeline.following}
          maintainVisibleContentPosition={true}
          onScroll={timeline.onScroll}
          onLoad={timeline.onLoad}
          role="log"
          aria-label="Conversation"
          aria-live="off"
          tabIndex={0}
          className="scroll transcript chat-timeline-scroll"
          style={{ padding: 0, overflowAnchor: "none" }}
          contentContainerStyle={{
            // LegendList adds padding into numeric scroll positions. CSS
            // shorthand/clamp strings belong on the measured row frame.
            paddingTop: 28,
            paddingBottom: 40,
          }}
          ListHeaderComponent={
            timeline.header ? (
              <TimelineFrame>{timeline.header}</TimelineFrame>
            ) : null
          }
          ListFooterComponent={
            <TimelineFrame>
              {placeholder}
              {timeline.footer}
            </TimelineFrame>
          }
        />
      </TimelineContext>
    );
  return (
    <TimelineContext value={shared}>
      <div className="chat-messages">
        {groups.map((group, index) => (
          <TimelineRow key={timelineKey(group)} group={group} index={index} />
        ))}
        {placeholder}
      </div>
    </TimelineContext>
  );
});

type TimelineShared = Omit<
  ChatMessagesProps,
  "entries" | "timeline" | "traces"
> & {
  groups: ChatGroup[];
  presentation: { anchor: string | undefined; receipt: boolean }[];
  traceByTurn: Map<string, TurnTrace>;
  subAgents: SubAgentState;
  liveUsage: Record<string, TurnUsage>;
};
const TimelineContext = createContext<TimelineShared | null>(null);
const timelineKey = (group: ChatGroup) =>
  `${group.user ? "user" : "assistant"}:${group.id}`;
const timelineType = (group: ChatGroup) => (group.user ? "user" : "assistant");
function TimelineFrame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: "calc(100% - clamp(40px, 10vw, 144px))",
        maxWidth: 760,
        margin: "0 auto",
        paddingBottom: 22,
        display: "flex",
        flexDirection: "column",
        gap: 22,
      }}
    >
      {children}
    </div>
  );
}
function renderTimelineItem({
  item,
  index,
}: LegendListRenderItemProps<ChatGroup>) {
  return (
    <TimelineFrame>
      <TimelineRow group={item} index={index} />
    </TimelineFrame>
  );
}
function TimelineRow({ group, index }: { group: ChatGroup; index: number }) {
  const context = useContext(TimelineContext)!;
  const {
    groups,
    presentation,
    traceByTurn,
    agentName,
    agentHue,
    running,
    onCommand,
    onOpen,
    onRefresh,
    goal,
    goalReview,
    sessionId,
    onPrompt,
    subAgents,
    onOpenAgent,
    onSuggest,
    suggestionsEnabled,
    liveUsage,
  } = context;
  if (group.user)
    return (
      <UserMessageRow
        key={`user:${group.id}`}
        user={group.user}
        onCommand={group.user.command ? onCommand : undefined}
        onOpen={group.user.command ? onOpen : undefined}
        onRefresh={group.user.command ? onRefresh : undefined}
        goal={group.user.command ? goal : undefined}
        goalReview={group.user.command ? goalReview : undefined}
      />
    );
  const active = running && index === groups.length - 1;
  const hasHelpers = group.entries.some((entry) => entry.kind === "agents");
  return (
    <AssistantMessageRow
      key={`assistant:${group.id}`}
      group={group}
      anchor={presentation[index].anchor}
      agentName={agentName}
      agentHue={agentHue}
      active={active}
      sessionId={sessionId}
      onPrompt={onPrompt}
      subAgents={hasHelpers ? subAgents : emptySubAgents}
      onOpenAgent={hasHelpers ? onOpenAgent : undefined}
      trace={
        presentation[index].receipt && !active && group.turnId
          ? traceByTurn.get(group.turnId)
          : undefined
      }
      usage={
        presentation[index].receipt && active && group.turnId
          ? liveUsage[group.turnId]
          : undefined
      }
      onSuggest={
        !running && index === groups.length - 1 && suggestionsEnabled
          ? onSuggest
          : undefined
      }
    />
  );
}

function AgentAvatar({ hue }: { hue?: string }) {
  return (
    <span
      className="agent-avatar"
      style={{ background: hue || "var(--accent-soft-2)" }}
      aria-hidden="true"
    >
      <Icon name="spark" size={13} stroke={2} />
    </span>
  );
}

function Working() {
  return (
    <ul className="steps" role="status">
      <li>
        <span className="spinner" aria-hidden="true" />
        Working
      </li>
    </ul>
  );
}

const UserMessageRow = memo(function UserMessageRow({
  user,
  onCommand,
  onOpen,
  onRefresh,
  goal,
  goalReview,
}: {
  user: Extract<Entry, { kind: "message" }>;
} & Pick<
  ChatMessagesProps,
  "onCommand" | "onOpen" | "onRefresh" | "goal" | "goalReview"
>) {
  const isGoal = user.command?.method.startsWith("thread/goal/");
  const notes = [
    user.steer && "Follow-up",
    user.delivery &&
      user.delivery !== "accepted" &&
      (user.delivery === "pending" ? "Sending…" : "Delivery unconfirmed"),
  ].filter(Boolean);
  return (
    <Fragment>
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
          <UserPrompt text={user.text} />
          {!!notes.length && (
            <span className="msg-note muted sm">{notes.join(" · ")}</span>
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
});

// Keep the complete selectable prompt; the disclosure changes visible height.
function UserPrompt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const collapsible = text.length > 600 || text.split("\n").length > 8;
  return (
    <>
      <div
        id={contentId}
        className="bubble"
        data-collapsed={collapsible && !expanded}
      >
        {text}
      </div>
      {collapsible && (
        <button
          type="button"
          className="text-btn"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full message"}
        </button>
      )}
    </>
  );
}

const AssistantMessageRow = memo(function AssistantMessageRow({
  group,
  anchor,
  agentName,
  agentHue,
  active,
  sessionId,
  onPrompt,
  subAgents,
  onOpenAgent,
  trace,
  usage,
  onSuggest,
}: {
  group: ChatGroup;
  anchor?: string;
  active: boolean;
  subAgents: SubAgentState;
  trace?: TurnTrace;
  usage?: TurnUsage;
} & Pick<
  ChatMessagesProps,
  | "agentName"
  | "agentHue"
  | "sessionId"
  | "onPrompt"
  | "onOpenAgent"
  | "onSuggest"
>) {
  const thinking = group.entries.filter((e) => e.kind === "thinking");
  const content = group.entries.filter((e) => e.kind !== "thinking");
  const answering = content.some((e) => e.kind === "message" && !!e.text);
  const lastAnswer = onSuggest
    ? content.findLast((e) => e.kind === "message" && !!e.text)
    : undefined;
  const suggestions =
    lastAnswer?.kind === "message" && lastAnswer.final
      ? splitSuggestions(lastAnswer.text).suggestions
      : [];
  return (
    <article
      className="msg agent"
      id={anchor}
      tabIndex={anchor ? -1 : undefined}
      aria-label={`${agentName} response`}
    >
      <AgentAvatar hue={agentHue} />
      <div className="grow">
        <div className="msg-meta">
          <span className="strong">{agentName}</span>
          {active && !answering && <span className="muted sm">thinking…</span>}
        </div>
        {!!thinking.length && (
          <ThinkingBlock
            text={thinking}
            streaming={active && !answering && thinking.some((e) => !e.done)}
          />
        )}
        {active && !answering && !thinking.some((e) => !e.done) && <Working />}
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
          ) : e.kind === "visual" ? (
            sessionId ? (
              <Visualization
                key={e.id}
                sessionId={sessionId}
                id={e.visual.id}
                initialHeight={e.visual.height}
                onPrompt={onPrompt}
              />
            ) : (
              <p key={e.id}>
                Open this conversation to view the visualization.
              </p>
            )
          ) : e.kind === "message" && e.text ? (
            <AnswerBody
              key={e.id}
              entry={e}
              publishedVisualIds={group.visualIds}
              active={active}
              sessionId={sessionId}
              onPrompt={onPrompt}
            />
          ) : null,
        )}
        {trace ? (
          <TurnReceipt trace={trace} sessionId={sessionId} />
        ) : usage ? (
          <LiveUsage usage={usage} />
        ) : null}
        {!!suggestions.length && (
          <SuggestedQuestions questions={suggestions} onSelect={onSuggest!} />
        )}
      </div>
    </article>
  );
});

// Receipts, helper status, and composer changes must not reparse saved Markdown.
const AnswerBody = memo(function AnswerBody({
  entry,
  publishedVisualIds,
  active,
  sessionId,
  onPrompt,
}: {
  publishedVisualIds?: readonly string[];
  entry: Extract<Entry, { kind: "message" }>;
  active: boolean;
} & Pick<ChatMessagesProps, "sessionId" | "onPrompt">) {
  const streaming = !entry.final && !entry.done;
  const body = splitSuggestions(entry.text, streaming).body;
  return (
    <div className="answer markdown">
      {splitVisualizations(body, streaming, publishedVisualIds).map(
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
              <p key={i}>Open this conversation to view the visualization.</p>
            )
          ) : (
            <StreamingMarkdown key={i} text={part.text} streaming={streaming} />
          ),
      )}
      {active && streaming && <span className="caret" aria-hidden="true" />}
      {!streaming && <CopyTextButton text={body} label="Copy answer" />}
    </div>
  );
});
