// Agents and models in the tenant workspace (platform-next /api/v1/agents and
// /api/v1/models). Pure helpers plus thin API wrappers, so the picker and the
// dialog stay focused on UI state. Every request names this tab's tenant
// through api().
import { api } from "./api.ts";
import {
  MAX_CONNECTORS,
  parseConnectorRefs,
  type ConnectorAccess,
  type ConnectorRef,
} from "./tenant-connectors.ts";
import { MAX_SKILLS, parseSkillRefs, type SkillRef } from "./tenant-skills.ts";

export type AgentSource = "builtin" | "personal" | "tenant";
export type AgentScope = Exclude<AgentSource, "builtin">;
export type AgentTint = "ice" | "mint" | "butter" | "peach" | "lilac";

export interface TenantModel {
  id: string;
  displayName: string;
  shortLabel: string;
  family: string;
}

export interface TenantAgent {
  id: string;
  source: AgentSource;
  name: string;
  description: string;
  look: number;
  tint: AgentTint;
  model: TenantModel | null;
  available: boolean;
  // The directory connectors this agent attaches (always present, [] when
  // none). Its chats can use these connectors' read-only tools.
  connectors: ConnectorRef[];
  // The catalog skills this agent uses (always present, [] when none).
  skills: SkillRef[];
  revision: number;
  createdByMe: boolean;
  status: "active" | "archived";
  canEdit: boolean;
  canArchive: boolean;
  canPromote: boolean;
}

export interface AgentForm {
  name: string;
  description: string;
  modelId: string;
  look: number;
  tint: AgentTint;
  // Connector slugs the agent attaches, at most MAX_CONNECTORS, unique.
  connectorSlugs: string[];
  // Per-connector access, by slug. A slug absent here (or set to read_write)
  // attaches read_write; only read_only is sent as an object on the wire.
  // Only connectors with write tools offer the choice.
  connectorAccess: Record<string, ConnectorAccess>;
  // Skill IDs the agent uses, at most MAX_SKILLS, unique, in order.
  skillIds: string[];
}

// Kept in step with platform-next/src/modules/agents/agent-fields.ts.
export const AGENT_NAME_MAX = 60;
export const AGENT_DESCRIPTION_MAX = 280;
export const DEFAULT_LOOK = 2;
export const DEFAULT_TINT: AgentTint = "ice";
const TINTS: readonly AgentTint[] = ["ice", "mint", "butter", "peach", "lilac"];
const WIRE_ID = /^[0-9a-f]{24}$/;
const SOURCES: readonly AgentSource[] = ["builtin", "personal", "tenant"];

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

function parseModel(value: unknown): TenantModel | null {
  const m = value as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  const id = text(m.id, 24);
  const displayName = text(m.displayName, 200);
  const shortLabel = text(m.shortLabel, 100);
  const family = text(m.family, 50);
  if (!id || !WIRE_ID.test(id) || !displayName || shortLabel === null)
    return null;
  return { id, displayName, shortLabel, family: family ?? "other" };
}

// A malformed entry from the server is dropped rather than rendered.
export function parseAgent(value: unknown): TenantAgent | null {
  const a = value as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  const id = text(a.id, 24);
  const name = text(a.name, 200);
  const description = text(a.description, 1000);
  if (!id || !WIRE_ID.test(id) || !name || description === null) return null;
  if (!SOURCES.includes(a.source as AgentSource)) return null;
  const look =
    typeof a.look === "number" && Number.isInteger(a.look)
      ? a.look
      : DEFAULT_LOOK;
  const tint = TINTS.includes(a.tint as AgentTint)
    ? (a.tint as AgentTint)
    : DEFAULT_TINT;
  const revision =
    typeof a.revision === "number" && Number.isInteger(a.revision)
      ? a.revision
      : 0;
  return {
    id,
    source: a.source as AgentSource,
    name,
    description,
    look,
    tint,
    model: a.model === null ? null : parseModel(a.model),
    available: a.available === true,
    connectors: parseConnectorRefs(a.connectors),
    skills: parseSkillRefs(a.skills),
    revision,
    createdByMe: a.createdByMe === true,
    status: a.status === "archived" ? "archived" : "active",
    // Missing permissions mean no permission.
    canEdit: a.canEdit === true,
    canArchive: a.canArchive === true,
    canPromote: a.canPromote === true,
  };
}

function agentOf(data: unknown): TenantAgent {
  const agent = parseAgent((data as { agent?: unknown } | null)?.agent);
  if (!agent) throw new Error("The platform returned an unreadable agent.");
  return agent;
}

export async function fetchTenantAgents(): Promise<TenantAgent[]> {
  const data = await api("/api/v1/agents");
  const list = Array.isArray(data?.agents) ? data.agents : [];
  return list.flatMap((a: unknown) => {
    const agent = parseAgent(a);
    return agent ? [agent] : [];
  });
}

export async function fetchTenantModels(): Promise<TenantModel[]> {
  const data = await api("/api/v1/models");
  const list = Array.isArray(data?.models) ? data.models : [];
  return list.flatMap((m: unknown) => {
    const model = parseModel(m);
    return model ? [model] : [];
  });
}

export const createTenantAgent = async (
  form: AgentForm,
  scope: AgentScope,
  clientRequestId: string,
): Promise<TenantAgent> =>
  agentOf(
    await api("/api/v1/agents", {
      clientRequestId,
      scope,
      ...toWire(cleanForm(form)),
    }),
  );

export const updateTenantAgent = async (
  id: string,
  revision: number,
  changes: Partial<AgentForm>,
): Promise<TenantAgent> =>
  agentOf(
    await api(
      `/api/v1/agents/${encodeURIComponent(id)}`,
      { revision, ...toWire(changes) },
      undefined,
      "PATCH",
    ),
  );

export const promoteTenantAgent = async (id: string): Promise<TenantAgent> =>
  agentOf(await api(`/api/v1/agents/${encodeURIComponent(id)}/promote`, {}));

export const archiveTenantAgent = async (id: string): Promise<TenantAgent> =>
  agentOf(await api(`/api/v1/agents/${encodeURIComponent(id)}/archive`, {}));

export function cleanForm(form: AgentForm): AgentForm {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    modelId: form.modelId,
    look: form.look,
    tint: form.tint,
    connectorSlugs: dedupe(form.connectorSlugs).slice(0, MAX_CONNECTORS),
    connectorAccess: cleanAccess(form),
    skillIds: dedupe(form.skillIds ?? []).slice(0, MAX_SKILLS),
  };
}

// Drops duplicate slugs, preserving order.
function dedupe(slugs: string[]): string[] {
  return slugs.filter((slug, index) => slugs.indexOf(slug) === index);
}

// The access map pruned to the slugs still attached, keeping only read_only
// entries (read_write is the default and needs no record). So a connector
// removed from the agent, or switched back to read_write, drops out.
function cleanAccess(form: AgentForm): Record<string, ConnectorAccess> {
  const kept = new Set(dedupe(form.connectorSlugs).slice(0, MAX_CONNECTORS));
  const access: Record<string, ConnectorAccess> = {};
  for (const [slug, value] of Object.entries(form.connectorAccess ?? {}))
    if (kept.has(slug) && value === "read_only") access[slug] = value;
  return access;
}

// The wire shape for create/update: the form's `connectorSlugs` and
// `connectorAccess` become the platform's `connectors` field — a plain slug
// string for read_write (the default) and a `{ slug, access }` object for
// read_only (write access contract: strings still accepted = read_write).
// Only present fields are sent, so a PATCH that didn't touch connectors
// leaves them unchanged; `connectorAccess` is never a top-level wire field.
function toWire(form: Partial<AgentForm>): Record<string, unknown> {
  const { connectorSlugs, connectorAccess, ...rest } = form;
  if (connectorSlugs === undefined) return { ...rest };
  const access = connectorAccess ?? {};
  const connectors = connectorSlugs.map((slug) =>
    access[slug] === "read_only" ? { slug, access: "read_only" } : slug,
  );
  return { ...rest, connectors };
}

// Matches the server's rule closely enough that Save is disabled before a
// request the server would refuse.
export function formProblem(form: AgentForm): string | null {
  const f = cleanForm(form);
  if (!f.name) return "Give the agent a name.";
  if (f.name.length > AGENT_NAME_MAX)
    return `Keep the name under ${AGENT_NAME_MAX + 1} characters.`;
  if (!f.description) return "Say what the agent is for.";
  if (f.description.length > AGENT_DESCRIPTION_MAX)
    return `Keep the description under ${AGENT_DESCRIPTION_MAX + 1} characters.`;
  if (!WIRE_ID.test(f.modelId)) return "Choose a model.";
  return null;
}

// Only the fields that differ, for PATCH. Empty when nothing changed.
export function formChanges(
  agent: TenantAgent,
  form: AgentForm,
): Partial<AgentForm> {
  const f = cleanForm(form);
  const changes: Partial<AgentForm> = {};
  if (f.name !== agent.name) changes.name = f.name;
  if (f.description !== agent.description) changes.description = f.description;
  if (f.modelId !== (agent.model?.id ?? "")) changes.modelId = f.modelId;
  if (f.look !== agent.look) changes.look = f.look;
  if (f.tint !== agent.tint) changes.tint = f.tint;
  // Connectors changed when the attached set or any per-connector access
  // differs. Access is part of the connectors field, so both are carried
  // together to toWire (an access-only edit is still a change).
  const current = formOf(agent, []);
  if (
    !sameSlugs(f.connectorSlugs, current.connectorSlugs) ||
    !sameAccess(f, current)
  ) {
    changes.connectorSlugs = f.connectorSlugs;
    changes.connectorAccess = f.connectorAccess;
  }
  if (!sameSlugs(f.skillIds, current.skillIds)) changes.skillIds = f.skillIds;
  return changes;
}

// Two cleaned forms attach the same access when every selected slug resolves
// to the same access (read_write default vs read_only). cleanForm already
// pruned read_write entries, so an equal access map is equality here.
function sameAccess(a: AgentForm, b: AgentForm): boolean {
  const access = (form: AgentForm) =>
    form.connectorSlugs.map(
      (slug) => form.connectorAccess[slug] ?? "read_write",
    );
  const av = access(a);
  const bv = access(b);
  return av.length === bv.length && av.every((v, i) => v === bv[i]);
}

// Two connector-slug lists are equal when they hold the same slugs in the
// same order (the picker keeps a stable order, so order is meaningful).
function sameSlugs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((slug, index) => slug === b[index]);
}

export function formOf(
  agent: TenantAgent | null,
  models: TenantModel[],
): AgentForm {
  return agent
    ? {
        name: agent.name,
        description: agent.description,
        modelId: agent.model?.id ?? "",
        look: agent.look,
        tint: agent.tint,
        connectorSlugs: agent.connectors.map((c) => c.slug),
        connectorAccess: Object.fromEntries(
          agent.connectors
            .filter((c) => c.access === "read_only")
            .map((c) => [c.slug, c.access]),
        ),
        skillIds: agent.skills.map((s) => s.id),
      }
    : {
        name: "",
        description: "",
        modelId: models[0]?.id ?? "",
        look: DEFAULT_LOOK,
        tint: DEFAULT_TINT,
        connectorSlugs: [],
        connectorAccess: {},
        skillIds: [],
      };
}

/**
 * One request ID per intent: retrying the same form reuses it, so a create
 * whose answer was lost returns the agent it already made; changing the form
 * starts a new request.
 */
export function requestIds(generate: () => string = () => crypto.randomUUID()) {
  let last: { key: string; id: string } | null = null;
  return {
    for(form: AgentForm, scope: AgentScope): string {
      const key = JSON.stringify([scope, cleanForm(form)]);
      if (last?.key !== key) last = { key, id: generate() };
      return last.id;
    },
    reset() {
      last = null;
    },
  };
}

export interface AgentGroups {
  builtin: TenantAgent[];
  personal: TenantAgent[];
  tenant: TenantAgent[];
}

export function groupAgents(agents: TenantAgent[]): AgentGroups {
  const groups: AgentGroups = { builtin: [], personal: [], tenant: [] };
  for (const agent of agents)
    if (agent.status === "active") groups[agent.source].push(agent);
  return groups;
}

// Replaces or adds one agent after a write; archived agents leave the list.
export function withAgent(
  agents: TenantAgent[],
  agent: TenantAgent,
): TenantAgent[] {
  const rest = agents.filter((a) => a.id !== agent.id);
  if (agent.status === "archived") return rest;
  const index = agents.findIndex((a) => a.id === agent.id);
  if (index < 0) return [...rest, agent];
  const next = [...agents];
  next[index] = agent;
  return next;
}

// The first agent a chat could start with right now.
export function defaultAgent(agents: TenantAgent[]): TenantAgent | null {
  return agents.find((a) => a.status === "active" && a.available) ?? null;
}
