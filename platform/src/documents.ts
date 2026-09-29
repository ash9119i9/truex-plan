import { ObjectId } from "mongodb";
import type { Agent } from "../../shared/contracts";
export type DatabaseId = string | ObjectId;
export interface AgentDocument extends Omit<
  Partial<Agent>,
  "_id" | "modelProfileId" | "mcpProfileIds" | "skillIds"
> {
  _id: DatabaseId;
  name: string;
  modelProfileId: DatabaseId;
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
  enabled?: boolean;
}
export interface McpDocument {
  _id: DatabaseId;
  name: string;
  enabled?: boolean;
  transport?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  apiKey?: string;
  apikey?: string;
  auth?: { kind: "header" | "bearer" | "none"; headerName?: string };
  capabilities?: { connectTimeoutMs?: number; requestTimeoutMs?: number };
  config?: Record<string, unknown>;
}
export function idCandidates(id: DatabaseId): DatabaseId[] {
  const text = String(id);
  return ObjectId.isValid(text) ? [text, new ObjectId(text)] : [text];
}
