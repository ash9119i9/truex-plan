import type { Response } from "express";
import type { TraceBuilder } from "../telemetry/trace";
import type { ToolIndex } from "./approval-policy";
import type {
  ApprovalMode,
  PendingRequest,
  TurnState,
  DomainEvent,
  Snapshot,
  TurnTiming,
  TurnTrace,
  TurnContext,
  SubAgent,
  SubAgentTranscript,
} from "../../../shared/contracts";
export interface Pending extends PendingRequest {
  rawId: string | number;
  timer: NodeJS.Timeout;
  // Approval modes: not yet shown while its mode decides, and the latest
  // decision run, so an older one cannot settle it.
  hidden?: boolean;
  reviews?: number;
}
// Alpha approval mode of a root conversation. Threads without one keep
// today's behaviour: every request waits for the user.
export interface ModeState {
  mode: ApprovalMode;
  // Treat unannotated tools named like reads (get_, list_, ...) as read-only.
  heuristic: boolean;
  // Tools the user allowed for this chat ("Allow for this chat").
  grants: Set<string>;
  // server -> tool -> read-only, from mcpServerStatus/list.
  tools?: Promise<ToolIndex>;
}
export interface Clock {
  start: number;
  accept: number | null;
  first: number | null;
  last: number | null;
  count: number;
  gap: number;
  handler: number;
  turnId?: string;
}
export interface Thread {
  id: string;
  state: TurnState;
  seq: number;
  events: DomainEvent[];
  replayBytes: number;
  subscribers: Set<Response>;
  pending: Map<string, Pending>;
  messages: Snapshot["messages"];
  thinking: NonNullable<Snapshot["thinking"]>;
  // Latest plan; kept across turns until a newer turn replaces it.
  plan: unknown;
  // Turn that produced the stored plan, so an older turn's update is ignored.
  planTurnId: string | null;
  // Turns seen on this thread, oldest first, to order plan updates.
  turnOrder: string[];
  // Latest goal reported by the runtime; one goal per conversation.
  goal: unknown;
  // Tokens seen for the current goal. The runtime only charges usage that
  // arrives while a goal is still active, so a goal finished within one model
  // call reports none; this tally counts every call of the goal's turns.
  goalTokens: GoalTokens;
  diff: string;
  timings: TurnTiming[];
  clock?: Clock;
  // Observability of the running turn, and of recent finished ones.
  trace?: TraceBuilder;
  traces: TurnTrace[];
  // Masked reconstructions of recent turns; live only, never persisted.
  contexts: Map<string, TurnContext>;
  // Text sent with turn/start, for the trace of the turn it starts.
  input?: string;
  loaded: boolean;
  // Cold resume restores runtime history, but does not rebuild this manager's
  // source transcript. Only a thread tracked continuously from creation may
  // authorize a source projection/cursor pair.
  sourceCovered: boolean;
  // MCP fingerprint the runtime thread was loaded with, from the platform.
  mcpFingerprint?: string;
  // A newer MCP configuration that arrived during a turn; applied before the
  // next turn starts, because the runtime ignores config on a running thread.
  pendingResume?: { params: any; mcpFingerprint: string };
  // Owning tenant; also kept in the runtime's thread record for restarts.
  tenantId?: string;
  threadStartMs: number;
  // Inactivity watchdog of the running turn; paused while a request waits.
  stall?: NodeJS.Timeout;
  // Turn failed by the watchdog; its late completion is not reported again.
  stalledTurn?: string;
}
// A helper agent spawned under a root conversation. Its runtime thread is
// never exposed as a session; its events reach clients on the root stream.
export interface Child {
  rootId: string;
  parentId: string;
  agent: SubAgent;
  turnId?: string;
  transcript: SubAgentTranscript["messages"];
  // Name lookups started for this helper; Codex may name it a moment late.
  nameTries?: number;
}

export interface GoalTokens {
  key: string | null;
  observed: number;
  turns: string[];
}

export type TurnEnd = { timing?: TurnTiming; trace?: TurnTrace };

export function createThread(id: string): Thread {
  return {
    id,
    state: { kind: "idle" },
    seq: 0,
    events: [],
    replayBytes: 0,
    subscribers: new Set(),
    pending: new Map(),
    messages: [],
    thinking: [],
    plan: null,
    planTurnId: null,
    turnOrder: [],
    goal: null,
    goalTokens: { key: null, observed: 0, turns: [] },
    diff: "",
    timings: [],
    traces: [],
    contexts: new Map(),
    loaded: false,
    sourceCovered: false,
    threadStartMs: 0,
  };
}

export function activeTurn(t: Thread) {
  return t.state.kind === "running" || t.state.kind === "interrupting"
    ? t.state.turnId
    : undefined;
}
