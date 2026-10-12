import { createHash, randomUUID } from "node:crypto";
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import type { JWTPayload } from "jose";
import { ApiError } from "./errors";
import {
  IdentityStore,
  identityBindingId,
  type CredentialCohort,
  type ExternalIdentityBinding,
} from "./identity";
import { tenantId as parseTenantId } from "./tenant";
import type { Request, Response, NextFunction } from "express";
import type { Store } from "./store";
import { parseCookies } from "./auth";
import { identityMembership } from "./browser-auth";
import { AUTHORIZATION_ROUTES } from "./authorization-routes";
import {
  ACTIONS,
  isAuthorizationContext,
  type Action,
  type AuthorizationContext,
} from "../../shared/authorization";

// Strict verification of broker-issued API access tokens (RFC 9068 profile).
// Cryptographic validity is necessary but never sufficient: the token's
// issuer/subject or client must map to a live internal principal and the
// tenant binding generations it carries must still be current (identity.ts).
// Roles and groups in a token are ignored; scopes only cap actions.

export const ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"] as const;
type Algorithm = (typeof ALGORITHMS)[number];
const MAX_HEADER_BYTES = 8192;
const MAX_ISSUERS = 32;
const MAX_SCOPE_CHARS = 4096;
const MAX_SCOPES = 256;
/** Namespaced claim carrying the broker-attested generation cohort. */
export const COHORT_CLAIM = "https://truex.dev/authz";

export interface TrustedApiIssuer {
  /** `identity_connections._id` that must be active and carry this issuer. */
  connectionId: string;
  /** Exact `iss` value. */
  issuer: string;
  /** Administrator-approved HTTPS JWKS endpoint; never taken from a token. */
  jwksUri: string;
  /** This API's audience; ID tokens and other APIs' tokens do not match. */
  audience: string;
  algorithms?: readonly Algorithm[];
}
export interface ApiAuthOptions {
  issuers: readonly TrustedApiIssuer[];
  clockToleranceSec?: number;
  /** Rejects tokens whose `exp - iat` is longer. Target lifetime is 300 s. */
  maxLifetimeSec?: number;
  jwksCacheMaxAgeMs?: number;
  jwksCooldownMs?: number;
  jwksTimeoutMs?: number;
  /** Test seam for the JWKS transport; production uses global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}
export interface VerifiedApiCredential {
  context: AuthorizationContext;
  kind: "human" | "service";
  connectionId: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/i;
const FORBIDDEN_HEADERS = ["jku", "jwk", "x5u", "x5c", "x5t", "crit", "zip"];
const ID_TOKEN_CLAIMS = ["nonce", "at_hash", "c_hash"];
// Same body for every token failure: no oracle for the failing check.
const invalidToken = () =>
  new ApiError(401, "Invalid or expired access token", "BEARER_INVALID");
const unavailable = (cause?: unknown) =>
  new ApiError(
    503,
    "Authentication is temporarily unavailable. Try again shortly.",
    "AUTH_UNAVAILABLE",
    { cause },
  );

function httpsUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 1024)
    throw new Error("invalid URL");
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    /[\s\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error("URL must be plain HTTPS");
  return u;
}
const int = (
  v: number | undefined,
  fallback: number,
  min: number,
  max: number,
) => {
  const n = v ?? fallback;
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error("API auth option out of range");
  return Math.floor(n);
};
const idClaim = (v: unknown): v is string =>
  typeof v === "string" && ID.test(v);

/** Parses `API_AUTH_ISSUERS` (JSON array). Unset or empty disables bearer auth. */
export function apiAuthOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ApiAuthOptions | undefined {
  const raw = env.API_AUTH_ISSUERS?.trim();
  if (!raw) return undefined;
  let issuers: unknown;
  try {
    issuers = JSON.parse(raw);
  } catch {
    throw new Error("API_AUTH_ISSUERS must be a JSON array");
  }
  if (!Array.isArray(issuers))
    throw new Error("API_AUTH_ISSUERS must be a JSON array");
  return { issuers: issuers as TrustedApiIssuer[] };
}

type Resolver = ReturnType<typeof createRemoteJWKSet>;
interface Trusted {
  config: TrustedApiIssuer;
  keys: Resolver;
  algorithms: readonly Algorithm[];
}

export class ApiAuthenticator {
  private readonly byIssuer = new Map<string, Trusted>();
  private readonly tolerance: number;
  private readonly maxLifetime: number;
  private readonly now: () => number;
  constructor(
    private readonly identity: IdentityStore,
    private readonly options: ApiAuthOptions,
  ) {
    if (
      !Array.isArray(options.issuers) ||
      options.issuers.length === 0 ||
      options.issuers.length > MAX_ISSUERS
    )
      throw new Error("API auth needs 1 to 32 trusted issuers");
    this.tolerance = int(options.clockToleranceSec, 30, 0, 60);
    this.maxLifetime = int(options.maxLifetimeSec, 900, 30, 3600);
    this.now = options.now ?? Date.now;
    const connections = new Set<string>();
    for (const config of options.issuers) {
      if (
        !idClaim(config.connectionId) ||
        typeof config.audience !== "string" ||
        !config.audience ||
        config.audience.length > 256 ||
        connections.has(config.connectionId)
      )
        throw new Error("Invalid API auth issuer configuration");
      const issuer = httpsUrl(config.issuer);
      if (issuer.search || issuer.href !== config.issuer)
        throw new Error("Issuer must be the exact HTTPS issuer identifier");
      if (this.byIssuer.has(config.issuer))
        throw new Error("Duplicate API auth issuer");
      const jwks = httpsUrl(config.jwksUri);
      const algorithms = config.algorithms ?? ALGORITHMS;
      if (
        algorithms.length === 0 ||
        !algorithms.every((a: string) =>
          (ALGORITHMS as readonly string[]).includes(a),
        )
      )
        throw new Error("Unsupported API auth algorithm");
      connections.add(config.connectionId);
      // One key set per issuer: the same `kid` under two issuers can never
      // select the other issuer's key. Unknown kids refresh at most once per
      // cooldown; a failed refresh denies and never extends key freshness.
      this.byIssuer.set(config.issuer, {
        config,
        algorithms,
        keys: createRemoteJWKSet(jwks, {
          cacheMaxAge: int(options.jwksCacheMaxAgeMs, 600_000, 1000, 3_600_000),
          cooldownDuration: int(options.jwksCooldownMs, 30_000, 0, 600_000),
          timeoutDuration: int(options.jwksTimeoutMs, 5000, 100, 10_000),
          ...(options.fetch
            ? {
                [customFetch]: (url: string, init: unknown) =>
                  options.fetch!(url, init as RequestInit),
              }
            : {}),
        } as Parameters<typeof createRemoteJWKSet>[1]),
      });
    }
  }

  /** `Authorization` header value to a verified, live, tenant-bound context. */
  async authenticate(header: string): Promise<VerifiedApiCredential> {
    const token = this.token(header);
    const trusted = this.select(token);
    const payload = await this.verifyToken(token, trusted);
    const cohort = this.cohort(payload);
    const scopes = this.scopes(payload);
    try {
      // Bind receipts/audit to this exact credential, even if an issuer
      // accidentally repeats jti. The bearer token itself is never stored.
      return await this.bind(
        trusted,
        payload,
        cohort,
        scopes,
        createHash("sha256").update(token).digest("hex"),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw invalidToken();
      throw error;
    }
  }

  private token(header: unknown): string {
    if (typeof header !== "string" || header.length > MAX_HEADER_BYTES)
      throw invalidToken();
    const match = BEARER.exec(header);
    if (!match) throw invalidToken();
    return match[1];
  }

  private select(token: string): Trusted {
    try {
      const header = decodeProtectedHeader(token);
      if (FORBIDDEN_HEADERS.some((name) => name in header))
        throw invalidToken();
      if (typeof header.alg !== "string" || header.alg === "none")
        throw invalidToken();
      const iss = decodeJwt(token).iss;
      // Only a configured issuer string can select a key source.
      const trusted =
        typeof iss === "string" ? this.byIssuer.get(iss) : undefined;
      if (!trusted) throw invalidToken();
      return trusted;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw invalidToken();
    }
  }

  private async verifyToken(token: string, trusted: Trusted) {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, trusted.keys, {
        issuer: trusted.config.issuer,
        audience: trusted.config.audience,
        algorithms: [...trusted.algorithms],
        typ: "at+jwt",
        clockTolerance: this.tolerance,
        currentDate: new Date(this.now()),
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id"],
      });
      payload = verified.payload;
    } catch (error) {
      if (error instanceof joseErrors.JOSEError && isTokenFailure(error))
        throw invalidToken();
      // JWKS fetch/parse/timeout or unexpected failure: fail closed, retryable.
      throw unavailable(error);
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > nowSec + this.tolerance ||
      payload.exp - payload.iat > this.maxLifetime ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 255 ||
      typeof payload.jti !== "string" ||
      !payload.jti ||
      payload.jti.length > 255 ||
      typeof payload.client_id !== "string" ||
      !payload.client_id ||
      payload.client_id.length > 255 ||
      ID_TOKEN_CLAIMS.some((claim) => claim in payload)
    )
      throw invalidToken();
    return payload;
  }

  private cohort(payload: JWTPayload) {
    const raw = payload[COHORT_CLAIM];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw invalidToken();
    const c = raw as Record<string, unknown>;
    const allowed = new Set([
      "tenant",
      "principal_generation",
      "binding_generation",
      "credential_generation",
      "tenant_generation",
      "connection_generation",
      "client_generation",
    ]);
    if (Object.keys(c).some((k) => !allowed.has(k))) throw invalidToken();
    let tenant: string;
    try {
      tenant = parseTenantId(c.tenant as string);
    } catch {
      throw invalidToken();
    }
    for (const k of [
      "principal_generation",
      "binding_generation",
      "credential_generation",
      "tenant_generation",
      "connection_generation",
    ])
      if (!idClaim(c[k])) throw invalidToken();
    if (c.client_generation !== undefined && !idClaim(c.client_generation))
      throw invalidToken();
    const cohort: CredentialCohort = {
      principalGeneration: c.principal_generation as string,
      bindingGeneration: c.binding_generation as string,
      credentialGeneration: c.credential_generation as string,
      tenantGeneration: c.tenant_generation as string,
      connectionGeneration: c.connection_generation as string,
      ...(c.client_generation !== undefined
        ? { clientGeneration: c.client_generation as string }
        : {}),
      issuedAtMs: payload.iat! * 1000,
      expiresAtMs: payload.exp! * 1000,
    };
    return { tenant, cohort };
  }

  /** Unknown strings carry no authority; scopes only ever narrow. */
  private scopes(payload: JWTPayload): Action[] {
    const raw = payload.scope;
    if (raw === undefined) return [];
    if (typeof raw !== "string" || raw.length > MAX_SCOPE_CHARS)
      throw invalidToken();
    const parts = raw.split(" ").filter(Boolean);
    if (parts.length > MAX_SCOPES) throw invalidToken();
    const known = new Set<string>(ACTIONS);
    return [...new Set(parts)].filter((s): s is Action => known.has(s));
  }

  private async bind(
    trusted: Trusted,
    payload: JWTPayload,
    { tenant, cohort }: { tenant: string; cohort: CredentialCohort },
    scopes: Action[],
    credentialId: string,
  ): Promise<VerifiedApiCredential> {
    const { connectionId, issuer } = trusted.config;
    const clientId = payload.client_id as string;
    // Human tokens: sub is the broker subject bound to an internal human.
    // Service tokens: a registered client in this tenant is the identity; the
    // token's `sub` is not trusted to name a principal.
    let principal: ExternalIdentityBinding["principal"];
    let bindingId: string;
    // The signed client generation marks a registered-client (service) token.
    // Client-credentials tokens name the client as their subject.
    const isService = cohort.clientGeneration !== undefined;
    if (isService && payload.sub !== clientId) throw invalidToken();
    if (!isService) {
      const human = await this.identity.resolveHuman(
        connectionId,
        issuer,
        payload.sub!,
      );
      principal = human.principal;
      // This is server-resolved identity evidence, never a caller-selected
      // binding. A revoked external link must also invalidate old credentials.
      cohort.externalBindingId = human.externalBindingId;
      bindingId = identityBindingId(principal.id, tenant);
    } else {
      const client = await this.identity.resolveClient(
        connectionId,
        issuer,
        clientId,
        tenant,
      );
      principal = client.principal;
      bindingId = client.bindingId;
    }
    const verified = await this.identity.validateCredential({
      connectionId,
      verifiedIssuer: issuer,
      principal,
      tenantId: tenant,
      bindingId,
      cohort,
      ...(principal.kind === "service" ? { clientId } : {}),
    });
    const context: AuthorizationContext = {
      version: 1,
      principal: verified.principal,
      tenant: verified.tenant,
      binding: verified.binding,
      credential: {
        kind: "access_token",
        id: credentialId,
        issuedAtMs: cohort.issuedAtMs,
        expiresAtMs: cohort.expiresAtMs,
        scopes,
      },
      requestId: randomUUID(),
    };
    if (!isAuthorizationContext(context)) throw invalidToken();
    return {
      context,
      kind: verified.principal.kind,
      connectionId,
    };
  }
}

const TOKEN_FAILURES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);
function isTokenFailure(error: joseErrors.JOSEError) {
  return TOKEN_FAILURES.has(String(error.code));
}

// ---------------------------------------------------------------------------
// Express integration. Runs before CSRF and authMiddleware on /api, so an
// Authorization header is always resolved (or rejected) before any resource
// lookup, and the CSRF exemption below applies only to a verified bearer.

const SESSION_COOKIES = new Set([
  "__Host-truex_session",
  "truex_session",
  "__Host-truex_admin",
  "truex_admin",
]);
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  boundary: string;
  actions: readonly Action[];
}
let compiled: CompiledRoute[] | undefined;
function routes(): CompiledRoute[] {
  return (compiled ??= AUTHORIZATION_ROUTES.filter(
    (r) => r.source === "platform/src/index.ts" && r.path.startsWith("/api/"),
  ).map((r) => ({
    method: r.method,
    boundary: r.boundary,
    actions: r.actions,
    pattern: new RegExp(
      "^" +
        r.path
          .split("/")
          .map((part) =>
            part.startsWith(":")
              ? "[^/]+"
              : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("/") +
        "$",
    ),
  })));
}

/**
 * What a bearer caller may reach with the legacy handlers: only routes in the
 * reviewed inventory whose boundary is account/resource/admission, and only
 * when the token scopes cover every required action. Everything else
 * (streams, per-method capability routes, blocked/unknown routes) is denied
 * until its dedicated step adds the guard.
 */
export function bearerRouteRequirement(
  method: string,
  path: string,
): { actions: readonly Action[] } | undefined {
  const m = method === "HEAD" ? "GET" : method;
  const p = trimSlash(path);
  const hit = routes().find((r) => r.method === m && r.pattern.test(p));
  if (!hit) return undefined;
  if (hit.boundary === "account") return { actions: [] };
  if (
    (hit.boundary === "resource" || hit.boundary === "admission") &&
    hit.actions.length > 0
  )
    return { actions: hit.actions };
  return undefined;
}

export function bearerGate(store: Store, auth: ApiAuthenticator | undefined) {
  const handle = async (req: Request, res: Response) => {
    const header = req.headers.authorization;
    res.vary("Authorization");
    if (header === undefined) return; // cookie mechanism; decided by authMiddleware
    const path = req.baseUrl + req.path;
    if (!auth)
      throw new ApiError(
        401,
        "Bearer authentication is not enabled",
        "BEARER_UNSUPPORTED",
      );
    // Ambiguity is rejected, never resolved by picking one credential.
    const cookies = parseCookies(req.get("cookie"));
    if ([...SESSION_COOKIES].some((name) => cookies.has(name)))
      throw new ApiError(
        400,
        "Send either a session cookie or an access token, not both",
        "AMBIGUOUS_CREDENTIALS",
      );
    if (/^\/api\/admin(\/|$)/.test(path))
      throw new ApiError(
        401,
        "Invalid or expired access token",
        "BEARER_INVALID",
      );

    const credential = await auth.authenticate(header);
    const { context } = credential;
    const need = bearerRouteRequirement(req.method, path);
    if (!need)
      throw new ApiError(
        403,
        "This endpoint is not available to access tokens",
        "BEARER_ROUTE_UNSUPPORTED",
      );
    if (!need.actions.every((a) => context.credential.scopes.includes(a)))
      throw new ApiError(
        403,
        "The access token does not allow this action",
        "SCOPE_DENIED",
      );
    if (credential.kind !== "human")
      throw new ApiError(
        403,
        "Service principals cannot use this endpoint yet",
        "SERVICE_PRINCIPAL_UNSUPPORTED",
      );
    // Canonical humans do not require fake Google rows. Migrated users keep
    // their legacy profile, and role remains a live compatibility projection.
    const principal = await new IdentityStore(store).principals.findOne({
      _id: context.principal.id,
      kind: "human",
      generation: context.principal.generation,
      status: "active",
    });
    if (!principal) throw invalidTokenError();
    const legacy =
      principal.legacySource === "google"
        ? await store.users.findOne({
            _id: principal._id,
            status: "active",
            authorizationGeneration: principal.generation,
          })
        : null;
    if (principal.legacySource === "google" && !legacy)
      throw invalidTokenError();
    const user = {
      _id: principal._id,
      email: legacy?.email ?? principal.profile?.email ?? "",
      name: legacy?.name ?? principal.profile?.name,
      picture: legacy?.picture ?? principal.profile?.picture,
    };
    const membership = await identityMembership(store, context);
    const tenant = await store.resolveTenant(membership.tenantId, {
      fresh: true,
    });
    res.locals.tenant = tenant;
    res.locals.user = {
      id: user._id,
      email: user.email,
      role: membership.role,
    };
    res.locals.profile = {
      ...(user.name ? { name: user.name } : {}),
      ...(user.picture ? { picture: user.picture } : {}),
    };
    res.locals.authorization = context;
    res.locals.bearerVerified = true;
  };
  return (req: Request, res: Response, next: NextFunction) => {
    handle(req, res).then(() => next(), next);
  };
}
const invalidTokenError = () =>
  new ApiError(401, "Invalid or expired access token", "BEARER_INVALID");
