import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { appendCookie, readSingleCookie } from "../../common/http/cookies";
import type { AuthConfig } from "../../config/auth-config";

// One Google sign-in attempt, kept in a short-lived HttpOnly cookie rather
// than the database: starting sign-in writes nothing server-side, and the
// attempt is bound to the browser that started it (login CSRF protection).
// The cookie needs no signature: its values only matter to the browser that
// holds it, Google redeems each code once, and the __Host- prefix stops other
// hosts from planting one.

const SECURE_NAME = "__Host-truex_oauth";
const LOCAL_NAME = "truex_oauth";
export const OAUTH_FLOW_TTL_SECONDS = 10 * 60;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface OAuthFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
  startedAt: number; // Unix seconds
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

export function newOAuthFlow(now: Date = new Date()): OAuthFlow {
  return {
    state: secret(),
    nonce: secret(),
    codeVerifier: secret(),
    startedAt: Math.floor(now.getTime() / 1000),
  };
}

// PKCE S256 (RFC 7636).
export function codeChallengeOf(flow: OAuthFlow): string {
  return createHash("sha256").update(flow.codeVerifier).digest("base64url");
}

function cookieName(auth: AuthConfig): string {
  return auth.cookieSecure ? SECURE_NAME : LOCAL_NAME;
}

// SameSite=Lax: Google returns the browser with a cross-site top-level GET,
// which Strict cookies would not accompany.
export function setOAuthFlowCookie(
  res: Response,
  auth: AuthConfig,
  flow: OAuthFlow,
): void {
  appendCookie(
    res,
    cookieName(auth),
    [flow.startedAt, flow.state, flow.nonce, flow.codeVerifier].join("."),
    {
      maxAgeSeconds: OAUTH_FLOW_TTL_SECONDS,
      sameSite: "Lax",
      secure: auth.cookieSecure,
    },
  );
}

export function clearOAuthFlowCookie(res: Response, auth: AuthConfig): void {
  appendCookie(res, cookieName(auth), "", {
    maxAgeSeconds: 0,
    sameSite: "Lax",
    secure: auth.cookieSecure,
  });
}

export type FlowCheck =
  | { ok: true; flow: OAuthFlow }
  | { ok: false; reason: "missing" | "mismatch" | "expired" };

// The attempt this callback belongs to: the cookie must exist, be fresh and
// carry exactly the state Google echoed back.
export function checkOAuthFlow(
  req: Request,
  auth: AuthConfig,
  returnedState: unknown,
  now: Date = new Date(),
): FlowCheck {
  const value = readSingleCookie(req, cookieName(auth));
  const parts = value?.split(".");
  if (!parts || parts.length !== 4) return { ok: false, reason: "missing" };
  const [startedText, state, nonce, codeVerifier] = parts as [
    string,
    string,
    string,
    string,
  ];
  const startedAt = Number(startedText);
  if (
    !/^\d{1,12}$/.test(startedText) ||
    !SECRET.test(state) ||
    !SECRET.test(nonce) ||
    !SECRET.test(codeVerifier)
  )
    return { ok: false, reason: "missing" };
  // The format check first: it also guarantees equal byte lengths, which
  // timingSafeEqual requires.
  if (
    typeof returnedState !== "string" ||
    !SECRET.test(returnedState) ||
    !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))
  )
    return { ok: false, reason: "mismatch" };
  const age = Math.floor(now.getTime() / 1000) - startedAt;
  if (age < 0 || age > OAUTH_FLOW_TTL_SECONDS)
    return { ok: false, reason: "expired" };
  return { ok: true, flow: { state, nonce, codeVerifier, startedAt } };
}
