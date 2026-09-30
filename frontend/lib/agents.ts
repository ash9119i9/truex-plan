// New-agent dialog: pure helpers plus thin API wrappers so the dialog stays
// focused on UI state.
import type {
  AgentSummary,
  AgentTint,
  ModelOption,
} from "../../shared/contracts";
import { api } from "./api.ts";

/** Badge footer label: "Claude Opus 5.5" → "opus 5.5", "gpt-5" → "gpt-5". */
export function modelShort(name: string): string {
  return name.trim().toLowerCase().replace(/^claude\s+/, "");
}

export interface AgentFields {
  name: string;
  description: string;
  systemPrompt: string;
  look: number;
  tint: AgentTint;
  modelProfileId: string;
}

/** The exact POST /api/agents body; the platform rejects unknown fields. */
export function createAgentBody(fields: AgentFields): AgentFields {
  return {
    name: fields.name.trim(),
    description: fields.description.trim(),
    systemPrompt: fields.systemPrompt.trim(),
    look: fields.look,
    tint: fields.tint,
    modelProfileId: fields.modelProfileId,
  };
}

/** True when an existing agent already answers to this handle. */
export function handleTaken(handle: string, agents: AgentSummary[]): boolean {
  return !!handle && agents.some((a) => a.handle === handle);
}

export const fetchModels = (): Promise<ModelOption[]> => api("/api/models");

export const createAgent = (body: AgentFields): Promise<AgentSummary> =>
  api("/api/agents", body);
