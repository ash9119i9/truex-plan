import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import { ApiError } from "./errors";

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
  createdAt: string;
  updatedAt: string;
}
export interface TenantRef {
  id: string;
  dbName: string;
  allowedModelIds?: string[];
  allowedSkillIds?: string[];
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
