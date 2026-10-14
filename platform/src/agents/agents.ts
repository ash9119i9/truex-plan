import { randomUUID } from "node:crypto";
import {
  AGENT_INSTRUCTIONS_MAX,
  AGENT_LOOK_COUNT,
  AGENT_NAME_MAX,
  AGENT_PURPOSE_MAX,
  AGENT_TINTS,
  DEFAULT_AGENT_LOOK,
  DEFAULT_AGENT_TINT,
  GENERAL_AGENT_ID,
  GENERAL_AGENT_HANDLE,
  agentHandle,
  type AgentTint,
} from "../../../shared/contracts";
import type { AgentDocument } from "../persistence/configuration-documents";
import { ApiError } from "../core/errors";
import { currentTenant } from "../tenancy/tenant";

export function hasGeneralAgent() {
  return (
    currentTenant()?.id ===
    (process.env.DEFAULT_SIGNUP_TENANT_ID?.trim() || "default-tenant")
  );
}

/** Code-owned: one shared definition, with no customer owner or per-user copies. */
export function generalAgent(modelProfileId: string): AgentDocument {
  return {
    _id: GENERAL_AGENT_ID,
    name: "General Agent",
    handle: GENERAL_AGENT_HANDLE,
    description:
      "Your everyday assistant for questions, writing, research, and planning.",
    systemPrompt:
      "Help with everyday questions, writing, research, analysis, planning, and technical work. Adapt to the user's goal, explain clearly, and be honest about uncertainty. Use available tools when useful and ask for missing information when needed.",
    modelProfileId,
    scope: "general",
    sandbox: "read-only",
    approvalPolicy: "on-request",
    look: DEFAULT_AGENT_LOOK,
    tint: DEFAULT_AGENT_TINT,
    builtin: true,
    enabled: true,
    mcpProfileIds: [],
    skillIds: [],
  };
}

export function isGeneralAgent(agent: {
  _id?: unknown;
  builtin?: boolean;
  createdBy?: string;
}) {
  return (
    hasGeneralAgent() &&
    String(agent._id) === GENERAL_AGENT_ID &&
    agent.builtin === true &&
    !agent.createdBy
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

/**
 * Validates a create-agent request; the model is checked by the caller.
 * `createdBy` is the signed-in user's id, set here and never taken from the
 * body (an unknown field in the body is rejected above).
 */
export function newAgent(body: unknown, createdBy?: string): AgentDocument {
  if (!body || typeof body !== "object" || Array.isArray(body))
    invalid("Agent details are required");
  const input = body as Record<string, unknown>;
  const extra = Object.keys(input).filter((k) => !FIELDS.has(k));
  if (extra.length) invalid(`Unsupported agent fields: ${extra.join(", ")}`);
  const name = text(input.name, "Name", AGENT_NAME_MAX);
  if (!name) invalid("Name is required");
  const handle = agentHandle(name);
  if (!handle)
    throw new ApiError(
      422,
      "Name needs at least one letter or digit (a–z, 0–9) to form a handle",
      "AGENT_HANDLE_INVALID",
    );
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
    _id: "agent_" + randomUUID(),
    name,
    handle,
    description: text(input.description, "Purpose", AGENT_PURPOSE_MAX),
    systemPrompt: text(
      input.systemPrompt,
      "Instructions",
      AGENT_INSTRUCTIONS_MAX,
    ),
    scope: "general",
    look: look as number,
    tint: tint as AgentTint,
    modelProfileId: input.modelProfileId.trim(),
    // Matches what configuration() enforces for every thread today.
    sandbox: "read-only",
    approvalPolicy: "on-request",
    mcpProfileIds: [],
    skillIds: [],
    builtin: false,
    enabled: true,
    ...(createdBy ? { createdBy } : {}),
  };
}
