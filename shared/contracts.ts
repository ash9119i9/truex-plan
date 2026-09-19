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
export interface ModelProfile {
  _id: string;
  provider: string;
  baseUrl: string;
  modelName: string;
  reasoningEffort: string;
  apikey: string;
  wireApi: "responses";
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
  archived?: boolean;
  threadStartMs?: number;
  runtimeStartup?: { spawnMs: number; initializeMs: number };
}
export interface Message {
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
  | "diff.updated"
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
  diff: string;
  timings: TurnTiming[];
}
