import type { ObjectId } from "mongodb";
import { integer, invalid, objectWith } from "../../common/validation";

export type TenantKind = "default" | "organization";
export type TenantStatus = "active" | "disabled";
export type ProvisioningStatus = "pending" | "ready" | "failed";

// A tenant's goal settings, set by an operator. New chats snapshot
// maxTokenBudget; a change never reaches existing chats.
export interface TenantGoals {
  // The budgets a member chooses from, ascending, each below the maximum.
  presets: [number, number, number];
  // Codex's max_goal_token_budget for the tenant's new chats.
  maxTokenBudget: number;
  // Goals active at once across the tenant.
  maxActive: number;
}

// The adapter's cap on a chat's maximum (runtime-adapter
// MAX_GOAL_TOKEN_BUDGET).
export const MAX_GOAL_TOKEN_BUDGET = 1_000_000_000;
export const MAX_TENANT_ACTIVE_GOALS = 10_000;

// A tenant registry record in the catalog. `dbName` is always derived by the
// backend from the kind and ID, never taken from request data.
export interface TenantDoc {
  _id: ObjectId;
  name: string;
  dbName: string;
  kind: TenantKind;
  status: TenantStatus;
  provisioningStatus: ProvisioningStatus;
  provisioningError?: string;
  // The TENANT_INDEX_VERSION its database's indexes were last built for.
  // Missing on tenants provisioned before indexes were built at provisioning.
  indexVersion?: number;
  // Absent means goals are off for the tenant.
  goals?: TenantGoals;
  createdAt: Date;
  updatedAt: Date;
}

export const TENANTS_COLLECTION = "tenants";

// The shared default tenant used by direct signup.
export const DEFAULT_TENANT_DB_NAME = "truex_next_t_default";

// Every organization (enterprise) tenant gets its own database.
export function organizationDbName(tenantId: ObjectId): string {
  return `truex_next_t_${tenantId.toHexString()}`;
}

export function dbNameFor(kind: TenantKind, tenantId: ObjectId): string {
  return kind === "default"
    ? DEFAULT_TENANT_DB_NAME
    : organizationDbName(tenantId);
}

const MAX_NAME_LENGTH = 100;
// Control characters and invisible format characters (bidi overrides and the
// like) make a tenant name render differently from what was stored.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}]/u;

// Returns the cleaned name, or null when it is not acceptable.
export function normalizeTenantName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  return UNSAFE_NAME_CHARS.test(name) ? null : name;
}

export function parseTenantGoals(value: unknown): TenantGoals {
  const raw = objectWith(
    value,
    ["presets", "maxTokenBudget", "maxActive"],
    "Goal settings",
  );
  const maxTokenBudget = integer(
    raw.maxTokenBudget,
    "maxTokenBudget",
    2,
    MAX_GOAL_TOKEN_BUDGET,
  );
  if (!Array.isArray(raw.presets) || raw.presets.length !== 3)
    invalid("presets must be a list of three budgets.");
  const [small, medium, large] = raw.presets.map((preset: unknown, i) =>
    integer(preset, `presets[${i}]`, 1, maxTokenBudget - 1),
  ) as [number, number, number];
  if (!(small < medium && medium < large))
    invalid("presets must be in increasing order, with no repeats.");
  return {
    presets: [small, medium, large],
    maxTokenBudget,
    maxActive: integer(raw.maxActive, "maxActive", 1, MAX_TENANT_ACTIVE_GOALS),
  };
}
