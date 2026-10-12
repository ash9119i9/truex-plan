import { randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ClientSession } from "mongodb";
import * as client from "openid-client";
import { errorFields, log } from "../../shared/logging";
import {
  cookieSpec,
  cleanDisplayName,
  createSession,
  emailKey,
  hashToken,
  newToken,
  parseCookies,
  userTenants,
  validEmail,
  type InviteDocument,
  type MembershipDocument,
  type UserDocument,
} from "./auth";
import type { Store } from "./store";
import { DEFAULT_TENANT_ID, effectivePrivacy, tenantDbName, tenantId as validateTenantId } from "./tenant";
import type { DemoAdmission, DemoGate } from "./demo";
import { ApiError } from "./errors";

// Google sign-in (AUTH_MODE=google): authorization code flow with PKCE,
// state and nonce, for personal Gmail and Google Workspace accounts alike.
// A person who already belongs to a workspace signs in to it. A person who
// belongs to none joins the operator-provisioned default signup tenant.
// Configured demo deployments retain their existing admission rules.
// Tokens and claims never go into a URL
// or a log; the one exception is the wrong-account redirect, which carries
// the signed-in email so the invite page can say who the user signed in as.

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  issuer: string;
  appUrl: string;
  redirectUri: string;
}

export interface DefaultSignupSettings {
  enabled: boolean;
  tenantId: string;
}
export function defaultSignupSettings(
  env: NodeJS.ProcessEnv = process.env,
): DefaultSignupSettings {
  const value = env.DEFAULT_TENANT_SIGNUP?.trim().toLowerCase();
  if (value && value !== "on" && value !== "off")
    throw new Error("DEFAULT_TENANT_SIGNUP must be on or off.");
  return {
    enabled: value !== "off",
    tenantId: validateTenantId(
      env.DEFAULT_SIGNUP_TENANT_ID?.trim() || "default-tenant",
    ),
  };
}

export function googleSettings(env: NodeJS.ProcessEnv = process.env): GoogleSettings {
  const appUrl = (
    env.APP_PUBLIC_URL?.trim() ||
    env.FRONTEND_ORIGIN?.trim() ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
  return {
    clientId: env.GOOGLE_CLIENT_ID?.trim() ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    // Overridable so tests can point at a fake issuer.
    issuer: env.GOOGLE_ISSUER_URL?.trim() || "https://accounts.google.com",
    appUrl,
    redirectUri: `${appUrl}/auth/google/callback`,
  };
}

const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Refuses an unsafe production setup at startup. The issuer override exists
 * for tests that point at a fake issuer; a production process must talk to
 * Google over https and be reached on an https origin, whatever the env says.
 */
export function assertGoogleConfig(
  settings: GoogleSettings,
  env: NodeJS.ProcessEnv = process.env,
) {
  let origin: URL;
  try {
    origin = new URL(settings.appUrl);
  } catch {
    throw new Error("APP_PUBLIC_URL / FRONTEND_ORIGIN is not a valid URL.");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username)
    throw new Error(
      "APP_PUBLIC_URL / FRONTEND_ORIGIN must be an origin with no path, query or credentials.",
    );
  if (env.NODE_ENV !== "production") return;
  if (origin.protocol !== "https:")
    throw new Error("Production Google sign-in needs an https APP_PUBLIC_URL / FRONTEND_ORIGIN.");
  if (settings.issuer !== GOOGLE_ISSUER)
    throw new Error("GOOGLE_ISSUER_URL may only be changed outside production.");
}

// Same public-origin rule as the session cookie: __Host- and Secure on https,
// the plain name without Secure on http dev origins.
export function flowCookieSpec(env: NodeJS.ProcessEnv = process.env) {
  const { secure } = cookieSpec("main", env);
  return { name: secure ? "__Host-truex_flow" : "truex_flow", secure };
}
const FLOW_MS = 10 * 60_000;
function setFlowCookie(res: Response, value: string, maxAgeMs: number) {
  const { name, secure } = flowCookieSpec();
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type ErrorCode =
  | "email_unverified"
  | "wrong_account"
  | "invite_expired"
  | "invite_used"
  | "invite_revoked"
  | "not_invited"
  | "account_conflict"
  | "account_disabled"
  | "access_removed"
  | "no_tenant"
  | "tenant_disabled"
  | "demo_unavailable"
  | "default_unavailable"
  | "unavailable"
  | "signup_limit"
  | "session_expired"
  | "google_failed"
  | "invalid_name";
// Codes the plan shows on the invite page; the rest go to /login.
const INVITE_PAGE = new Set<ErrorCode>([
  "invalid_name",
  "email_unverified",
  "wrong_account",
  "invite_expired",
  "invite_used",
  "invite_revoked",
  "account_conflict",
]);

class SignInError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: Record<string, string> = {},
  ) {
    super(code);
  }
}

// Visible characters only: no control, zero-width or bidirectional-override
// characters, which could make a name read differently from what it is.
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export { cleanDisplayName } from "./auth";
/** Google's name claim, made safe to store and show; undefined if nothing is left. */
export function profileName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(INVISIBLE, " ").trim().replace(/\s+/gu, " ");
  return name ? [...name].slice(0, 100).join("") : undefined;
}
/** Google serves avatars from googleusercontent.com over https; anything else is dropped. */
export function profilePicture(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !(host === "googleusercontent.com" || host.endsWith(".googleusercontent.com"))
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function inviteState(invite: InviteDocument, now = Date.now()): ErrorCode | undefined {
  if (invite.status === "accepted") return "invite_used";
  if (invite.status === "revoked") return "invite_revoked";
  if (invite.expiresAt.getTime() <= now) return "invite_expired";
  return undefined;
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function googleRoutes(
  store: Store,
  settings = googleSettings(),
  demo?: DemoGate,
  defaultSignup = defaultSignupSettings(),
) {
  const router = Router();

  // Discovered once per process; a failed discovery is retried next time. The
  // same timeout bounds every later request to Google, so a stalled provider
  // fails the sign-in instead of holding it open.
  let config: Promise<client.Configuration> | undefined;
  const discover = () => {
    config ??= client
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret,
        undefined,
        {
          timeout: 10,
          ...(new URL(settings.issuer).protocol === "http:"
            ? { execute: [client.allowInsecureRequests] }
            : {}),
        },
      )
      .then((discovered) => {
        // The ID token comes straight from Google's token endpoint over TLS,
        // which the OIDC spec accepts without a signature check. The signature
        // is checked as well, against Google's published keys (cached), so a
        // token that did not come from Google's keys is refused even if that
        // channel were ever compromised. Failing to fetch the keys fails the
        // sign-in; nothing is let through.
        client.enableNonRepudiationChecks(discovered);
        return discovered;
      })
      .catch((error) => {
        config = undefined;
        throw error;
      });
    return config;
  };

  const redirectError = (
    res: Response, error: SignInError, inviteToken?: string,
  ) => {
    const query = new URLSearchParams({ error: error.code, ...error.extra });
    const path =
      inviteToken && INVITE_PAGE.has(error.code)
        ? `/invite/${encodeURIComponent(inviteToken)}`
        : "/login";
    res.redirect(302, `${settings.appUrl}${path}?${query}`);
  };

  const googleFailed = (reason: string, error?: unknown) => {
    // Never the callback URL, code, tokens or claims.
    log("warn", "Google sign-in failed", {
      reason,
      ...(error ? errorFields(error) : {}),
    });
    return new SignInError("google_failed");
  };

  router.get("/google/start", (req: Request, res: Response) => {
    const raw = typeof req.query.invite === "string" ? req.query.invite : undefined;
    const run = async () => {
      let invite: InviteDocument | null = null;
      let displayName: string | undefined;
      // Retired team-link entry must not start another signup or consume an invite.
      if (req.query.join !== undefined)
        throw new SignInError("not_invited");
      if (raw !== undefined) {
        invite = TOKEN.test(raw)
          ? await store.invites.findOne({ tokenHash: hashToken(raw) })
          : null;
        if (!invite) throw new SignInError("not_invited");
        const state = inviteState(invite);
        if (state) throw new SignInError(state);
        // Only an invite sign-in takes a name; plain /login ignores it. A
        // repeated ?name= arrives as an array and counts as invalid.
        if (req.query.name !== undefined) {
          displayName =
            typeof req.query.name === "string"
              ? cleanDisplayName(req.query.name)
              : undefined;
          if (!displayName) throw new SignInError("invalid_name");
        }
      }
      let oidc: client.Configuration;
      try {
        oidc = await discover();
      } catch (error) {
        throw googleFailed("discovery", error);
      }
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();
      const flowId = newToken();
      await store.authFlows.insertOne({
        _id: hashToken(flowId),
        state,
        nonce,
        codeVerifier,
        // The raw token lives here at most 10 minutes, only to build the
        // /invite/<token>?error=… URL on the callback.
        ...(invite ? { inviteId: invite._id, inviteToken: raw } : {}),
        ...(displayName ? { displayName } : {}),
        createdAt: new Date(),
      });
      setFlowCookie(res, flowId, FLOW_MS);
      const url = client.buildAuthorizationUrl(oidc, {
        redirect_uri: settings.redirectUri,
        scope: "openid email profile",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce,
        ...(invite ? { login_hint: invite.email } : {}),
        prompt: "select_account",
      });
      log("info", "google sign-in started", { flow: invite ? "invite" : "login" });
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, url.href);
    };
    run().catch((error) => {
      if (error instanceof SignInError) return redirectError(res, error, raw);
      log("error", "google sign-in could not start", errorFields(error));
      redirectError(res, new SignInError("unavailable"));
    });
  });

  router.get("/google/callback", (req: Request, res: Response) => {
    let inviteToken: string | undefined;
    const run = async () => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      const flowId = parseCookies(req.get("cookie")).get(flowCookieSpec().name);
      const state = req.query.state;
      const fail = (code: ErrorCode, clearCookie: boolean) => {
        if (clearCookie) setFlowCookie(res, "", 0);
        throw new SignInError(code);
      };
      if (!flowId || !TOKEN.test(flowId)) return fail("session_expired", true);
      const stored = await store.authFlows.findOne({ _id: hashToken(flowId) });
      // The TTL monitor runs about once a minute, so check the age here too.
      if (!stored || Date.now() - stored.createdAt.getTime() > FLOW_MS)
        return fail("session_expired", true);
      // A callback that belongs to another flow (an older tab started a second
      // sign-in, which replaced this cookie) is refused WITHOUT consuming the
      // newer flow or clearing its cookie, so the newer tab can still finish.
      if (typeof state !== "string" || !sameText(state, stored.state))
        return fail("session_expired", false);
      // Single use: only one callback can take the flow; a replay finds none.
      const flow = await store.authFlows.findOneAndDelete({
        _id: stored._id,
        state: stored.state,
      });
      setFlowCookie(res, "", 0);
      if (!flow) throw new SignInError("session_expired");
      inviteToken = flow.inviteToken;
      if (req.query.error !== undefined) throw googleFailed("provider_error");
      // Repeated parameters arrive as arrays; the grant needs exactly one each.
      if (typeof req.query.code !== "string") throw googleFailed("missing_code");

      // From here the authorization code is spent. A failure or timeout ends
      // the flow; nothing replays the code.
      let claims: client.IDToken | undefined;
      try {
        const current = new URL(settings.redirectUri);
        current.search = new URL(req.originalUrl, "http://callback").search;
        const tokens = await client.authorizationCodeGrant(await discover(), current, {
          pkceCodeVerifier: flow.codeVerifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
        });
        claims = tokens.claims();
      } catch (error) {
        throw googleFailed("exchange", error);
      }
      if (!claims) throw googleFailed("no_id_token");
      const identity = identityFrom(claims);

      const { user, tenantId, picker } = flow.inviteId
        ? await acceptInvite(store, flow.inviteId, identity, flow.displayName)
        : await signIn(store, identity, demo, defaultSignup);

      await store.users.updateOne(
        { _id: user._id },
        {
          $set: {
            lastLoginAt: new Date().toISOString(),
            ...(tenantId && !picker ? { lastTenantId: tenantId } : {}),
          },
        },
      );
      // A new token on every sign-in; an older session in this browser ends.
      const old = parseCookies(req.get("cookie")).get(cookieSpec("main").name);
      if (old && TOKEN.test(old))
        await store.authSessions.deleteOne({ _id: hashToken(old) });
      await createSession(store, res, {
        userId: user._id,
        tenantId,
        app: "main",
        userAgent: req.get("user-agent"),
      });
      log("info", "google sign-in completed", {
        userId: user._id,
        tenantId,
        flow: flow.inviteId ? "invite" : "login",
      });
      // An invite sign-in lands back on the invite page, which shows the
      // joined state; the token is already in that URL, nothing else is.
      const next = flow.inviteToken
        ? `/invite/${encodeURIComponent(flow.inviteToken)}?joined=1`
        : picker
          ? "/select-tenant"
          : "/";
      res.redirect(302, `${settings.appUrl}${next}`);
    };
    run().catch((error) => {
      if (error instanceof SignInError) {
        log("info", "google sign-in refused", { code: error.code });
        return redirectError(res, error, inviteToken);
      }
      // This is a browser navigation: a JSON error page would strand the
      // person. Storage or server trouble is logged and reported as a
      // temporary outage they can retry from the sign-in page.
      log("error", "google sign-in unavailable", {
        ...errorFields(error),
        ...(error instanceof ApiError ? { code: error.code } : {}),
      });
      redirectError(res, new SignInError("unavailable"));
    });
  });

  return router;
}

interface Identity {
  sub: string;
  email: string;
  key: string;
  name?: string;
  picture?: string;
}

// Library-verified claims are still untrusted values: a usable subject, a
// valid address Google confirmed, and bounded display fields.
function identityFrom(claims: client.IDToken): Identity {
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!/^[\x21-\x7e]{1,255}$/.test(sub)) throw new SignInError("google_failed");
  const email = validEmail(claims.email);
  if (claims.email_verified !== true || !email)
    throw new SignInError("email_unverified");
  return {
    sub,
    email,
    key: emailKey(email),
    name: profileName(claims.name),
    picture: profilePicture(claims.picture),
  };
}

// Duplicate-key races and the driver's transient or unknown-commit outcomes
// are resolved by running the whole step again against the committed state.
function retryable(error: unknown) {
  const e = error as { code?: number; hasErrorLabel?: (l: string) => boolean };
  return (
    e?.code === 11000 ||
    !!e?.hasErrorLabel?.("TransientTransactionError") ||
    !!e?.hasErrorLabel?.("UnknownTransactionCommitResult")
  );
}
async function settle<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= 3 || !retryable(error)) throw error;
    }
  }
}

const newUser = (identity: Identity, now: Date, id = `u_${randomUUID()}`): UserDocument => ({
  _id: id,
  googleSub: identity.sub,
  email: identity.email,
  emailKey: identity.key,
  ...(identity.name ? { name: identity.name } : {}),
  ...(identity.picture ? { picture: identity.picture } : {}),
  status: "active",
  createdAt: now.toISOString(),
});

async function acceptInvite(
  store: Store,
  inviteId: string,
  identity: Identity,
  displayName?: string,
) {
  // Checked before the claim, so a wrong account leaves the invite pending.
  const invite = await store.invites.findOne({ _id: inviteId });
  if (!invite) throw new SignInError("not_invited");
  if (invite.emailKey !== identity.key)
    throw new SignInError("wrong_account", { email: identity.email });
  const early = inviteState(invite);
  if (early) throw new SignInError(early);

  // One short catalog transaction: the claim, the account and the membership
  // commit together or not at all. A revoke, an expiry or a parallel accept
  // that gets there first makes the claim match nothing, and nothing else is
  // written. Google, mail and cookies stay outside.
  const accepted = await settle(() =>
    store.withCatalogTransaction(async (session) => {
      const now = new Date();
      const current = await store.invites.findOne({ _id: inviteId }, { session });
      if (!current) throw new SignInError("not_invited");
      if (current.emailKey !== identity.key)
        throw new SignInError("wrong_account", { email: identity.email });
      const state = inviteState(current, now.getTime());
      if (state) throw new SignInError(state);
      // A tenant without a registry entry (other than the default) counts as
      // disabled, the simplest safe reading.
      const tenant = await store.tenantRegistry.findOne(
        { _id: current.tenantId },
        { session },
      );
      if (
        tenant?.provisioningStatus === "pending" ||
        tenant?.status === "disabled" ||
        (!tenant && current.tenantId !== DEFAULT_TENANT_ID)
      )
        throw new SignInError("tenant_disabled");

      let user = await store.users.findOne({ googleSub: identity.sub }, { session });
      if (!user) {
        // A different Google account already owns this address.
        if (await store.users.findOne({ emailKey: identity.key }, { session }))
          throw new SignInError("account_conflict");
      } else if (user.status === "disabled") throw new SignInError("account_disabled");
      const userId = user?._id ?? `u_${randomUUID()}`;

      const claimed = await store.invites.findOneAndUpdate(
        { _id: current._id, status: "pending", expiresAt: { $gt: now } },
        {
          $set: {
            status: "accepted",
            acceptedAt: now.toISOString(),
            acceptedBy: userId,
          },
        },
        { session },
      );
      if (!claimed) {
        const latest = await store.invites.findOne({ _id: current._id }, { session });
        throw new SignInError((latest && inviteState(latest)) || "invite_used");
      }
      if (!user) {
        user = newUser(identity, now, userId);
        await store.users.insertOne(user, { session });
      }
      await grantMembership(store, session, user, current, now);
      if (displayName) {
        await store.users.updateOne(
          { _id: user._id },
          { $set: { name: displayName }, $unset: { nameRequired: "" } },
          { session },
        );
        user = { ...user, name: displayName, nameRequired: false };
      }
      return { user, tenantId: current.tenantId };
    }),
  );
  return { ...accepted, picker: false };
}

// A new member gets the invited role. A removed member is restored by this new,
// authorized invite and keeps their user id (and so their content). An active
// member keeps the role they have: an invite never changes it, up or down.
async function grantMembership(
  store: Store,
  session: ClientSession,
  user: UserDocument,
  invite: InviteDocument,
  now: Date,
) {
  const existing = await store.memberships.findOne(
    { userId: user._id, tenantId: invite.tenantId },
    { session },
  );
  if (!existing) {
    await store.memberships.insertOne(
      {
        _id: randomUUID(),
        userId: user._id,
        tenantId: invite.tenantId,
        role: invite.role,
        status: "active",
        inviteId: invite._id,
        createdAt: now.toISOString(),
      } satisfies MembershipDocument,
      { session },
    );
  } else if (existing.status === "removed") {
    await store.memberships.updateOne(
      { _id: existing._id, status: "removed" },
      { $set: { role: invite.role, status: "active", inviteId: invite._id } },
      { session },
    );
  }
}

async function signIn(
  store: Store, identity: Identity, demo?: DemoGate,
  defaultSignup = defaultSignupSettings(),
) {
  // Never accepts pending invites; only the invite link does.
  return settle(async () => {
    let user = await store.users.findOne({ googleSub: identity.sub });
    if (user) {
      if (user.status === "disabled") throw new SignInError("account_disabled");
      user = await refreshProfile(store, user, identity);
      const tenants = await userTenants(store, user._id);
      // A remembered choice is a selector only: the membership list above is
      // authoritative. Without a valid choice keep the existing picker flow.
      if (tenants.length) {
        const remembered = tenants.find((t) => t.id === user!.lastTenantId);
        return {
          user,
          tenantId: remembered?.id ?? tenants[0].id,
          picker: tenants.length > 1 && !remembered,
        };
      }
      // A membership in a disabled workspace is still a membership: say so
      // rather than quietly enrolling the person somewhere else.
      const active = await store.memberships.countDocuments({
        userId: user._id,
        status: "active",
      });
      if (active) throw new SignInError("tenant_disabled");
    } else if (await store.users.findOne({ emailKey: identity.key, googleSub: { $ne: identity.sub } })) {
      // A different Google account holds this address: no linking, no merging.
      throw new SignInError("account_conflict");
    }

    if (!demo?.enabled) {
      if (!defaultSignup.enabled)
        throw new SignInError(user ? "no_tenant" : "not_invited");
      const account = await enrollInDefault(store, identity, defaultSignup.tenantId);
      const tenants = await userTenants(store, account._id);
      if (!tenants.some((t) => t.id === defaultSignup.tenantId))
        throw new SignInError("tenant_disabled");
      return { user: account, tenantId: defaultSignup.tenantId, picker: false };
    }
    const admission = await demo!.admission();
    if (admission.state === "unavailable")
      throw new SignInError("demo_unavailable");
    if (admission.state !== "open")
      throw new SignInError(user ? "no_tenant" : "not_invited");
    const enrolled = await enrollInDemo(store, identity, admission);
    // The enrolment is committed; confirm it still gives access before a
    // session is issued (the per-request check stays authoritative after).
    const tenants = await userTenants(store, enrolled._id);
    const usable = tenants.find((t) => t.id === admission.tenant._id);
    if (!usable) throw new SignInError("tenant_disabled");
    return { user: enrolled, tenantId: usable.id, picker: tenants.length > 1 };
  });
}

// Keeps what Google says about an existing subject current: the picture, a
// missing name, and a changed address when no other account holds the new one.
async function refreshProfile(store: Store, user: UserDocument, identity: Identity) {
  const set: Partial<UserDocument> = {};
  if (identity.picture && identity.picture !== user.picture) set.picture = identity.picture;
  if (!user.name && identity.name) set.name = identity.name;
  if (identity.key !== user.emailKey) {
    const holder = await store.users.findOne({ emailKey: identity.key });
    if (!holder) {
      set.email = identity.email;
      set.emailKey = identity.key;
    } else
      log("warn", "google address change not applied: held by another account", {
        userId: user._id,
      });
  }
  if (!Object.keys(set).length) return user;
  try {
    await store.users.updateOne({ _id: user._id }, { $set: set });
    return { ...user, ...set };
  } catch (error) {
    // Losing the race for the address is the same collision; keep the old one.
    if ((error as { code?: number }).code !== 11000) throw error;
    delete set.email;
    delete set.emailKey;
    if (Object.keys(set).length)
      await store.users.updateOne({ _id: user._id }, { $set: set });
    return { ...user, ...set };
  }
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

// Idempotent: the user and the membership are inserted when missing and never
// changed when present. A removed membership stays removed, and an admin
// membership is never overwritten with "user".
/** Signup grants membership only; tenant creation belongs to operators. */
async function enrollInDefault(
  store: Store,
  identity: Identity,
  tenantId: string,
) {
  // Verify provisioning outside the short transaction, then re-read the tenant
  // inside it. A missing/unsafe tenant must never become an implicit shared DB.
  const tenant = await store.tenantRegistry.findOne({ _id: tenantId });
  const ready = (doc: typeof tenant) => {
    const privacy = effectivePrivacy(doc);
    return (
      !!doc &&
      doc.status === "active" &&
      doc.provisioningStatus !== "pending" &&
      doc.kind !== "personal" &&
      !doc.createdBy &&
      !privacy.invalid &&
      privacy.isUserSpecific === true &&
      doc.dbName === tenantDbName(tenantId) &&
      doc.dbName !== store.database &&
      doc.dbName !== store.catalogDatabase
    );
  };
  if (!ready(tenant)) throw new SignInError("default_unavailable");
  const indexes = await store.client
    .db(tenant!.dbName)
    .collection("truex_agents")
    .indexes()
    .catch((error) => {
      if (error?.code === 26) throw new SignInError("default_unavailable");
      throw error;
    });
  if (
    !indexes.some(
      (i) =>
        i.name === "agent_creator_handle" &&
        i.unique &&
        i.key.createdBy === 1 &&
        i.key.handle === 1,
    ) ||
    indexes.some((i) => i.name === "handle_1")
  )
    throw new SignInError("default_unavailable");
  return store.withCatalogTransaction(async (session) => {
    const current = await store.tenantRegistry.findOne(
      { _id: tenantId },
      { session },
    );
    if (!ready(current)) throw new SignInError("default_unavailable");
    const now = new Date();
    let user = await store.users.findOne(
      { googleSub: identity.sub },
      { session },
    );
    if (user) {
      if (user.status === "disabled") throw new SignInError("account_disabled");
    } else {
      if (await store.users.findOne({ emailKey: identity.key }, { session }))
        throw new SignInError("account_conflict");
      user = { ...newUser(identity, now), nameRequired: true };
      await store.users.insertOne(user, { session });
    }
    const existing = await store.memberships.findOne(
      { userId: user._id, tenantId },
      { session },
    );
    if (existing?.status === "removed") throw new SignInError("access_removed");
    if (!existing)
      await store.memberships.insertOne(
        {
          _id: randomUUID(),
          userId: user._id,
          tenantId,
          role: "user",
          status: "active",
          createdAt: now.toISOString(),
        } satisfies MembershipDocument,
        { session },
      );
    return user;
  });
}

async function enrollInDemo(
  store: Store,
  identity: Identity,
  admission: Extract<DemoAdmission, { state: "open" }>,
) {
  const tenantId = admission.tenant._id;
  return store.withCatalogTransaction(async (session) => {
    const now = new Date();
    let user = await store.users.findOne({ googleSub: identity.sub }, { session });
    if (user) {
      if (user.status === "disabled") throw new SignInError("account_disabled");
    } else {
      if (await store.users.findOne({ emailKey: identity.key }, { session }))
        throw new SignInError("account_conflict");
      // Daily new-account budget, counted in the same transaction as the
      // account so an aborted attempt spends nothing.
      const budget = admission.config.signupsPerDay!;
      const used = await store.demoUsage.findOneAndUpdate(
        { _id: `${utcDay(now)}:${tenantId}:signups` },
        {
          $inc: { count: 1 },
          $setOnInsert: { expiresAt: new Date(now.getTime() + 3 * 86_400_000) },
        },
        { upsert: true, returnDocument: "after", session },
      );
      if (!used || used.count > budget) throw new SignInError("signup_limit");
      user = { ...newUser(identity, now), nameRequired: true };
      await store.users.insertOne(user, { session });
    }
    const existing = await store.memberships.findOne(
      { userId: user._id, tenantId },
      { session },
    );
    if (existing?.status === "removed") throw new SignInError("access_removed");
    if (!existing)
      await store.memberships.insertOne(
        {
          _id: randomUUID(),
          userId: user._id,
          tenantId,
          role: "user",
          status: "active",
          createdAt: now.toISOString(),
        } satisfies MembershipDocument,
        { session },
      );
    return user;
  });
}
