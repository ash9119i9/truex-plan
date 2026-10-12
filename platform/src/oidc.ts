import { randomUUID } from "node:crypto";
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import * as client from "openid-client";
import { decodeProtectedHeader } from "jose";
import type { Store } from "./store";
import { IdentityStore, identityBindingId } from "./identity";
import { ApiError } from "./errors";
import {
  cookieSpec,
  hashToken,
  newToken,
  parseCookies,
  sessionRecord,
  setSessionCookie,
} from "./auth";
import {
  BROWSER_COHORT_CLAIM,
  MAX_BROWSER_TENANTS,
  browserTenants,
  isBrowserAuthorization,
  type BrowserSessionAuthorization,
} from "./browser-auth";

const FLOW_MS = 10 * 60_000;
const CLOCK_SECONDS = 5;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const bad = () =>
  new ApiError(
    401,
    "Sign-in could not be verified. Start sign-in again.",
    "OIDC_LOGIN_FAILED",
  );
export interface OidcLoginSettings {
  connectionId: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  clientSecret: string;
  clientAuth: "basic" | "post";
  signingAlgorithm: "RS256" | "PS256" | "ES256" | "EdDSA";
  frontendOrigin: string;
  sessionHours: number;
}
const SETTINGS_KEYS = [
  "connectionId",
  "issuer",
  "authorizationEndpoint",
  "tokenEndpoint",
  "jwksUri",
  "clientId",
  "clientSecret",
  "clientAuth",
  "signingAlgorithm",
  "frontendOrigin",
  "sessionHours",
];
function https(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    /[\p{Cc}\p{Cf}\s]/u.test(value)
  )
    return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}
/** All URLs are operator configuration. Never discover metadata from caller claims. */
export function validateOidcSettings(
  value: unknown,
  production = process.env.NODE_ENV === "production",
): OidcLoginSettings {
  const invalid = () =>
    new Error(
      "OIDC_LOGIN_CONFIG requires a trusted HTTPS issuer/endpoints, client credentials, algorithm, connection and bounded session lifetime.",
    );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const s = value as OidcLoginSettings;
  if (
    Object.keys(s).some((k) => !SETTINGS_KEYS.includes(k)) ||
    typeof s.connectionId !== "string" ||
    !ID.test(s.connectionId) ||
    ![s.issuer, s.authorizationEndpoint, s.tokenEndpoint, s.jwksUri].every(
      https,
    ) ||
    ![s.clientId, s.clientSecret].every(
      (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 4096 &&
        !/[\p{Cc}\p{Cf}]/u.test(v),
    ) ||
    !["basic", "post"].includes(s.clientAuth) ||
    !["RS256", "PS256", "ES256", "EdDSA"].includes(s.signingAlgorithm) ||
    !Number.isInteger(s.sessionHours) ||
    s.sessionHours < 1 ||
    s.sessionHours > 24 ||
    typeof s.frontendOrigin !== "string"
  )
    throw invalid();
  try {
    const u = new URL(s.frontendOrigin);
    if (
      u.origin !== s.frontendOrigin ||
      u.username ||
      u.password ||
      (u.protocol !== "https:" &&
        (production ||
          u.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    )
      throw invalid();
  } catch {
    throw invalid();
  }
  return structuredClone(s);
}
export function oidcSettings(
  env: NodeJS.ProcessEnv = process.env,
): OidcLoginSettings {
  let value: unknown;
  try {
    if (!env.OIDC_LOGIN_CONFIG || env.OIDC_LOGIN_CONFIG.length > 16384)
      throw new Error();
    value = JSON.parse(env.OIDC_LOGIN_CONFIG);
  } catch {
    throw new Error("AUTH_MODE=oidc requires valid OIDC_LOGIN_CONFIG JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid OIDC_LOGIN_CONFIG.");
  return validateOidcSettings(
    {
      sessionHours: 8,
      clientAuth: "basic",
      signingAlgorithm: "RS256",
      ...value,
      frontendOrigin: env.FRONTEND_ORIGIN,
    },
    env.NODE_ENV === "production",
  );
}
interface OidcFlow {
  _id: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  connectionId: string;
  connectionGeneration: string;
  clientId: string;
  createdAt: Date;
  expiresAt: Date;
  tenantHint?: string;
}
const flowName = () =>
  cookieSpec("main").secure ? "__Host-truex_oidc_flow" : "truex_oidc_flow";
function flowCookie(res: Response, token: string) {
  res.append(
    "Set-Cookie",
    `${flowName()}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${FLOW_MS / 1000}${cookieSpec("main").secure ? "; Secure" : ""}`,
  );
}
function singleton(
  req: Request,
  key: string,
  pattern: RegExp,
  required = true,
) {
  const value = req.query[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > 4096 || !pattern.test(value))
    throw bad();
  return value;
}
/** Bound even chunked JWKS/token replies; redirects and unexpected endpoints fail. */
function boundedFetch(
  settings: OidcLoginSettings,
  transport: client.CustomFetch,
): client.CustomFetch {
  return async (url, options) => {
    if (
      (url !== settings.tokenEndpoint || options.method !== "POST") &&
      (url !== settings.jwksUri || options.method !== "GET")
    )
      throw bad();
    const signal = AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const response = await transport(url, {
      ...options,
      redirect: "manual",
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw bad();
    }
    if (Number(response.headers.get("content-length")) > 262144) {
      await response.body?.cancel();
      throw bad();
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 262144) throw bad();
          chunks.push(part.value);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
      }
    }
    signal.throwIfAborted();
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      headers: response.headers,
    });
  };
}
function configuration(s: OidcLoginSettings, transport: client.CustomFetch) {
  const config = new client.Configuration(
    {
      issuer: s.issuer,
      authorization_endpoint: s.authorizationEndpoint,
      token_endpoint: s.tokenEndpoint,
      jwks_uri: s.jwksUri,
    },
    s.clientId,
    {
      id_token_signed_response_alg: s.signingAlgorithm,
      require_auth_time: true,
      [client.clockTolerance]: CLOCK_SECONDS,
    },
    s.clientAuth === "basic"
      ? client.ClientSecretBasic(s.clientSecret)
      : client.ClientSecretPost(s.clientSecret),
  );
  config.timeout = 5;
  config[client.customFetch] = boundedFetch(s, transport);
  client.enableNonRepudiationChecks(config);
  return config;
}
function browserAttestation(
  claims: Record<string, unknown>,
  principalId: string,
  connectionId: string,
  externalBindingId: string,
): BrowserSessionAuthorization {
  const raw = claims[BROWSER_COHORT_CLAIM];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad();
  const a = raw as Record<string, unknown>;
  if (
    Object.keys(a).sort().join(",") !==
      "connection_generation,principal_generation,tenants" ||
    !Array.isArray(a.tenants) ||
    a.tenants.length < 1 ||
    a.tenants.length > MAX_BROWSER_TENANTS ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.auth_time) ||
    (claims.auth_time as number) > (claims.iat as number)
  )
    throw bad();
  const bindings = a.tenants.map((v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
    const b = v as Record<string, string>;
    if (
      Object.keys(b).sort().join(",") !==
        "binding_generation,credential_generation,tenant,tenant_generation" ||
      typeof b.tenant !== "string"
    )
      throw bad();
    return {
      tenantId: b.tenant,
      tenantGeneration: b.tenant_generation,
      bindingId: identityBindingId(principalId, b.tenant),
      bindingGeneration: b.binding_generation,
      credentialGeneration: b.credential_generation,
    };
  });
  const authorization = {
    version: 1,
    principalGeneration: a.principal_generation,
    connectionId,
    connectionGeneration: a.connection_generation,
    externalBindingId,
    issuedAtMs: (claims.iat as number) * 1000,
    authenticatedAtMs: (claims.auth_time as number) * 1000,
    bindings,
    ...(claims.amr !== undefined || claims.acr !== undefined
      ? {
          authentication: {
            ...(claims.amr !== undefined ? { amr: claims.amr } : {}),
            ...(claims.acr !== undefined ? { acr: claims.acr } : {}),
          },
        }
      : {}),
  };
  if (!isBrowserAuthorization(authorization)) throw bad();
  return authorization;
}
export function oidcRoutes(
  store: Store,
  input: OidcLoginSettings,
  options: { fetch?: client.CustomFetch; failureRedirect?: boolean } = {},
) {
  const s = validateOidcSettings(input);
  const config = configuration(
    s,
    options.fetch ?? ((url, options) => fetch(url, options as RequestInit)),
  );
  const identity = new IdentityStore(store);
  const flows = store.catalog.collection<OidcFlow>("oidc_login_flows");
  const router = Router();
  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).catch((error) => {
        // Synthetic tests inspect the denial directly. The mounted browser flow
        // returns one fixed, actionable notice and never exposes provider errors.
        if (
          options.failureRedirect !== false &&
          req.path === "/oidc/callback" &&
          error instanceof ApiError &&
          error.status === 401
        ) {
          res
            .set("Cache-Control", "no-store")
            .redirect(`${s.frontendOrigin}/login?error=oidc_failed`);
        } else next(error);
      });
    };
  async function connection() {
    const c = await identity.connections.findOne({
      _id: s.connectionId,
      issuer: s.issuer,
      kind: "oidc",
      status: "active",
    });
    if (!c || !ID.test(c.generation)) throw bad();
    return c;
  }
  router.get(
    "/oidc/start",
    wrap(async (req, res) => {
      const c = await connection();
      const tenantHint = singleton(
        req,
        "tenant",
        /^[a-z0-9][a-z0-9-]{0,31}$/,
        false,
      );
      if (Object.keys(req.query).some((k) => k !== "tenant")) throw bad();
      const token = newToken();
      const now = new Date();
      const flow: OidcFlow = {
        _id: hashToken(token),
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier: client.randomPKCECodeVerifier(),
        connectionId: c._id,
        connectionGeneration: c.generation,
        clientId: s.clientId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + FLOW_MS),
        ...(tenantHint ? { tenantHint } : {}),
      };
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: `${s.frontendOrigin}/auth/oidc/callback`,
        response_type: "code",
        scope: "openid email profile",
        prompt: "login",
        max_age: "0",
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(
          flow.codeVerifier,
        ),
        code_challenge_method: "S256",
      });
      await flows.insertOne(flow);
      flowCookie(res, token);
      res.set("Cache-Control", "no-store").redirect(url.href);
    }),
  );
  router.get(
    "/oidc/callback",
    wrap(async (req, res) => {
      res.set("Cache-Control", "no-store");
      const state = singleton(req, "state", /^[A-Za-z0-9_-]{16,128}$/)!;
      const code = singleton(req, "code", /^[^\p{Cc}\p{Cf}\s]{1,4096}$/u)!;
      if (
        Object.keys(req.query).some(
          (k) => !["state", "code", "iss"].includes(k),
        ) ||
        (req.query.iss !== undefined && req.query.iss !== s.issuer)
      )
        throw bad();
      const cookies = parseCookies(req.get("cookie"));
      const token = cookies.get(flowName());
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw bad();
      const c = await connection();
      const flow = await flows.findOneAndDelete({
        _id: hashToken(token),
        state,
        connectionId: c._id,
        connectionGeneration: c.generation,
        clientId: s.clientId,
        expiresAt: { $gt: new Date() },
      });
      if (!flow) throw bad();
      // The consumed code is never retried, including when its response was lost.
      let claims: Record<string, unknown>;
      try {
        const url = new URL(`${s.frontendOrigin}/auth/oidc/callback`);
        url.searchParams.set("code", code);
        url.searchParams.set("state", state);
        if (req.query.iss) url.searchParams.set("iss", s.issuer);
        const result = await client.authorizationCodeGrant(config, url, {
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          pkceCodeVerifier: flow.codeVerifier,
          maxAge: FLOW_MS / 1000,
        });
        if (!result.id_token || result.id_token.length > 65536) throw bad();
        const header = decodeProtectedHeader(result.id_token);
        if (
          header.alg !== s.signingAlgorithm ||
          ["jku", "jwk", "x5u", "x5c", "x5t", "crit", "zip"].some(
            (k) => header[k] !== undefined,
          ) ||
          (header.typ !== undefined &&
            !["JWT", "application/jwt"].includes(header.typ))
        )
          throw bad();
        claims = result.claims() as Record<string, unknown>;
        const now = Math.floor(Date.now() / 1000);
        if (
          !claims ||
          typeof claims.sub !== "string" ||
          !Number.isSafeInteger(claims.iat) ||
          !Number.isSafeInteger(claims.auth_time) ||
          !Number.isSafeInteger(claims.exp) ||
          (claims.auth_time as number) <
            Math.floor(flow.createdAt.getTime() / 1000) - CLOCK_SECONDS ||
          (claims.iat as number) > now ||
          (claims.exp as number) <= now ||
          (claims.exp as number) - (claims.iat as number) > 600
        )
          throw bad();
      } catch {
        throw bad();
      }
      const human = await identity.resolveHuman(
        s.connectionId,
        s.issuer,
        claims.sub as string,
      );
      const authorization = browserAttestation(
        claims,
        human.principal.id,
        c._id,
        human.externalBindingId,
      );
      if (
        authorization.principalGeneration !== human.principal.generation ||
        authorization.connectionGeneration !== c.generation
      )
        throw bad();
      const selected =
        flow.tenantHint ??
        (authorization.bindings.length === 1
          ? authorization.bindings[0].tenantId
          : null);
      if (
        selected &&
        !authorization.bindings.some((b) => b.tenantId === selected)
      )
        throw bad();
      const issued = sessionRecord({
        userId: human.principal.id,
        tenantId: selected,
        app: "main",
        userAgent: req.get("user-agent"),
        authorization,
        absoluteExpiresAt: new Date(Date.now() + s.sessionHours * 3600000),
      });
      await store.withCatalogTransaction(async (tx) => {
        const live = await browserTenants(store, issued.document, tx);
        if (live.length !== authorization.bindings.length) throw bad();
        const old = cookies.get(cookieSpec("main").name);
        if (old && /^[A-Za-z0-9_-]{43}$/.test(old))
          await store.authSessions.deleteOne(
            { _id: hashToken(old), app: "main" },
            { session: tx },
          );
        await store.authSessions.insertOne(issued.document, { session: tx });
        await identity.audit.insertOne(
          {
            _id: randomUUID(),
            action: "session.oidc.login",
            actor: human.principal,
            targetId: issued.document._id,
            generation: human.principal.generation,
            ...(selected ? { tenantId: selected } : {}),
            at: new Date(),
          },
          { session: tx },
        );
      });
      // Do not clear the flow cookie here: an older callback must not clear a
      // newer flow started in another tab. The spent row makes it inert.
      setSessionCookie(res, issued.document, issued.token);
      res.redirect(`${s.frontendOrigin}${selected ? "/" : "/select-tenant"}`);
    }),
  );
  return router;
}
export async function ensureOidcIndexes(store: Store) {
  await store.catalog
    .collection<OidcFlow>("oidc_login_flows")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
