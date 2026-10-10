import { ObjectId } from "mongodb";
import type { Agent } from "../../shared/contracts";
import type { EncryptedSecret } from "./secrets";
import type { PromptCachePolicy } from "../../shared/prompt-cache";
export type DatabaseId = string | ObjectId;
export interface AgentDocument extends Omit<
  Partial<Agent>,
  "_id" | "modelProfileId" | "mcpProfileIds" | "skillIds"
> {
  _id: DatabaseId;
  name: string;
  modelProfileId: DatabaseId;
  /** Legacy: no longer read. MCP attachments live in McpDocument.agentIds
   * (scripts/migrate-mcp-scopes.mjs moved them there). */
  mcpProfileIds?: DatabaseId[];
  /** Catalog skills (truex_skills) given to the agent's threads. */
  skillIds?: DatabaseId[];
  enabled?: boolean;
}
export interface ModelDocument {
  _id: DatabaseId;
  displayName?: string;
  provider: string;
  baseUrl: string;
  modelName: string;
  apikey?: string;
  apiKey?: string;
  wireApi?: string;
  /** Overrides the route implied by wireApi; see model-route.ts. */
  route?: string;
  /** Codex has no metadata for non-OpenAI models; set limits explicitly. */
  contextWindow?: number;
  autoCompactTokenLimit?: number;
  reasoningEffort?: string;
  serviceTier?: string;
  webSearch?: "disabled" | "cached" | "live";
  promptCache?: PromptCachePolicy;
  enabled?: boolean;
}
export type McpScope = "tenant" | "user";
export interface McpDocument {
  _id: DatabaseId;
  name: string;
  /** "tenant": managed by tenant admins, loads in every chat of an attached
   * agent. "user": owned by ownerId, loads only in that person's chats.
   * Unset only on profiles the migration has not reached (never loaded). */
  scope?: McpScope;
  ownerId?: string;
  /** Agents this MCP loads for, as String(agent._id). */
  agentIds?: string[];
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  enabled?: boolean;
  transport?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Credentials are stored directly; apiKey takes precedence over apikey.
  apiKey?: string;
  apikey?: string;
  /** Read compatibility only; replaced with apiKey when the key is updated. */
  apiKeyEnc?: EncryptedSecret;
  auth?: McpAuth;
  capabilities?: McpCapabilities;
  // Written by scripts only; the API never sets it.
  config?: Record<string, unknown>;
}
export interface McpAuth {
  kind: "header" | "bearer" | "none";
  headerName?: string;
}
export interface McpCapabilities {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}
export function idCandidates(id: DatabaseId): DatabaseId[] {
  const text = String(id);
  return ObjectId.isValid(text) ? [text, new ObjectId(text)] : [text];
}
