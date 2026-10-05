import { randomUUID } from "node:crypto";
import {
  AGENT_INSTRUCTIONS_MAX,
  AGENT_LOOK_COUNT,
  AGENT_NAME_MAX,
  AGENT_PURPOSE_MAX,
  AGENT_TINTS,
  DEFAULT_AGENT_LOOK,
  DEFAULT_AGENT_TINT,
  agentHandle,
  type AgentTint,
  type ModelOption,
} from "../../shared/contracts";
import type { AgentDocument, ModelDocument } from "./documents";
import type { Store } from "./store";
import { ApiError } from "./errors";
import {
  gatewayAddressIssue,
  gatewaySettings,
  resolveRoute,
} from "./model-route";

export const DEFAULT_CHAT_AGENT_ID = "truex-general";

/** Default chat must be runnable with the current routing configuration. */
export function defaultChatRouteUsable(
  profile: ModelDocument,
  remoteRuntime: boolean,
): boolean {
  try {
    if (resolveRoute(profile).route === "direct") return true;
    const gateway = gatewaySettings();
    return (
      !!gateway && gatewayAddressIssue(gateway.url, remoteRuntime) === null
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      ["UNSUPPORTED_WIRE_API", "UNSUPPORTED_MODEL_ROUTE"].includes(error.code)
    )
      return false;
    throw error;
  }
}

/** Provision once in the current tenant. Never rewrite existing configuration. */
export async function ensureDefaultChatAgent(
  store: Store,
  models: ModelOption[],
) {
  if (await store.agents.findOne({ _id: DEFAULT_CHAT_AGENT_ID })) return;
  const model = [...models].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )[0];
  if (!model) return;
  const agent: AgentDocument = {
    _id: DEFAULT_CHAT_AGENT_ID,
    name: "Truex",
    description: "General assistant",
    systemPrompt:
      "You are Truex, a helpful general assistant. Answer clearly and directly.",
    scope: "general",
    modelProfileId: model.id,
    sandbox: "read-only",
    approvalPolicy: "on-request",
    mcpProfileIds: [],
    skillIds: [],
    look: DEFAULT_AGENT_LOOK,
    tint: DEFAULT_AGENT_TINT,
    builtin: true,
    isDefault: true,
    enabled: true,
  };
  try {
    await store.agents.updateOne(
      { _id: DEFAULT_CHAT_AGENT_ID },
      { $setOnInsert: agent },
      { upsert: true },
    );
  } catch (error: any) {
    // An overlapping first request may have inserted this same reserved id.
    if (
      error?.code !== 11000 ||
      !(await store.agents.findOne({ _id: DEFAULT_CHAT_AGENT_ID }))
    )
      throw error;
  }
}

export function isDefaultChatAgent(agent: AgentDocument): boolean {
  return (
    agent._id === DEFAULT_CHAT_AGENT_ID &&
    agent.isDefault === true &&
    agent.builtin === true &&
    agent.scope === "general"
  );
}

// Everything else (sandbox, persona, builtin, skills, MCP) is server-owned.
const FIELDS = new Set([
  "name",
  "description",
  "systemPrompt",
  "look",
  "tint",
  "modelProfileId",
]);

function invalid(message: string): never {
  throw new ApiError(400, message, "INVALID_INPUT");
}
function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") invalid(`${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max)
    invalid(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

/** Validates editable fields; the model is checked by the caller. */
export function editableAgentFields(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    invalid("Agent details are required");
  const input = body as Record<string, unknown>;
  const extra = Object.keys(input).filter((k) => !FIELDS.has(k));
  if (extra.length) invalid(`Unsupported agent fields: ${extra.join(", ")}`);
  const name = text(input.name, "Name", AGENT_NAME_MAX);
  if (!name) invalid("Name is required");
  const look = input.look ?? DEFAULT_AGENT_LOOK;
  if (
    !Number.isInteger(look) ||
    (look as number) < 0 ||
    (look as number) >= AGENT_LOOK_COUNT
  )
    invalid(`Look must be a whole number from 0 to ${AGENT_LOOK_COUNT - 1}`);
  const tint = input.tint ?? DEFAULT_AGENT_TINT;
  if (!AGENT_TINTS.includes(tint as AgentTint))
    invalid(`Tint must be one of ${AGENT_TINTS.join(", ")}`);
  if (typeof input.modelProfileId !== "string" || !input.modelProfileId.trim())
    invalid("Model is required");
  return {
    name,
    description: text(input.description, "Purpose", AGENT_PURPOSE_MAX),
    systemPrompt: text(
      input.systemPrompt,
      "Instructions",
      AGENT_INSTRUCTIONS_MAX,
    ),
    look: look as number,
    tint: tint as AgentTint,
    modelProfileId: input.modelProfileId.trim(),
  };
}

/** Validates a create-agent request; the model is checked by the caller. */
export function newAgent(body: unknown): AgentDocument {
  const fields = editableAgentFields(body);
  const handle = agentHandle(fields.name);
  if (!handle)
    throw new ApiError(
      422,
      "Name needs at least one letter or digit (a–z, 0–9) to form a handle",
      "AGENT_HANDLE_INVALID",
    );
  return {
    ...fields,
    _id: "agent_" + randomUUID(),
    handle,
    scope: "general",
    // Matches what configuration() enforces for every thread today.
    sandbox: "read-only",
    approvalPolicy: "on-request",
    mcpProfileIds: [],
    skillIds: [],
    builtin: false,
    enabled: true,
  };
}
