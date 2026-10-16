import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";
import { canonicalJson } from "../../common/canonical-json";
import { integer, invalid, objectWith, oneOf } from "../../common/validation";
import { parseWireId } from "../../database/object-id";
import {
  parseAgentDescription,
  parseAgentName,
  parseLook,
  parseTint,
  type AgentTint,
} from "./agent-fields";

// An agent a member created, in the tenant database's `agents`. A personal
// agent is visible only to its creator; a tenant agent to every member. Chats
// with either stay private to the person chatting.
export const AGENTS_COLLECTION = "agents";
// One document per creator and one for the tenant. Creating an agent writes
// the relevant ones first, so concurrent creates conflict and retry instead of
// both passing the limit check.
export const AGENT_QUOTA_COLLECTION = "agent_quota_locks";

export const AGENT_SCOPES = ["personal", "tenant"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
export type AgentStatus = "active" | "archived";

export const MAX_AGENTS_PER_USER = 50;
export const MAX_TENANT_AGENTS = 200;
export const DEFAULT_LOOK = 2;
export const DEFAULT_TINT: AgentTint = "ice";

export interface AgentDoc {
  _id: ObjectId;
  scope: AgentScope;
  ownerId: ObjectId;
  name: string;
  description: string;
  modelId: ObjectId;
  look: number;
  tint: AgentTint;
  status: AgentStatus;
  // Bumped by every change; edits must name the revision they started from.
  revision: number;
  // The creating request, so a retried create returns the same agent.
  clientRequestId: string;
  requestHash: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
  archivedBy?: ObjectId;
}

export interface CreateAgentInput {
  clientRequestId: string;
  scope: AgentScope;
  name: string;
  description: string;
  modelId: ObjectId;
  look: number;
  tint: AgentTint;
}

export interface UpdateAgentInput {
  revision: number;
  changes: Partial<
    Pick<AgentDoc, "name" | "description" | "modelId" | "look" | "tint">
  >;
}

// Generated once per create by the client and reused on every retry.
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

function modelIdOf(value: unknown): ObjectId {
  const id = parseWireId(value);
  if (!id) invalid("modelId must be a model ID.");
  return id;
}

export function parseCreateAgent(body: unknown): CreateAgentInput {
  const raw = objectWith(
    body,
    [
      "clientRequestId",
      "scope",
      "name",
      "description",
      "modelId",
      "look",
      "tint",
    ],
    "The request body",
  );
  if (
    typeof raw.clientRequestId !== "string" ||
    !CLIENT_REQUEST_ID.test(raw.clientRequestId)
  )
    invalid(
      "clientRequestId must be 8-128 letters, digits, hyphens or underscores.",
    );
  return {
    clientRequestId: raw.clientRequestId,
    scope: oneOf(raw.scope, "scope", AGENT_SCOPES),
    name: parseAgentName(raw.name),
    description: parseAgentDescription(raw.description),
    modelId: modelIdOf(raw.modelId),
    look: raw.look === undefined ? DEFAULT_LOOK : parseLook(raw.look),
    tint: raw.tint === undefined ? DEFAULT_TINT : parseTint(raw.tint),
  };
}

export function parseUpdateAgent(body: unknown): UpdateAgentInput {
  const raw = objectWith(
    body,
    ["revision", "name", "description", "modelId", "look", "tint"],
    "The request body",
  );
  const revision = integer(
    raw.revision,
    "revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const changes: UpdateAgentInput["changes"] = {};
  if (raw.name !== undefined) changes.name = parseAgentName(raw.name);
  if (raw.description !== undefined)
    changes.description = parseAgentDescription(raw.description);
  if (raw.modelId !== undefined) changes.modelId = modelIdOf(raw.modelId);
  if (raw.look !== undefined) changes.look = parseLook(raw.look);
  if (raw.tint !== undefined) changes.tint = parseTint(raw.tint);
  if (Object.keys(changes).length === 0)
    invalid("Give at least one of name, description, modelId, look or tint.");
  return { revision, changes };
}

// Identifies what a create asked for, so a retry with a different body under
// the same clientRequestId is refused rather than answered with another agent.
export function requestHashOf(input: CreateAgentInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        scope: input.scope,
        name: input.name,
        description: input.description,
        modelId: input.modelId.toHexString(),
        look: input.look,
        tint: input.tint,
      }),
    )
    .digest("hex");
}
