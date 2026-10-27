import type { Request, Response } from "express";
import { appendCookie, readSingleCookie } from "../../common/http/cookies";
import type { AuthConfig } from "../../config/auth-config";

// The refresh credential travels only in this HttpOnly cookie. Over https the
// __Host- prefix makes the browser refuse it unless it is Secure, host-only
// and Path=/, so no subdomain can plant or overwrite it.
const SECURE_NAME = "__Host-truex_refresh";
// Plain http on localhost cannot use the prefix.
const LOCAL_NAME = "truex_refresh";

export function refreshCookieName(auth: AuthConfig): string {
  return auth.cookieSecure ? SECURE_NAME : LOCAL_NAME;
}

function write(res: Response, auth: AuthConfig, value: string, maxAge: number) {
  appendCookie(res, refreshCookieName(auth), value, {
    maxAgeSeconds: maxAge,
    sameSite: "Strict",
    secure: auth.cookieSecure,
  });
}

export function setRefreshCookie(
  res: Response,
  auth: AuthConfig,
  credential: string,
  expiresAt: Date,
): void {
  write(res, auth, credential, (expiresAt.getTime() - Date.now()) / 1000);
}

export function clearRefreshCookie(res: Response, auth: AuthConfig): void {
  write(res, auth, "", 0);
}

export function readRefreshCookie(
  req: Request,
  auth: AuthConfig,
): string | undefined {
  return readSingleCookie(req, refreshCookieName(auth));
}
