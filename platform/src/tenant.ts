import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import { ApiError } from "./errors";

// Who may see a tenant's conversations: "own" shows each user only their
// chats (admins still read all); "all" lets everyone read every chat. This is
// the legacy spelling of isUserSpecific and is kept as a derived alias.
export type ChatVisibility = "own" | "all";
export const chatVisibilityOf = (value: unknown): ChatVisibility | undefined =>
  value === "own" || value === "all" ? value : undefined;

// How people join a tenant. "open" lets anyone with a Google account in, and
// is allowed for the one configured demo tenant only; everything else joins
// by invitation. A missing value means "inviteOnly", never "open".
export type AdmissionPolicy = "open" | "inviteOnly";
export const admissionPolicyOf = (
  value: unknown,
): AdmissionPolicy | undefined =>
  value === "open" || value === "inviteOnly" ? value : undefined;

// A tenant owns its agents, MCP profiles and conversations, all in its own
// database. Models and skills are shared and live in the catalog database.
export interface TenantDocument {
  _id: string;
  name: string;
  /** Server-generated, see tenantDbName. Never taken from user input. */
  dbName: string;
  status: "active" | "disabled";
  /** When set, agents of this tenant may only use these catalog entries. */
  allowedModelIds?: string[];
  allowedSkillIds?: string[];
  /** Legacy alias of isUserSpecific; see effectivePrivacy. */
  chatVisibility?: ChatVisibility;
  /** Canonical privacy: true means ordinary members see only their own
   * conversations and agents. Missing on legacy records. */
  isUserSpecific?: boolean;
  /** Missing means "inviteOnly". */
  admissionPolicy?: AdmissionPolicy;
  createdAt: string;
  updatedAt: string;
}
export interface TenantRef {
  id: string;
  dbName: string;
  allowedModelIds?: string[];
  allowedSkillIds?: string[];
  /** Derived from isUserSpecific; missing means "all" (legacy shared). */
  chatVisibility?: ChatVisibility;
  /** The one effective privacy policy; missing only on unconfigured legacy
   * records, which keep their legacy behaviour. */
  isUserSpecific?: boolean;
  admissionPolicy?: AdmissionPolicy;
}

/**
 * The single effective privacy policy of a tenant record. The canonical
 * isUserSpecific wins over nothing: when both it and the legacy chatVisibility
 * are present they must agree, and any present-but-unrecognised value is
 * invalid. Callers treat `invalid` as a closed door, never as a default.
 */
export function effectivePrivacy(
  doc?: {
    isUserSpecific?: unknown;
    chatVisibility?: unknown;
  } | null,
): { isUserSpecific?: boolean; invalid: boolean } {
  const canonicalPresent = doc?.isUserSpecific !== undefined;
  const legacyPresent = doc?.chatVisibility !== undefined;
  const canonical =
    typeof doc?.isUserSpecific === "boolean" ? doc.isUserSpecific : undefined;
  const legacyValue = chatVisibilityOf(doc?.chatVisibility);
  const legacy = legacyValue === undefined ? undefined : legacyValue === "own";
  if (canonicalPresent && canonical === undefined) return { invalid: true };
  if (legacyPresent && legacy === undefined) return { invalid: true };
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy)
    return { invalid: true };
  const value = canonical ?? legacy;
  return value === undefined
    ? { invalid: false }
    : { isUserSpecific: value, invalid: false };
}
/** The tenant-context fields that follow from a registry record. */
export function policyOf(
  doc?: {
    isUserSpecific?: unknown;
    chatVisibility?: unknown;
    admissionPolicy?: unknown;
  } | null,
) {
  const { isUserSpecific, invalid } = effectivePrivacy(doc);
  if (invalid)
    throw new ApiError(
      503,
      "This workspace's privacy settings are inconsistent. Ask your administrator to correct them.",
      "TENANT_POLICY_INVALID",
    );
  const admissionPolicy = admissionPolicyOf(doc?.admissionPolicy);
  return {
    ...(isUserSpecific === undefined
      ? {}
      : {
          isUserSpecific,
          chatVisibility: (isUserSpecific ? "own" : "all") as ChatVisibility,
        }),
    ...(admissionPolicy ? { admissionPolicy } : {}),
  };
}

export const DEFAULT_TENANT_ID = "default";
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function tenantId(id: unknown): string {
  if (typeof id !== "string" || !TENANT_ID.test(id))
    throw new ApiError(400, "Invalid tenant id", "INVALID_TENANT");
  return id;
}
// Mongo database names are limited to 63 bytes and a small character set.
export function tenantDbName(id: string) {
  return "truex_t_" + tenantId(id).replace(/-/g, "_");
}

// The tenant of the running request (or poll). Code outside any tenant
// context works on the default tenant, which keeps single-tenant setups and
// existing tests unchanged.
export const tenantContext = new AsyncLocalStorage<TenantRef>();
export const currentTenant = () => tenantContext.getStore();
export const currentTenantId = () =>
  tenantContext.getStore()?.id ?? DEFAULT_TENANT_ID;

// Decides which tenant a request belongs to. The real implementation will
// come from authentication; it must never trust a client-chosen value.
export interface TenantResolver {
  resolve(req: Request): string;
}

const on = (value: string | undefined) => value?.trim().toLowerCase() === "on";
export const TENANT_HEADER = "x-truex-tenant";

// Explicit POC deployment: one configured tenant, with no client overrides.
export function pocTenantResolver(
  env: NodeJS.ProcessEnv = process.env,
): TenantResolver {
  return devTenantResolver({
    ...env,
    ALLOW_DEV_TENANT: "on",
    DEV_TENANT_HEADER: "off",
  });
}

// Development only: a fixed tenant, optionally overridden by a header so
// several tenants can be tried locally. Refuses to run in production.
export function devTenantResolver(
  env: NodeJS.ProcessEnv = process.env,
): TenantResolver {
  if (env.NODE_ENV === "production" && !on(env.ALLOW_DEV_TENANT))
    throw new Error(
      "The development tenant resolver cannot run in production. Configure authentication-based tenant resolution.",
    );
  const fixed = tenantId(env.DEV_TENANT_ID?.trim() || DEFAULT_TENANT_ID);
  const header = on(env.DEV_TENANT_HEADER);
  return {
    resolve(req) {
      const requested = header ? req.get(TENANT_HEADER)?.trim() : undefined;
      return requested ? tenantId(requested) : fixed;
    },
  };
}
