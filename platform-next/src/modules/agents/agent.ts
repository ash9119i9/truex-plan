import { createHash } from "node:crypto";
import type { IndexDescription, ObjectId } from "mongodb";
import { canonicalJson } from "../../common/canonical-json";
import { integer, invalid, objectWith, oneOf } from "../../common/validation";
import { parseWireId } from "../../database/object-id";
import { MAX_AGENT_SKILLS } from "../skills/skill";
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

// Built when the tenant is provisioned (see tenant-indexes.ts). The unique
// index is what makes create idempotent.
export const AGENT_INDEXES: Readonly<Record<string, IndexDescription[]>> = {
  [AGENTS_COLLECTION]: [
    {
      key: { ownerId: 1, clientRequestId: 1 },
      name: "owner_request_unique",
      unique: true,
    },
    // The creator's agents (limit count, personal listing).
    { key: { ownerId: 1, status: 1, scope: 1 }, name: "by_owner" },
    // The tenant's shared agents (limit count, listing).
    { key: { scope: 1, status: 1 }, name: "by_scope" },
  ],
};

export const AGENT_SCOPES = ["personal", "tenant"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
export type AgentStatus = "active" | "archived";

export const MAX_AGENTS_PER_USER = 50;
export const MAX_TENANT_AGENTS = 200;
export const DEFAULT_LOOK = 2;
export const DEFAULT_TINT: AgentTint = "ice";
// At most this many directory connectors per agent (Build contract: the
// adapter rejects more than 3 MCP servers).
export const MAX_AGENT_CONNECTORS = 3;

// The catalog slug pattern connectors use (see connectors/connector.ts). A
// slug that cannot match is refused before any catalog lookup.
const CONNECTOR_SLUG = /^[a-z][a-z0-9_]{1,30}$/;

// How much of a connector an agent may use. read_write (the default, and what
// a bare slug means) keeps the connector's write tools, each gated by the
// member's per-call approval; read_only removes the write tools entirely.
export const CONNECTOR_ACCESS = ["read_write", "read_only"] as const;
export type ConnectorAccess = (typeof CONNECTOR_ACCESS)[number];

// A connector an agent uses, pinned by catalog ID so a slug reuse cannot
// repoint it, with the slug kept to build views and the chat snapshot without
// a catalog read. Absent on agents created before connectors existed.
// `access` is absent for read_write, so documents written before write access
// existed keep their read_write meaning.
export interface AgentConnector {
  connectorId: ObjectId;
  slug: string;
  access?: "read_only";
}

// One connector a create/edit attached: a slug and the chosen access. A bare
// slug string in the request body is read_write.
export interface AgentConnectorRequest {
  slug: string;
  access: ConnectorAccess;
}

export interface AgentDoc {
  _id: ObjectId;
  scope: AgentScope;
  ownerId: ObjectId;
  name: string;
  description: string;
  modelId: ObjectId;
  look: number;
  tint: AgentTint;
  // The directory connectors this agent uses. Absent on documents created
  // before connectors existed, read as an empty list everywhere.
  connectors?: AgentConnector[];
  // Catalog skills, in the member's order. A new chat snapshots each enabled
  // one's current version. Absent on documents created before skills
  // existed, read as an empty list everywhere.
  skillIds?: ObjectId[];
  // The agent may start helper agents during a reply (only where the server
  // has CHAT_SUBAGENTS). Absent means off.
  helpers?: true;
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
  // Catalog connectors the creator attached (slug + access). Resolved to
  // AgentConnector[] by the service against the enabled catalog; empty when
  // none were given.
  connectors: AgentConnectorRequest[];
  // Catalog skill IDs; checked by the service against the catalog.
  skillIds: ObjectId[];
  helpers: boolean;
}

export interface UpdateAgentInput {
  revision: number;
  changes: Partial<
    Pick<AgentDoc, "name" | "description" | "modelId" | "look" | "tint">
  >;
  // Absent (undefined) leaves the agent's connectors unchanged; a list (even
  // empty) replaces them. Resolved to AgentConnector[] by the service.
  connectors?: AgentConnectorRequest[];
  // Absent leaves the agent's skills unchanged; a list (even empty) replaces
  // them.
  skillIds?: ObjectId[];
  // Absent leaves the setting unchanged.
  helpers?: boolean;
}

// Generated once per create by the client and reused on every retry.
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

function modelIdOf(value: unknown): ObjectId {
  const id = parseWireId(value);
  if (!id) invalid("modelId must be a model ID.");
  return id;
}

// The connectors a create or edit attached: at most MAX_AGENT_CONNECTORS
// entries, each a bare slug string (= read_write) or a { slug, access }
// object, with unique slugs. Shape only; whether each names an enabled
// connector is checked by the service against the catalog.
function parseConnectorRequests(value: unknown): AgentConnectorRequest[] {
  if (!Array.isArray(value)) invalid("connectors must be an array.");
  if (value.length > MAX_AGENT_CONNECTORS)
    invalid(`connectors must have at most ${MAX_AGENT_CONNECTORS} entries.`);
  const requests: AgentConnectorRequest[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const request = parseConnectorRequest(entry);
    if (seen.has(request.slug))
      invalid(`connectors must not repeat "${request.slug}".`);
    seen.add(request.slug);
    requests.push(request);
  }
  return requests;
}

// Skill IDs: at most MAX_AGENT_SKILLS, no repeats. Shape only.
function parseSkillIds(value: unknown): ObjectId[] {
  if (!Array.isArray(value)) invalid("skillIds must be an array.");
  if (value.length > MAX_AGENT_SKILLS)
    invalid(`An agent can use at most ${MAX_AGENT_SKILLS} skills.`);
  const ids: ObjectId[] = [];
  for (const entry of value) {
    const id = parseWireId(entry);
    if (!id) invalid("skillIds must be skill IDs.");
    if (ids.some((seen) => seen.equals(id)))
      invalid("skillIds must not repeat a skill.");
    ids.push(id);
  }
  return ids;
}

function parseHelpers(value: unknown): boolean {
  if (typeof value !== "boolean") invalid("helpers must be true or false.");
  return value;
}

function parseConnectorRequest(value: unknown): AgentConnectorRequest {
  if (typeof value === "string") {
    if (!CONNECTOR_SLUG.test(value))
      invalid("connectors must be connector slugs.");
    return { slug: value, access: "read_write" };
  }
  const raw = objectWith(value, ["slug", "access"], "A connector");
  if (typeof raw.slug !== "string" || !CONNECTOR_SLUG.test(raw.slug))
    invalid("connectors must be connector slugs.");
  const access =
    raw.access === undefined
      ? ("read_write" as const)
      : oneOf(raw.access, "connectors.access", CONNECTOR_ACCESS);
  return { slug: raw.slug, access };
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
      "connectors",
      "skillIds",
      "helpers",
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
    connectors:
      raw.connectors === undefined
        ? []
        : parseConnectorRequests(raw.connectors),
    skillIds: raw.skillIds === undefined ? [] : parseSkillIds(raw.skillIds),
    helpers: raw.helpers === undefined ? false : parseHelpers(raw.helpers),
  };
}

export function parseUpdateAgent(body: unknown): UpdateAgentInput {
  const raw = objectWith(
    body,
    [
      "revision",
      "name",
      "description",
      "modelId",
      "look",
      "tint",
      "connectors",
      "skillIds",
      "helpers",
    ],
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
  const connectors =
    raw.connectors === undefined
      ? undefined
      : parseConnectorRequests(raw.connectors);
  const skillIds =
    raw.skillIds === undefined ? undefined : parseSkillIds(raw.skillIds);
  const helpers =
    raw.helpers === undefined ? undefined : parseHelpers(raw.helpers);
  if (
    Object.keys(changes).length === 0 &&
    connectors === undefined &&
    skillIds === undefined &&
    helpers === undefined
  )
    invalid(
      "Give at least one of name, description, modelId, look, tint, connectors, skillIds or helpers.",
    );
  return {
    revision,
    changes,
    ...(connectors !== undefined ? { connectors } : {}),
    ...(skillIds !== undefined ? { skillIds } : {}),
    ...(helpers !== undefined ? { helpers } : {}),
  };
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
        // Order matters to the caller, so the connectors are hashed as given:
        // a retry with the same connectors and access in the same order is the
        // same create. requestHashOf includes access, so a retry that only
        // flips access is a different create.
        connectors: input.connectors.map((c) => ({
          slug: c.slug,
          access: c.access,
        })),
        // Only when set, so creates without skills hash as they always did.
        ...(input.skillIds.length
          ? { skillIds: input.skillIds.map((id) => id.toHexString()) }
          : {}),
        ...(input.helpers ? { helpers: true } : {}),
      }),
    )
    .digest("hex");
}
