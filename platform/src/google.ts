import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import * as client from "openid-client";
import { errorFields, log } from "../../shared/logging";
import {
  cookieSpec,
  createSession,
  emailKey,
  hashToken,
  isGmail,
  newToken,
  parseCookies,
  userTenants,
  type InviteDocument,
  type UserDocument,
} from "./auth";
import type { Store } from "./store";
import { DEFAULT_TENANT_ID } from "./tenant";

// Google sign-in (AUTH_MODE=google): authorization code flow with PKCE,
// state and nonce. Accounts are created only by accepting an invite; /login
// only signs existing users in. Tokens and claims never go into a URL or a
// log; the one exception is the wrong-account redirect, which carries the
// signed-in email so the invite page can say who the user signed in as.

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  issuer: string;
  appUrl: string;
  redirectUri: string;
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
  | "gmail_only"
  | "wrong_account"
  | "invite_expired"
  | "invite_used"
  | "invite_revoked"
  | "not_invited"
  | "account_conflict"
  | "account_disabled"
  | "no_tenant"
  | "tenant_disabled"
  | "session_expired"
  | "google_failed"
  | "invalid_name";
// Codes the plan shows on the invite page; the rest go to /login.
const INVITE_PAGE = new Set<ErrorCode>([
  "invalid_name",
  "gmail_only",
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

/**
 * The name typed on the invite page: trimmed, inner whitespace collapsed,
 * 2 to 60 characters with at least one letter. undefined when invalid.
 */
export function cleanDisplayName(value: string): string | undefined {
  const name = value.trim().replace(/\s+/gu, " ");
  const length = [...name].length;
  if (length < 2 || length > 60 || !/\p{L}/u.test(name)) return undefined;
  return name;
}

function inviteState(invite: InviteDocument, now = Date.now()): ErrorCode | undefined {
  if (invite.status === "accepted") return "invite_used";
  if (invite.status === "revoked") return "invite_revoked";
  if (invite.expiresAt.getTime() <= now) return "invite_expired";
  return undefined;
}

export function googleRoutes(store: Store, settings = googleSettings()) {
  const router = Router();

  // Discovered once per process; a failed discovery is retried next time.
  let config: Promise<client.Configuration> | undefined;
  const discover = () => {
    config ??= client
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret,
        undefined,
        new URL(settings.issuer).protocol === "http:"
          ? { execute: [client.allowInsecureRequests] }
          : undefined,
      )
      .catch((error) => {
        config = undefined;
        throw error;
      });
    return config;
  };

  const redirectError = (res: Response, error: SignInError, inviteToken?: string) => {
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

  router.get("/google/start", (req: Request, res: Response, next: NextFunction) => {
    const raw = typeof req.query.invite === "string" ? req.query.invite : undefined;
    const run = async () => {
      let invite: InviteDocument | null = null;
      let displayName: string | undefined;
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
      res.redirect(302, url.href);
    };
    run().catch((error) => {
      if (error instanceof SignInError) return redirectError(res, error, raw);
      next(error);
    });
  });

  router.get("/google/callback", (req: Request, res: Response, next: NextFunction) => {
    let inviteToken: string | undefined;
    const run = async () => {
      // Single use: the flow is deleted as it is read, and the cookie cleared.
      const flowId = parseCookies(req.get("cookie")).get(flowCookieSpec().name);
      setFlowCookie(res, "", 0);
      const flow =
        flowId && TOKEN.test(flowId)
          ? await store.authFlows.findOneAndDelete({ _id: hashToken(flowId) })
          : null;
      // The TTL monitor runs about once a minute, so check the age here too.
      if (!flow || Date.now() - flow.createdAt.getTime() > FLOW_MS)
        throw new SignInError("session_expired");
      inviteToken = flow.inviteToken;
      if (req.query.error !== undefined) throw googleFailed("provider_error");

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
      const email = typeof claims.email === "string" ? claims.email.trim() : "";
      if (claims.email_verified !== true || !isGmail(email) || claims.hd !== undefined)
        throw new SignInError("gmail_only");
      const identity = {
        sub: claims.sub,
        email,
        key: emailKey(email),
        name: typeof claims.name === "string" ? claims.name : undefined,
        picture: typeof claims.picture === "string" ? claims.picture : undefined,
      };

      const { user, tenantId, picker } = flow.inviteId
        ? await acceptInvite(store, flow.inviteId, identity, flow.displayName)
        : await signIn(store, identity.sub);

      await store.users.updateOne(
        { _id: user._id },
        { $set: { lastLoginAt: new Date().toISOString() } },
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
      if (error instanceof SignInError)
        return redirectError(res, error, inviteToken);
      next(error);
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

async function acceptInvite(
  store: Store,
  inviteId: string,
  identity: Identity,
  displayName?: string,
) {
  const invite = await store.invites.findOne({ _id: inviteId });
  if (!invite) throw new SignInError("not_invited");
  // Checked before the claim, so a wrong account leaves the invite pending.
  if (invite.emailKey !== identity.key)
    throw new SignInError("wrong_account", { email: identity.email });
  const early = inviteState(invite);
  if (early) throw new SignInError(early);

  // A tenant without a registry entry (other than the default) counts as
  // disabled, the simplest safe reading.
  const tenant = await store.tenantRegistry.findOne({ _id: invite.tenantId });
  if (
    tenant?.status === "disabled" ||
    (!tenant && invite.tenantId !== DEFAULT_TENANT_ID)
  )
    throw new SignInError("tenant_disabled");

  let user = await store.users.findOne({ googleSub: identity.sub });
  if (!user) {
    // Compare subs: a parallel accept by the same Google account may have
    // created the user between the two lookups, and that isn't a conflict.
    const byEmail = await store.users.findOne({ emailKey: identity.key });
    if (byEmail && byEmail.googleSub !== identity.sub)
      throw new SignInError("account_conflict");
    user = byEmail;
  }
  if (user?.status === "disabled") throw new SignInError("account_disabled");
  const userId = user?._id ?? `u_${randomUUID()}`;

  // The atomic claim: only one of two parallel accepts matches.
  const now = new Date();
  const claimed = await store.invites.findOneAndUpdate(
    { _id: invite._id, status: "pending", expiresAt: { $gt: now } },
    {
      $set: {
        status: "accepted",
        acceptedAt: now.toISOString(),
        acceptedBy: userId,
      },
    },
  );
  if (!claimed) {
    const latest = await store.invites.findOne({ _id: invite._id });
    throw new SignInError((latest && inviteState(latest)) || "invite_used");
  }

  try {
    user = await finishAccept(store, invite, identity, user, userId, now);
    // The name typed on the invite page replaces Google's, new user or not.
    if (displayName) {
      await store.users.updateOne({ _id: user._id }, { $set: { name: displayName } });
      user = { ...user, name: displayName };
    }
  } catch (error) {
    // Anything failing after the claim hands the invite back, so the person
    // isn't locked out with a spent link. Matching acceptedBy keeps a
    // parallel winner's claim intact.
    await store.invites
      .updateOne(
        { _id: invite._id, status: "accepted", acceptedBy: userId },
        { $set: { status: "pending" }, $unset: { acceptedAt: "", acceptedBy: "" } },
      )
      .catch((revertError) =>
        log("error", "Could not release a claimed invite", {
          inviteId: invite._id,
          ...errorFields(revertError),
        }),
      );
    throw error;
  }
  return { user, tenantId: invite.tenantId, picker: false };
}

async function finishAccept(
  store: Store,
  invite: InviteDocument,
  identity: Identity,
  existing: UserDocument | null,
  userId: string,
  now: Date,
) {
  let user = existing;
  if (!user) {
    const created: UserDocument = {
      _id: userId,
      googleSub: identity.sub,
      email: identity.email,
      emailKey: identity.key,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.picture ? { picture: identity.picture } : {}),
      status: "active",
      createdAt: now.toISOString(),
    };
    try {
      await store.users.insertOne(created);
      user = created;
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      // Lost a race to the same Google account (two different invites).
      user = await store.users.findOne({ googleSub: identity.sub });
      if (!user) throw new SignInError("account_conflict");
    }
  }

  // Reactivates a removed membership with the invite's role.
  await store.memberships.updateOne(
    { userId: user._id, tenantId: invite.tenantId },
    {
      $set: { role: invite.role, status: "active", inviteId: invite._id },
      $setOnInsert: { _id: randomUUID(), createdAt: now.toISOString() },
    },
    { upsert: true },
  );
  return user;
}

async function signIn(store: Store, sub: string) {
  // Never accepts pending invites; only the invite link does.
  const user = await store.users.findOne({ googleSub: sub });
  if (!user) throw new SignInError("not_invited");
  if (user.status === "disabled") throw new SignInError("account_disabled");
  const tenants = await userTenants(store, user._id);
  if (!tenants.length) {
    const active = await store.memberships.countDocuments({
      userId: user._id,
      status: "active",
    });
    throw new SignInError(active ? "tenant_disabled" : "no_tenant");
  }
  // Several tenants: bind the first and let the picker switch.
  return { user, tenantId: tenants[0].id, picker: tenants.length > 1 };
}
