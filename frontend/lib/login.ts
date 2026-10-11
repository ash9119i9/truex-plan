// What the sign-in page says, and where "Continue with Google" goes.

/** The platform starts the Google flow and sets the flow cookie. */
export const GOOGLE_START = "/auth/google/start";

export interface LoginNotice {
  tone: "warn" | "info";
  lead: string;
  rest?: string;
}

// Codes the platform puts in /login?error=... after a sign-in attempt, plus the
// ones the app raises itself. Unknown codes get the generic message, so a new
// server code never shows as raw text or as nothing at all.
const NOTICES: Record<string, LoginNotice> = {
  session_expired: {
    tone: "warn",
    lead: "That sign-in expired or was started in another tab.",
    rest: "Start again and finish in this tab.",
  },
  google_failed: {
    tone: "warn",
    lead: "Google sign-in didn't finish.",
    rest: "It may have been cancelled. Try again.",
  },
  email_unverified: {
    tone: "warn",
    lead: "Google couldn't confirm your email address.",
    rest: "Use a Google account with a verified email.",
  },
  not_invited: {
    tone: "warn",
    lead: "This Google account isn't part of a workspace yet.",
    rest: "Ask your administrator to invite you, then open the invitation link.",
  },
  no_tenant: {
    tone: "warn",
    lead: "Your account isn't a member of any workspace.",
    rest: "Ask your administrator to invite you.",
  },
  account_conflict: {
    tone: "warn",
    lead: "This email address is linked to a different Google account.",
    rest: "Sign in with the Google account you used before, or contact your administrator.",
  },
  account_disabled: {
    tone: "warn",
    lead: "This account has been disabled.",
    rest: "Contact your administrator.",
  },
  access_removed: {
    tone: "warn",
    lead: "Your access to this workspace has ended.",
    rest: "Contact your administrator if you think this is a mistake.",
  },
  tenant_disabled: {
    tone: "warn",
    lead: "Your workspace is currently disabled.",
    rest: "Contact your administrator.",
  },
  demo_unavailable: {
    tone: "warn",
    lead: "The demo isn't taking new sign-ups right now.",
    rest: "Try again later.",
  },
  default_unavailable: {
    tone: "warn",
    lead: "The default workspace isn't ready for sign-in yet.",
    rest: "Contact your administrator or try again later.",
  },
  signup_limit: {
    tone: "warn",
    lead: "The demo has reached today's sign-up limit.",
    rest: "Try again tomorrow.",
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
  // access removed. Not the same as session_expired, which is a sign-in attempt
  // that took too long.
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
