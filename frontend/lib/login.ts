// What the sign-in page says, and where "Continue with Google" goes.

import { AUTH_PATHS } from "./auth.ts";

/** The platform starts the Google flow and sets the flow cookie. */
export const GOOGLE_START = AUTH_PATHS.google;

export interface LoginNotice {
  tone: "warn" | "info";
  lead: string;
  rest?: string;
}

// Codes the platform puts in /login?error=... after a sign-in attempt, plus the
// ones the app raises itself. Unknown codes get the generic message, so a new
// server code never shows as raw text or as nothing at all.
const NOTICES: Record<string, LoginNotice> = {
  cancelled: {
    tone: "warn",
    lead: "Google sign-in was cancelled.",
    rest: "Try again when you're ready.",
  },
  expired: {
    tone: "warn",
    lead: "That sign-in expired or was started in another tab.",
    rest: "Start again and finish in this tab.",
  },
  rejected: {
    tone: "warn",
    lead: "Google sign-in didn't finish.",
    rest: "Try again.",
  },
  account_disabled: {
    tone: "warn",
    lead: "This account has been disabled.",
    rest: "Contact your administrator.",
  },
  email_in_use: {
    tone: "warn",
    lead: "This email address is linked to a different Google account.",
    rest: "Sign in with the Google account you used before, or contact your administrator.",
  },
  signup_unavailable: {
    tone: "warn",
    lead: "Truex isn't taking new sign-ups right now.",
    rest: "Contact your administrator or try again later.",
  },
  unavailable: {
    tone: "warn",
    lead: "Truex is temporarily unavailable.",
    rest: "Your account is fine. Try again in a minute.",
  },
  logout_failed: {
    tone: "warn",
    lead: "We couldn't confirm that you were signed out.",
    rest: "Your session may still be active. Try signing out again, and close this browser if you're on a shared computer.",
  },
  signed_out: {
    tone: "info",
    lead: "You're signed out of Truex.",
    rest: "You're still signed in to Google.",
  },
  // The session ended somewhere else: signed out in another tab, expired, or
  // access removed. Not the same as expired, which is a sign-in attempt that
  // took too long.
  session_ended: {
    tone: "info",
    lead: "Your session has ended.",
    rest: "Sign in again to continue.",
  },
};
const GENERIC: LoginNotice = {
  tone: "warn",
  lead: "Sign-in didn't finish.",
  rest: "Try again.",
};

export function loginNotice(
  code: string | null | undefined,
): LoginNotice | null {
  if (!code) return null;
  return Object.hasOwn(NOTICES, code) ? NOTICES[code] : GENERIC;
}
