import type { ObjectId } from "mongodb";

export type TenantKind = "default" | "organization";
export type TenantStatus = "active" | "disabled";
export type ProvisioningStatus = "pending" | "ready" | "failed";

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
