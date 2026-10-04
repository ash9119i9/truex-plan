import type { AskForApproval } from "./protocol/v2/AskForApproval";
import type { SandboxMode } from "./protocol/v2/SandboxMode";
export interface Agent {
  _id: string;
  name: string;
  description: string;
  modelProfileId: string;
  systemPrompt: string;
  /** Replaces the default Truex identity line; platform guardrails still apply. */
  persona?: string;
  /** "general" lifts the business-only framing. Defaults to "business". */
  scope?: "business" | "general";
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  mcpProfileIds: string[];
  /** Catalog skill ids; shared across tenants, subject to allowedSkillIds. */
  skillIds?: string[];
  /** Mention handle without "@"; unique per tenant. See agentHandle(). */
  handle?: string;
  /** Robot look index, 0 to AGENT_LOOK_COUNT - 1. */
  look?: number;
  tint?: AgentTint;
  /** Seeded by the Truex team; never set through the API. */
  builtin?: boolean;
}
export const AGENT_TINTS = ["ice", "mint", "butter", "peach", "lilac"] as const;
export type AgentTint = (typeof AGENT_TINTS)[number];
export const AGENT_LOOK_COUNT = 12;
export const DEFAULT_AGENT_LOOK = 2;
export const DEFAULT_AGENT_TINT: AgentTint = "ice";
export const AGENT_NAME_MAX = 40;
export const AGENT_PURPOSE_MAX = 80;
export const AGENT_INSTRUCTIONS_MAX = 20000;
/** "Research Scout" → "researchscout" (design spec, app.tsx:83). */
export function agentHandle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);
}
/** A model the agent dialog can offer; never carries credentials. */
export interface ModelOption {
  id: string;
  name: string;
  provider: string;
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
  handle?: string;
  look: number;
  tint: AgentTint;
  builtin: boolean;
}
export interface Session {
  runtimePolicyVersion?: number;
  /** Alpha approval mode; absent means the configured default. */
  approvalMode?: ApprovalMode;
  settings?: {
    model?: string;
    effort?: string;
    summary?: string;
    serviceTier?: string | null;
    personality?: string;
  };
  _id: string;
  /** Owner, set once on create from the signed-in user; never changes. */
  userId?: string;
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
  // Optional project folder; sessions without one are normal conversations.
  projectId?: string;
  threadStartMs?: number;
  runtimeStartup?: { spawnMs: number; initializeMs: number };
  /** sha256 of the thread's built MCP servers; agent-core reloads on change. */
  mcpFingerprint?: string;
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
  // "auto": nobody answered in time, so the recommended option was used,
  // or (with autoMode) the chat's approval mode answered it.
  outcome: "answered" | "auto" | "expired" | "interrupted";
  autoMode?: "readOnly" | "auto" | "grant";
  items: (
    | {
        kind: "toolApproval";
        action?: string;
        decision:
          | "allowedOnce"
          | "allowedSession"
          | "allowedChat"
          | "allowedAlways"
          | "declined"
          | "expired"
          | "interrupted";
      }
    | {
        kind: "question";
        question: string;
        answer?: string;
        note?: string;
        secret?: true;
      }
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
  | "usage.updated"
  | "limits.updated"
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
  // Observability traces of recent completed turns, oldest first.
  traces?: TurnTrace[];
  rateLimits?: RateLimitView | null;
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
  "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";

export type PublicSession = Pick<
  Session,
  | "_id"
  | "userId"
  | "agentId"
  | "title"
  | "status"
  | "createdAt"
  | "goal"
  | "projectId"
  | "approvalMode"
>;

// A named folder that groups sessions. A session belongs to at most one.
export interface Project {
  _id: string; // "proj_" + uuid
  /** Creator; set on create. Under chatVisibility "own" a per-user folder. */
  ownerId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

// --- Observability -------------------------------------------------------
// One timed step of a turn, in plain words. Built from Codex item events.
export type StepKind =
  | "thinking"
  | "message"
  | "command"
  | "tool"
  | "fileChange"
  | "webSearch"
  | "webRead"
  | "webCrawl"
  | "agent"
  | "other";
export interface StepSpan {
  id: string;
  kind: StepKind;
  // Plain-words label, e.g. "Ran a command", "Read 3 files". Never raw args.
  label: string;
  // "main" for the session's agent, else the helper's nickname or role.
  agent: string;
  agentThreadId: string;
  // Offset from the turn's start.
  startMs: number;
  durationMs: number | null;
  status: "running" | "completed" | "failed" | "declined";
}
// Token counts as Codex reports them (TokenUsageBreakdown).
export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
export interface TurnUsage extends TokenCounts {
  contextWindow: number | null;
  // Input tokens of the latest model request: how full the context window is.
  contextUsedTokens: number | null;
}
export interface RateLimitView {
  limitName: string | null;
  primaryUsedPercent: number | null;
  primaryWindowMins: number | null;
  primaryResetsAt: number | null;
  secondaryUsedPercent: number | null;
  secondaryWindowMins: number | null;
  secondaryResetsAt: number | null;
  reached: string | null;
  at: string;
}
export type PrivacyKind =
  | "email"
  | "phone"
  | "card"
  | "iban"
  | "ssn"
  | "aadhaar"
  | "pan"
  | "ip"
  | "secret";
export type PrivacySource =
  "userMessage" | "toolOutput" | "command" | "fileContent" | "assistant";
// Never holds a raw value: only the kind, where, how many and a masked sample.
export interface PrivacyFinding {
  kind: PrivacyKind;
  source: PrivacySource;
  count: number;
  sample: string;
}
export interface PrivacyReport {
  scannedChars: number;
  findings: PrivacyFinding[];
}
export interface TurnTrace {
  turnId: string;
  // Internal runtime id; stripped from public API responses.
  threadId?: string;
  startedAt: string;
  totalMs: number | null;
  status: string;
  model?: string;
  steps: StepSpan[];
  // Main agent usage for this turn ("last" breakdown), null if not reported.
  usage: TurnUsage | null;
  // Summed usage of helper agents that ran during this turn.
  helperUsage: TokenCounts | null;
  rateLimits: RateLimitView | null;
  privacy: PrivacyReport;
}
// Live-only, never persisted: masked reconstruction of what the model was fed.
export interface TurnContext {
  turnId: string;
  reconstructed: true;
  sections: {
    kind: "user" | "toolOutput" | "command" | "fileContent" | "assistant";
    label: string;
    text: string;
    chars: number;
  }[];
  truncated: boolean;
}
// GET /api/sessions/:id/traces response.
export interface TraceSummary {
  turns: number;
  avgTotalMs: number | null;
  p95TotalMs: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  helperTokens: number;
  privacyFindings: number;
}
export interface SessionTraces {
  traces: TurnTrace[];
  summary: TraceSummary;
}
/**
 * Alpha: how a chat handles questions and MCP tool approvals.
 * "ask" asks for everything, "readOnly" runs tools annotated readOnlyHint
 * without asking, "auto" also runs write tools and answers clarifying
 * questions with their recommended option. Plan approval and secret
 * questions always ask.
 */
export const APPROVAL_MODES = ["ask", "readOnly", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
/** Served by platform at GET /api/features; off means today's behaviour. */
export interface ApprovalModesConfig {
  enabled: boolean;
  defaultMode: ApprovalMode;
  autopilot: boolean;
  nameHeuristic: boolean;
}
/** Added by agent-core to tool approvals; Codex receives "Allow". */
export const ALLOW_FOR_CHAT = "Allow for this chat";
/** Settle reason prefix for requests answered by a mode: "auto-mode:readOnly". */
export const AUTO_MODE_REASON = "auto-mode:";
