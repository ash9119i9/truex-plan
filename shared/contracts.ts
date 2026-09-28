import type { AskForApproval } from "./protocol/v2/AskForApproval";
import type { SandboxMode } from "./protocol/v2/SandboxMode";
export interface Agent {
  _id: string;
  name: string;
  description: string;
  modelProfileId: string;
  systemPrompt: string;
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  mcpProfileIds: string[];
}
/** How a provider is spoken to. Only "responses" is native to Codex. */
export const WIRE_APIS = ["responses", "chat", "anthropic", "gemini"] as const;
export type WireApi = (typeof WIRE_APIS)[number];
/** "direct": Codex calls the provider. "gateway": via the model gateway. */
export type ModelRoute = "direct" | "gateway";
export interface ModelProfile {
  _id: string;
  provider: string;
  baseUrl: string;
  modelName: string;
  reasoningEffort: string;
  apikey: string;
  wireApi: WireApi;
  route?: ModelRoute;
  contextWindow?: number;
  autoCompactTokenLimit?: number;
}
export interface McpProfile {
  _id: string;
  name: string;
  config: Record<string, unknown>;
}
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  sandbox: string;
}
export interface Session {
  runtimePolicyVersion?: number;
  settings?: {
    model?: string;
    effort?: string;
    summary?: string;
    serviceTier?: string | null;
    personality?: string;
  };
  _id: string;
  agentId: string;
  title?: string;
  threadId: string;
  agentCoreHost: string;
  status: "active" | "orphaned" | "dead";
  cwd: string;
  createdAt: string;
  cursor?: string;
  approvals?: Record<string, unknown>[];
  timings?: TurnTiming[];
  goal?: SessionGoal;
  goalReview?: GoalReview;
  // The last cleared goal, so a replayed older update can't restore it.
  goalCleared?: { createdAt: number | null; eventAt?: string };
  goalHistory?: GoalHistoryEntry[];
  archived?: boolean;
  threadStartMs?: number;
  runtimeStartup?: { spawnMs: number; initializeMs: number };
}
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";
// Public projection of the runtime goal. Timestamps are runtime epoch values.
export interface Goal {
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number | null;
  updatedAt: number | null;
  // Tokens Truex counted for this goal. The runtime's tokensUsed misses usage
  // reported after a goal completes, so the UI shows the larger of the two.
  tokensObserved?: number;
}
// Summary kept on the session for the conversation list.
export interface SessionGoal {
  objective: string;
  status: GoalStatus;
  updatedAt?: string;
  createdAt?: number | null;
  tokensObserved?: number;
  tokenBudget?: number | null;
  // Codex's updatedAt (epoch seconds) for the saved goal.
  goalUpdatedAt?: number | null;
  // Agent-core event time of the saved goal, when it came from an event.
  goalEventAt?: string;
}
// One change in the conversation's goal, for the goal timeline.
export interface GoalHistoryEntry {
  at: string;
  kind:
    | "set"
    | "objective"
    | "budget"
    | "status"
    | "accepted"
    | "reopened"
    | "cleared";
  objective: string;
  status?: GoalStatus;
  tokens?: number;
  tokenBudget?: number | null;
  feedback?: string;
  // Turn that made the change, when known.
  turnId?: string;
  // Codex's own token count at that moment.
  tokensUsed?: number;
}
// The agent marks a goal complete; the user confirms or reopens it.
export interface GoalReview {
  objective: string;
  goalCreatedAt: number | null;
  decision: "accepted" | "reopened";
  feedback?: string;
  at: string;
}
export interface CommandRecord {
  method: string;
  params: Record<string, unknown>;
  state: "running" | "succeeded" | "failed" | "unknown";
  afterMessageId?: string;
  result?: {
    help?: string;
    goal?: Goal | null;
    sessionId?: string;
  };
  error?: string;
}
export interface Message {
  command?: CommandRecord;
  _id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  turnId?: string;
  itemId?: string;
  clientId?: string;
  delivery?: "pending" | "accepted" | "failed" | "unknown";
  steer?: boolean;
  order?: number;
  messageIndex?: number;
  runtimeItemId?: string;
}
export interface TurnTiming {
  turnId: string;
  acceptMs: number | null;
  ttftMs: number | null;
  streamMs: number;
  adapterStreamMs: number;
  idleStreamMs: number;
  maxGapMs: number;
  deltaRate: number;
  finalizeMs: number;
  totalMs: number;
  deltaCount: number;
  nonStreaming: boolean;
  status: string;
}
// A resolved input request as the chat's audit trail shows it.
export interface ApprovalRecord {
  requestId: string;
  at?: string;
  turnId?: string;
  outcome: "answered" | "expired" | "interrupted";
  items: (
    | {
        kind: "toolApproval";
        action?: string;
        decision:
          | "allowedOnce"
          | "allowedSession"
          | "allowedAlways"
          | "declined"
          | "expired"
          | "interrupted";
      }
    | { kind: "question"; question: string; answer?: string; secret?: true }
  )[];
}
export interface PendingRequest {
  requestId: string;
  method: string;
  detail: Record<string, unknown>;
  expiresAt: string;
  responseSchema: string | null;
}
export type TurnState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" | "interrupting"; turnId: string };
export type DomainType =
  | "session.created"
  | "thread.started"
  | "turn.started"
  | "turn.completed"
  | "message.delta"
  | "message.final"
  | "reasoning.delta"
  | "item.started"
  | "item.completed"
  | "mcp.status"
  | "error"
  | "approval.requested"
  | "approval.resolved"
  | "plan.updated"
  | "goal.updated"
  | "goal.cleared"
  | "diff.updated"
  | "activity.updated"
  | "subagent.spawned"
  | "subagent.status"
  | "subagent.completed"
  | "subagent.event"
  | "runtime.event"
  | "snapshot"
  | "resync.required";
export interface DomainEvent {
  type: DomainType;
  seq: number;
  cursor: string;
  at: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  data: Record<string, any>;
}
export interface Snapshot {
  thinking?: {
    id: string;
    turnId?: string;
    summary: string;
    raw: string;
    done: boolean;
  }[];
  cursor: string;
  state: TurnState;
  pending: PendingRequest[];
  messages: {
    id: string;
    turnId?: string;
    text: string;
    final: boolean;
    messageIndex?: number;
  }[];
  plan: unknown;
  goal?: unknown;
  diff: string;
  timings: TurnTiming[];
  subAgents?: SubAgent[];
}

// Mirrors the runtime's CollabAgentStatus.
export type SubAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";
// A helper agent spawned by the session's main agent. Public projection only:
// never carries raw tool arguments.
export interface SubAgent {
  threadId: string;
  path: string | null;
  nickname: string | null;
  role: string | null;
  depth: number;
  status: SubAgentStatus;
  task?: string;
  lastMessage?: string;
  startedAt: string;
  endedAt?: string;
}
// Read-only transcript of one helper agent.
export interface SubAgentTranscript {
  agent: SubAgent;
  messages: { id: string; text: string; final: boolean }[];
}
export type CollabTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent";

export type PublicSession = Pick<
  Session,
  "_id" | "agentId" | "title" | "status" | "createdAt" | "goal"
>;
