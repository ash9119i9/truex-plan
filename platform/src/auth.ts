import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { ApiError } from "./errors";
import type { Store } from "./store";
import { DEFAULT_TENANT_ID, tenantId } from "./tenant";
import type { UserRef, UserRole } from "./user";

// Catalog documents for sign-in. They live in the catalog DB because sign-in
// has to find a user's tenants before any tenant database is opened.
export interface UserDocument {
  _id: string;
  googleSub: string;
  email: string;
  emailKey: string;
  name?: string;
  picture?: string;
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt?: string;
}
export interface MembershipDocument {
  _id: string;
  userId: string;
  tenantId: string;
  role: UserRole;
  status: "active" | "removed";
  inviteId?: string;
  createdAt: string;
}
export interface InviteDocument {
  _id: string;
  tenantId: string;
  email: string;
  emailKey: string;
  role: UserRole;
  tokenHash: string;
  /** Mirrors acceptedAt/revokedAt; the unique pending index keys on it. */
  status: "pending" | "accepted" | "revoked";
  createdAt: string;
  expiresAt: Date;
  sentAt?: string;
  sendError?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  revokedAt?: string;
}
export type AuthApp = "main" | "admin";
// Dates, not ISO strings: the TTL index on absoluteExpiresAt needs a Date.
export interface AuthSessionDocument {
  /** sha256 of the cookie token; the token itself is never stored. */
  _id: string;
  userId: string | null;
  tenantId: string | null;
  app: AuthApp;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  userAgent?: string;
}
export interface AuthFlowDocument {
  /** sha256 of the flow id held in the flow cookie. */
  _id: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  inviteId?: string;
  /**
   * The raw invite token, kept only for this flow's 10 minutes so a
   * wrong-account callback can link back to /invite/<token>; invites store
   * only its hash.
   */
  inviteToken?: string;
  /** The cleaned name typed on the invite page; never logged or put in a URL. */
  displayName?: string;
  createdAt: Date;
}

// Canonical Gmail address: Gmail delivers every dotted or +tagged spelling
// of a local part to the same inbox.
export function emailKey(email: string) {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1) return value;
  const local = value.slice(0, at).split("+")[0].replace(/\./g, "");
  return `${local}${value.slice(at)}`;
}
export const isGmail = (email: string) =>
  /^[^@\s]+@gmail\.com$/i.test(email.trim());
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Main: 7 days idle, 30 days absolute. Admin: 8 hours absolute, no sliding.
const LIFETIME: Record<AuthApp, { idle: number; absolute: number }> = {
  main: { idle: 7 * DAY, absolute: 30 * DAY },
  admin: { idle: 8 * HOUR, absolute: 8 * HOUR },
};
const TOUCH_MS = MINUTE;

const COOKIE_BASE: Record<AuthApp, string> = {
  main: "truex_session",
  admin: "truex_admin",
};

// The one place that decides a cookie's name and Secure flag, so setting,
// clearing and reading always agree. It goes by the app's public origin, not
// req.hostname: behind the Next forwarder the platform only sees the internal
// hop. Browsers refuse a __Host- cookie without Secure, so plain-http dev
// origins get the unprefixed name and no Secure. An unparsable origin counts
// as https, the stricter choice.
export function cookieSpec(
  app: AuthApp,
  env: NodeJS.ProcessEnv = process.env,
): { name: string; secure: boolean } {
  const origin =
    (app === "admin" ? env.ADMIN_ORIGIN : env.FRONTEND_ORIGIN)?.trim() ||
    env.FRONTEND_ORIGIN?.trim() ||
    "http://localhost:3000";
  let secure = true;
  try {
    secure = new URL(origin).protocol === "https:";
  } catch {
    // Keep secure.
  }
  const base = COOKIE_BASE[app];
  return { name: secure ? `__Host-${base}` : base, secure };
}

// Parsed by hand; the first occurrence of a name wins.
export function parseCookies(header: string | undefined) {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || out.has(name)) continue;
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Malformed escapes stay as sent; the token check rejects them.
    }
    out.set(name, value);
  }
  return out;
}

// Path=/ and no Domain in both cases, as __Host- requires.
function setCookie(res: Response, app: AuthApp, value: string, maxAgeMs: number) {
  const { name, secure } = cookieSpec(app);
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
const clearCookie = (res: Response, app: AuthApp) => setCookie(res, app, "", 0);

/** Stores only the token's hash, sets the cookie and returns the token. */
export async function createSession(
  store: Store,
  res: Response,
  options: {
    userId: string | null;
    tenantId: string | null;
    app: AuthApp;
    userAgent?: string;
  },
) {
  const token = newToken();
  const now = new Date();
  const life = LIFETIME[options.app];
  await store.authSessions.insertOne({
    _id: hashToken(token),
    userId: options.userId,
    tenantId: options.tenantId,
    app: options.app,
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: new Date(now.getTime() + life.idle),
    absoluteExpiresAt: new Date(now.getTime() + life.absolute),
    ...(options.userAgent
      ? { userAgent: options.userAgent.slice(0, 256) }
      : {}),
  });
  setCookie(res, options.app, token, life.absolute);
  return token;
}

const cookieToken = (req: Request, app: AuthApp) => {
  const token = parseCookies(req.get("cookie")).get(cookieSpec(app).name);
  return token && TOKEN.test(token) ? token : undefined;
};

/** The request's valid session for app, or undefined. */
export async function readSession(
  store: Store,
  req: Request,
  app: AuthApp,
): Promise<AuthSessionDocument | undefined> {
  const token = cookieToken(req, app);
  if (!token) return undefined;
  const id = hashToken(token);
  const session = await store.authSessions.findOne({ _id: id });
  if (!session || session.app !== app) return undefined;
  const now = Date.now();
  if (
    session.idleExpiresAt.getTime() <= now ||
    session.absoluteExpiresAt.getTime() <= now
  ) {
    await store.authSessions.deleteOne({ _id: id });
    return undefined;
  }
  // Written at most once a minute; admin sessions never slide.
  if (now - session.lastSeenAt.getTime() >= TOUCH_MS) {
    const lastSeenAt = new Date(now);
    const idleExpiresAt =
      app === "main"
        ? new Date(
            Math.min(
              now + LIFETIME.main.idle,
              session.absoluteExpiresAt.getTime(),
            ),
          )
        : session.idleExpiresAt;
    await store.authSessions.updateOne(
      { _id: id },
      { $set: { lastSeenAt, idleExpiresAt } },
    );
    Object.assign(session, { lastSeenAt, idleExpiresAt });
  }
  return session;
}

export async function deleteSession(
  store: Store,
  req: Request,
  res: Response,
  app: AuthApp,
) {
  const token = cookieToken(req, app);
  if (token) await store.authSessions.deleteOne({ _id: hashToken(token) });
  clearCookie(res, app);
}

/** Ends every session of a user in a tenant, e.g. on member removal. */
export async function revokeSessions(
  store: Store,
  scope: { userId: string; tenantId: string },
) {
  const { deletedCount } = await store.authSessions.deleteMany({
    userId: scope.userId,
    tenantId: scope.tenantId,
    app: "main",
  });
  return deletedCount;
}

const unauthenticated = () =>
  new ApiError(401, "Sign in to continue", "UNAUTHENTICATED");
const wrongApp = () =>
  new ApiError(
    403,
    "This session belongs to a different app",
    "WRONG_APP",
  );

// A main session whose user is still active. Missing or invalid is 401; a
// request carrying only an admin session is 403 WRONG_APP.
async function mainSession(store: Store, req: Request) {
  const session = await readSession(store, req, "main");
  if (!session?.userId || !session.tenantId) {
    if (await readSession(store, req, "admin")) throw wrongApp();
    throw unauthenticated();
  }
  const user = await store.users.findOne({
    _id: session.userId,
    status: "active",
  });
  if (!user) {
    await store.authSessions.deleteOne({ _id: session._id });
    throw unauthenticated();
  }
  return { session, user };
}

/** Active memberships of a user in tenants that are not disabled. */
export async function userTenants(store: Store, userId: string) {
  const memberships = await store.memberships
    .find({ userId, status: "active" })
    .sort({ createdAt: 1 })
    .toArray();
  if (!memberships.length) return [];
  const docs = await store.tenantRegistry
    .find({ _id: { $in: memberships.map((m) => m.tenantId) } })
    .toArray();
  const byId = new Map(docs.map((d) => [d._id, d]));
  return memberships.flatMap((m) => {
    const doc = byId.get(m.tenantId);
    if (doc?.status === "disabled") return [];
    // The default tenant exists without a registry entry.
    if (!doc && m.tenantId !== DEFAULT_TENANT_ID) return [];
    return [
      { id: m.tenantId, name: doc?.name ?? m.tenantId, role: m.role },
    ];
  });
}

/**
 * Google mode's replacement for the dev tenant and user resolvers on /api.
 * /api/admin/* needs an admin session; everything else a main session with an
 * active user, an active membership and a tenant resolveTenant() accepts.
 */
export function authMiddleware(store: Store) {
  const handle = async (req: Request, res: Response) => {
    const path = req.baseUrl + req.path;
    if (/^\/api\/admin(\/|$)/.test(path)) {
      const admin = await readSession(store, req, "admin");
      if (!admin) {
        if (await readSession(store, req, "main")) throw wrongApp();
        throw unauthenticated();
      }
      res.locals.admin = true;
      return;
    }
    const { session, user } = await mainSession(store, req);
    const membership = await store.memberships.findOne({
      userId: user._id,
      tenantId: session.tenantId!,
      status: "active",
    });
    if (!membership) {
      await store.authSessions.deleteOne({ _id: session._id });
      throw unauthenticated();
    }
    // Throws TENANT_DISABLED (403) for a disabled tenant, within its cache.
    res.locals.tenant = await store.resolveTenant(membership.tenantId);
    const ref: UserRef = {
      id: user._id,
      email: user.email,
      role: membership.role,
    };
    res.locals.user = ref;
    res.locals.profile = {
      ...(user.name ? { name: user.name } : {}),
      ...(user.picture ? { picture: user.picture } : {}),
    };
  };
  return (req: Request, res: Response, next: NextFunction) => {
    handle(req, res).then(() => next(), next);
  };
}

const STATE_CHANGING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * State-changing requests must come from a known origin and carry JSON.
 * Uploads are base64 JSON, so there is no multipart exception. Bodyless
 * requests (e.g. POST /auth/logout) only need the Origin check.
 * allowMissingOrigin is for dev mode only, so curl and tests work without an
 * Origin header; a present but foreign Origin is refused in every mode.
 */
export function csrfMiddleware(options: {
  origins: string[];
  allowMissingOrigin: boolean;
}) {
  const origins = new Set(options.origins.filter(Boolean));
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!STATE_CHANGING.has(req.method)) return next();
    const origin = req.get("origin");
    if (origin ? !origins.has(origin) : !options.allowMissingOrigin)
      return next(
        new ApiError(403, "Request origin is not allowed", "CSRF_ORIGIN"),
      );
    // Browsers and fetch send "Content-Length: 0" on a bodyless POST, which
    // type-is counts as a body; treat it as bodyless. Otherwise req.is gives
    // null for no body and false for a body of another type.
    const empty =
      req.get("content-length") === "0" && !req.get("transfer-encoding");
    if (!empty && req.is("application/json") === false)
      return next(
        new ApiError(
          415,
          "Requests must be sent as application/json",
          "UNSUPPORTED_MEDIA_TYPE",
        ),
      );
    next();
  };
}

/**
 * Fixed-window limit per req.ip, kept in memory. Behind the Next forwarder
 * req.ip is the forwarder's address, so every user would share one bucket;
 * set TRUST_PROXY (Express "trust proxy") so req.ip comes from
 * X-Forwarded-For instead.
 */
export function rateLimit(options: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (hits.size > 10_000)
      for (const [key, hit] of hits) if (hit.reset <= now) hits.delete(key);
    const key = req.ip ?? "unknown";
    let hit = hits.get(key);
    if (!hit || hit.reset <= now) {
      hit = { count: 0, reset: now + options.windowMs };
      hits.set(key, hit);
    }
    if (++hit.count > options.max) {
      res.setHeader("Retry-After", String(Math.ceil((hit.reset - now) / 1000)));
      return next(
        new ApiError(429, "Too many requests, try again shortly", "RATE_LIMITED"),
      );
    }
    next();
  };
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** Session endpoints under /auth (google mode). */
export function authRoutes(store: Store) {
  const router = Router();
  router.post(
    "/logout",
    wrap(async (req, res) => {
      await deleteSession(store, req, res, "main");
      res.status(204).end();
    }),
  );
  router.get(
    "/tenants",
    wrap(async (req, res) => {
      const { user } = await mainSession(store, req);
      res.json({ tenants: await userTenants(store, user._id) });
    }),
  );
  router.post(
    "/switch-tenant",
    wrap(async (req, res) => {
      const { user } = await mainSession(store, req);
      const target = tenantId(req.body?.tenantId);
      const membership = await store.memberships.findOne({
        userId: user._id,
        tenantId: target,
        status: "active",
      });
      if (!membership)
        throw new ApiError(
          403,
          "You are not a member of this workspace",
          "NOT_A_MEMBER",
        );
      await store.resolveTenant(target);
      // A new token on every switch; the old one stops working.
      await deleteSession(store, req, res, "main");
      await createSession(store, res, {
        userId: user._id,
        tenantId: target,
        app: "main",
        userAgent: req.get("user-agent"),
      });
      res.json({ tenant: { id: target }, role: membership.role });
    }),
  );
  return router;
}
