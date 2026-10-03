import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import { ApiError } from "./errors";

// The signed-in person behind a request. The role belongs to their
// membership in the current tenant, so the same person can be an admin in
// one tenant and a user in another.
export type UserRole = "user" | "admin";
export interface UserRef {
  id: string;
  email: string;
  role: UserRole;
}

export const userContext = new AsyncLocalStorage<UserRef>();
export const currentUser = () => userContext.getStore();

// Decides who a request belongs to. The real implementation comes from the
// session cookie; like TenantResolver it must never trust the request body.
export interface UserResolver {
  resolve(req: Request): UserRef;
}

export const USER_HEADER = "x-truex-user";
export const ROLE_HEADER = "x-truex-role";
export const DEV_USER_ID = "dev-user";
export const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const on = (value: string | undefined) => value?.trim().toLowerCase() === "on";

export function userId(id: unknown): string {
  if (typeof id !== "string" || !USER_ID.test(id))
    throw new ApiError(400, "Invalid user id", "INVALID_USER");
  return id;
}
export function userRole(role: unknown): UserRole {
  if (role !== "user" && role !== "admin")
    throw new ApiError(400, "Invalid user role", "INVALID_ROLE");
  return role;
}

export type AuthMode = "poc" | "dev" | "google";
const GOOGLE_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "FRONTEND_ORIGIN",
] as const;

// "poc" (shared identity), "dev" (test headers), or "google" (session cookies). Any other
// value, or google without its keys, is refused at startup rather than
// silently running without authentication.
export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const mode = env.AUTH_MODE?.trim().toLowerCase() || "dev";
  if (mode === "dev" || mode === "poc") return mode;
  if (mode !== "google")
    throw new Error(
      `AUTH_MODE=${mode} is not supported. Use AUTH_MODE=poc, dev, or google.`,
    );
  const missing = GOOGLE_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length)
    throw new Error(`AUTH_MODE=google requires ${missing.join(", ")}.`);
  return mode;
}

// Explicit POC deployment: one configured identity, with no client overrides.
export function pocUserResolver(
  env: NodeJS.ProcessEnv = process.env,
): UserResolver {
  return devUserResolver({
    ...env,
    ALLOW_DEV_TENANT: "on",
    DEV_USER_HEADER: "off",
  });
}

// Development only: a fixed user, optionally overridden by headers so two
// people can be tried locally. Refuses to run in production, with the same
// escape hatch as the development tenant resolver.
export function devUserResolver(
  env: NodeJS.ProcessEnv = process.env,
): UserResolver {
  if (env.NODE_ENV === "production" && !on(env.ALLOW_DEV_TENANT))
    throw new Error(
      "The development user resolver cannot run in production. Configure authentication.",
    );
  const id = userId(env.DEV_USER_ID?.trim() || DEV_USER_ID);
  const fixed: UserRef = {
    id,
    email: env.DEV_USER_EMAIL?.trim() || `${id}@dev.local`,
    role: userRole(env.DEV_USER_ROLE?.trim() || "admin"),
  };
  const header = on(env.DEV_USER_HEADER);
  return {
    resolve(req) {
      const requested = header ? req.get(USER_HEADER)?.trim() : undefined;
      if (!requested) return fixed;
      const other = userId(requested);
      const role = req.get(ROLE_HEADER)?.trim();
      return {
        id: other,
        email: `${other}@dev.local`,
        role: role ? userRole(role) : "user",
      };
    },
  };
}
