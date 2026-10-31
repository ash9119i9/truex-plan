// A chat's goal (tasks/goal-mode-plan.md): the platform's goal routes, the
// chat event stream that announces Codex-started goal turns, and the goal as
// the screen holds it. Codex owns the goal; the status text copies its TUI
// footer (codex-rs/tui/src/bottom_pane/footer.rs, chatwidget/goal_status.rs).
import { api, ApiRequestError, userMessage } from "./api.ts";
import { auth } from "./auth.ts";
import type { GoalSettings } from "./session.ts";
import type { ChatSummary, ChatThread } from "./tenant-chat.ts";
import {
  followStream,
  type FollowDeps,
  type FollowHandlers,
  type StreamEnd,
} from "./tenant-chat-stream.ts";

export const MAX_GOAL_OBJECTIVE = 4000;

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";
// Truex's review of a goal Codex marked complete.
export type GoalReview = "none" | "pending" | "approved" | "accepted_as_is";
// "model": the agent proposed it (create_goal); the platform paused it.
export type GoalOrigin = "user" | "model";

export interface TenantGoal {
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  origin: GoalOrigin;
  review: GoalReview;
  // The goal document's revision: of two views, the higher one is newer.
  rev: number;
}

// The open chat's goal. `ended`: goal mode is over in the chat (cleared or
// archived); no later event brings a goal back.
export interface GoalState {
  goal: TenantGoal | null;
  ended: boolean;
}

export const NO_GOAL: GoalState = { goal: null, ended: false };
const ENDED: GoalState = { goal: null, ended: true };

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
];
export const GOAL_REVIEWS: readonly GoalReview[] = [
  "none",
  "pending",
  "approved",
  "accepted_as_is",
];
const ORIGINS: readonly GoalOrigin[] = ["user", "model"];

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : null;
const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null => (allowed.includes(value as T) ? (value as T) : null);

// A malformed goal from the server is dropped rather than shown.
export function parseGoal(value: unknown): TenantGoal | null {
  const g = record(value);
  const status = oneOf(g?.status, GOAL_STATUSES);
  const origin = oneOf(g?.origin, ORIGINS);
  const review = oneOf(g?.review, GOAL_REVIEWS);
  const tokensUsed = whole(g?.tokensUsed);
  const timeUsedSeconds = whole(g?.timeUsedSeconds);
  const rev = whole(g?.rev);
  const tokenBudget = g?.tokenBudget === null ? null : whole(g?.tokenBudget);
  if (
    !g ||
    typeof g.objective !== "string" ||
    // Codex counts characters; a UTF-16 length is at most twice that.
    g.objective.length > 2 * MAX_GOAL_OBJECTIVE ||
    !status ||
    !origin ||
    !review ||
    tokensUsed === null ||
    timeUsedSeconds === null ||
    rev === null ||
    (g.tokenBudget !== null && tokenBudget === null)
  )
    return null;
  return {
    objective: g.objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    origin,
    review,
    rev,
  };
}

// A goal from a route answer or the stream, applied only when newer than the
// one shown, so a late or repeated update never moves the goal backwards.
export function withGoal(state: GoalState, goal: TenantGoal): GoalState {
  if (state.ended || (state.goal && goal.rev <= state.goal.rev)) return state;
  return { goal, ended: false };
}

// One event from the chat event stream (or its snapshot) applied to the goal.
export function applyGoalEvent(
  state: GoalState,
  event: { type: string; data: unknown },
): GoalState {
  const data = record(event.data);
  if (event.type === "goal.cleared") return ENDED;
  if (event.type !== "snapshot" && event.type !== "goal.updated") return state;
  // null: none yet, or goal mode ended. A chat that had a goal never loses
  // it otherwise, so a null after one means it ended.
  if (data?.goal === null) return state.goal ? ENDED : state;
  const goal = parseGoal(data?.goal);
  return goal ? withGoal(state, goal) : state;
}

// The goal run an event names: run.started, or the run a (re)connect's
// snapshot says the chat is answering.
export function goalRunOf(event: { type: string; data: unknown }) {
  const data = record(event.data);
  const runId =
    event.type === "run.started"
      ? data?.runId
      : event.type === "snapshot"
        ? data?.activeRunId
        : null;
  return typeof runId === "string" && /^[0-9a-f]{24}$/.test(runId)
    ? runId
    : null;
}

// The open chat following a goal run Codex started: unchanged when it already
// follows that run, null while another run is still on screen (attach once
// that one is saved).
export function withGoalRun(
  thread: ChatThread,
  runId: string,
): ChatThread | null {
  if (thread.chat.activeRunId === runId) return thread;
  if (thread.chat.activeRunId) return null;
  return { ...thread, chat: { ...thread.chat, activeRunId: runId } };
}

// ---- Status text, as the Codex footer words it ----

// codex-rs/tui/src/status/helpers.rs format_tokens_compact.
export function formatTokensCompact(value: number): string {
  const tokens = Math.max(0, Math.floor(value));
  if (tokens < 1_000) return String(tokens);
  const [divisor, suffix] =
    tokens >= 1e12
      ? [1e12, "T"]
      : tokens >= 1e9
        ? [1e9, "B"]
        : tokens >= 1e6
          ? [1e6, "M"]
          : [1e3, "K"];
  const scaled = tokens / divisor;
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  let text = fixed(tokens, divisor, decimals);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text + suffix;
}

// tokens / divisor to `decimals` places as Rust's {:.N} prints it. Both it
// and toFixed round the exact binary value; they differ only on an exact
// half, which Rust rounds to even and toFixed rounds up.
function fixed(tokens: number, divisor: number, decimals: number): string {
  const scale = 10 ** decimals;
  const twice = (2 * tokens * scale) / divisor;
  let den = divisor / gcd(tokens, divisor);
  while (den % 2 === 0) den /= 2;
  const exactHalf =
    Number.isSafeInteger(2 * tokens * scale) &&
    Number.isInteger(twice) &&
    twice % 2 === 1 &&
    den === 1;
  if (!exactHalf) return (tokens / divisor).toFixed(decimals);
  const low = (twice - 1) / 2;
  return ((low % 2 === 0 ? low : low + 1) / scale).toFixed(decimals);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

// codex-rs/tui/src/goal_display.rs format_goal_elapsed_seconds.
export function formatGoalElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours >= 24)
    return `${Math.floor(hours / 24)}d ${hours % 24}h ${restMinutes}m`;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

// The goal's one-line status for the card and the chat-list badge. Codex's
// footer wording without its "(/goal resume)" hint, plus Truex's review.
export function goalStatusText(goal: TenantGoal): string {
  const used = formatTokensCompact(goal.tokensUsed);
  const budget =
    goal.tokenBudget === null ? null : formatTokensCompact(goal.tokenBudget);
  if (goal.review === "pending") return "Waiting for your review";
  if (goal.review === "accepted_as_is")
    return "Goal achieved (stopped at budget)";
  switch (goal.status) {
    case "active":
      return `Pursuing goal (${
        budget === null
          ? formatGoalElapsed(goal.timeUsedSeconds)
          : `${used} / ${budget}`
      })`;
    case "paused":
      return "Goal paused";
    case "blocked":
      return "Goal stalled";
    case "usageLimited":
      return "Goal hit usage limits";
    case "budgetLimited":
      return budget === null
        ? "Goal abandoned"
        : `Goal unmet (${used} / ${budget} tokens)`;
    case "complete":
      return `Goal achieved (${
        budget === null
          ? formatGoalElapsed(goal.timeUsedSeconds)
          : `${used} tokens`
      })`;
  }
}

// ---- The platform's goal routes (owner only) ----

const goalPath = (chatId: string, rest = "") =>
  `/api/v1/chats/${encodeURIComponent(chatId)}/goal${rest}`;

function goalOf(data: unknown): TenantGoal {
  const goal = parseGoal(record(data)?.goal);
  if (!goal) throw new Error("The platform returned an unreadable goal.");
  return goal;
}

// null when the chat has no goal or goal mode ended in it.
export async function fetchGoal(chatId: string): Promise<TenantGoal | null> {
  const data = record(await api(goalPath(chatId)));
  return data?.goal === null ? null : goalOf(data);
}

// A retry with the same clientRequestId returns the goal it started.
export const startGoal = async (
  chatId: string,
  start: { clientRequestId: string; objective?: string; tokenBudget: number },
) => goalOf(await api(goalPath(chatId), start));

export const editGoal = async (chatId: string, objective: string) =>
  goalOf(await api(goalPath(chatId), { objective }, auth, "PATCH"));

const action = (rest: string) => async (chatId: string) =>
  goalOf(await api(goalPath(chatId, rest), undefined, auth, "POST"));

export const pauseGoal = action("/pause");
export const resumeGoal = action("/resume");
export const approveGoal = action("/approve");
// For a goal out of budget at the chat's maximum.
export const acceptGoal = action("/accept");

export const requestGoalChanges = async (
  chatId: string,
  feedback: string,
  tokenBudget?: number,
) =>
  goalOf(
    await api(
      goalPath(chatId, "/request-changes"),
      tokenBudget === undefined ? { feedback } : { feedback, tokenBudget },
    ),
  );

export const raiseGoalBudget = async (chatId: string, tokenBudget: number) =>
  goalOf(await api(goalPath(chatId, "/budget"), { tokenBudget }));

// Ends goal mode in the chat; past turns stay.
export async function clearGoal(chatId: string): Promise<void> {
  await api(goalPath(chatId), undefined, auth, "DELETE");
}

// The owner's chat event stream: a snapshot ({goal, activeRunId}), then
// goal.updated, goal.cleared and run.started. It never sends `saved`; it ends
// only when it cannot be followed.
export function followChatEvents(
  chatId: string,
  handlers: FollowHandlers,
  deps: FollowDeps = {},
): () => void {
  return followStream(
    `/api/v1/chats/${encodeURIComponent(chatId)}/events`,
    handlers,
    deps,
  );
}

// Watches the open chat: every goal event goes to onGoalEvent (fold it with
// applyGoalEvent), and each goal run to follow to onRun: the run a
// (re)connect's snapshot names, then each run.started. A run.started
// without a usable run ID is dropped.
export function watchChatGoal(
  chatId: string,
  handlers: {
    onGoalEvent(event: { type: string; data: unknown }): void;
    onRun(runId: string): void;
    onEnd?(end: StreamEnd): void;
  },
  deps: FollowDeps = {},
): () => void {
  return followChatEvents(
    chatId,
    {
      onEvent: (event) => {
        const runId = goalRunOf(event);
        if (event.type === "run.started" && !runId) return;
        handlers.onGoalEvent(event);
        if (runId) handlers.onRun(runId);
      },
      onEnd: (end) => handlers.onEnd?.(end),
    },
    deps,
  );
}

// ---- Starting a goal ----

// Codex counts an objective in characters, after NFC (goal-input.ts).
export const objectiveLength = (text: string) =>
  [...text.normalize("NFC")].length;

// Why the objective can't be sent, or null.
export function objectiveProblem(text: string): string | null {
  if (!text.trim()) return "Describe the goal.";
  const length = objectiveLength(text);
  return length > MAX_GOAL_OBJECTIVE
    ? `Keep the goal to 4,000 characters (now ${length.toLocaleString("en-US")}).`
    : null;
}

type GoalChat = Pick<ChatSummary, "goals" | "goal" | "readOnly">;

// The budgets a goal in this chat can start with: the workspace's presets,
// within the maximum the chat was created with.
export function goalPresets(
  chat: GoalChat,
  settings: GoalSettings | null,
): number[] {
  const max = chat.goals?.maxTokenBudget;
  return settings && max ? settings.presets.filter((p) => p <= max) : [];
}

// Whether the Goal button shows: goals are on in the chat and the
// workspace, the chat can continue, and it has never had a goal (one per
// chat; none after clear).
export function goalOffer({
  chat,
  settings,
  state,
}: {
  chat: GoalChat;
  settings: GoalSettings | null;
  state: GoalState;
}): boolean {
  return (
    !chat.readOnly &&
    !chat.goal &&
    !state.goal &&
    !state.ended &&
    goalPresets(chat, settings).length > 0
  );
}

// What the start dialog says when the platform refuses: its own words for
// GOAL_LIMIT and objective problems, which name the fix.
export function goalStartFailure(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.message
    : userMessage(error, "The goal didn't start. Try again.");
}

// ---- The goal card ----

// A goal the agent proposed (create_goal): paused by the platform until the
// owner chooses a budget.
export const isProposed = (goal: TenantGoal) =>
  goal.origin === "model" && goal.status === "paused";

// The statuses Codex's footer offers "/goal resume" for.
const RESUMABLE: readonly GoalStatus[] = ["paused", "blocked", "usageLimited"];

// What the card offers for a goal, as the platform allows it.
export function goalActions(goal: TenantGoal) {
  const proposed = isProposed(goal);
  return {
    edit: !proposed && (goal.status === "active" || goal.status === "paused"),
    pause: goal.status === "active",
    resume: !proposed && RESUMABLE.includes(goal.status),
    clear: true,
  };
}

// "Resume paused goal?" is asked for a goal stopped by Stop, a stall or
// usage limits; a proposed goal asks for a budget instead.
export const resumePrompt = (goal: TenantGoal | null) =>
  !!goal && !isProposed(goal) && RESUMABLE.includes(goal.status);

// Decides the resume prompt once per opening of a chat, from the first goal
// it shows; a later pause in the same opening (Stop) never asks.
export function promptOnOpen(
  prev: { chatId: string; show: boolean } | null,
  chatId: string | null,
  goal: TenantGoal | null,
): { chatId: string; show: boolean } | null {
  if (chatId && prev?.chatId === chatId) return prev;
  if (!chatId || !goal) return null;
  return { chatId, show: resumePrompt(goal) };
}

export type GoalAction =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "edit"; objective: string }
  // A proposed goal started with one of the workspace's budgets.
  | { kind: "start"; tokenBudget: number }
  // The review of a goal Codex marked complete, and its budget.
  | { kind: "approve" }
  | { kind: "accept" }
  | { kind: "changes"; feedback: string; tokenBudget?: number }
  | { kind: "raise"; tokenBudget: number };

// ---- The review and the budget ----

// The objective's length once the platform merges the feedback into it
// (goal-input.ts mergeFeedback, after trimming the feedback).
export const mergedObjectiveLength = (objective: string, feedback: string) =>
  objectiveLength(`${objective}\n\nChanges requested: ${feedback.trim()}`);

// The budgets a goal can be raised to: the workspace's presets and the
// chat's maximum, above what it has used (Codex stays budget-limited
// otherwise) and above its budget, at most the maximum.
export function raiseOptions(
  goal: TenantGoal,
  presets: readonly number[],
  maxTokenBudget: number,
): number[] {
  if (goal.origin === "model") return [];
  const floor = Math.max(goal.tokensUsed, goal.tokenBudget ?? 0);
  return [...new Set([...presets, maxTokenBudget])]
    .filter((budget) => budget > floor && budget <= maxTokenBudget)
    .sort((a, b) => a - b);
}

// Only a goal that used its whole budget at the chat's maximum.
export const canAcceptAsIs = (goal: TenantGoal, maxTokenBudget: number) =>
  goal.status === "budgetLimited" &&
  goal.tokenBudget === maxTokenBudget &&
  goal.review !== "accepted_as_is";

// ---- The chat-list badge ----

// The badge for a chat's goal: Codex's footer words without the numbers,
// plus Truex's review. Text, so the state never rests on colour.
export function goalBadge(
  badge: ChatSummary["goal"] | undefined,
): { text: string } | null {
  if (!badge) return null;
  if (badge.review === "pending") return { text: "Waiting for your review" };
  if (badge.review === "approved" || badge.review === "accepted_as_is")
    return { text: "Goal achieved" };
  const text: Record<GoalStatus, string> = {
    active: "Pursuing goal",
    paused: "Goal paused",
    blocked: "Goal stalled",
    usageLimited: "Goal hit usage limits",
    budgetLimited: "Goal unmet",
    complete: "Goal achieved",
  };
  return { text: text[badge.status] };
}

// The chat list with the open chat's badge taken from its goal stream, so a
// goal finishing in the open chat updates its row without a reload. The same
// list when nothing changed.
export function withGoalBadge(
  chats: ChatSummary[],
  chatId: string,
  state: GoalState,
): ChatSummary[] {
  const index = chats.findIndex((chat) => chat.id === chatId);
  if (index < 0) return chats;
  const row = chats[index]!;
  let next: ChatSummary["goal"];
  if (state.ended) next = null;
  else if (state.goal)
    next = { status: state.goal.status, review: state.goal.review };
  else return chats;
  if (row.goal?.status === next?.status && row.goal?.review === next?.review)
    return chats;
  const copy = chats.slice();
  copy[index] = { ...row, goal: next };
  return copy;
}
