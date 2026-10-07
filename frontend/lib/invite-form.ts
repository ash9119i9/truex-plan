// Invite acceptance page (join-tenant-v3-dev-spec.html, "Form logic" and "Page states"):
// pure helpers so node tests can import them.

export type InviteStatus = "valid" | "expired" | "used" | "revoked" | "not_found";
export type InviteRole = "admin" | "user";

/** GET /auth/invites/:token (always 200). */
export interface InviteLookup {
  status: InviteStatus;
  serverNow: string;
  ttlDays: number;
  tenantName?: string;
  email?: string;
  role?: InviteRole;
  sentAt?: string;
  expiresAt?: string;
  /** Present only when signed in. */
  viewer?: { email: string; name?: string; member: boolean; memberSince?: string };
}

/** What the left pane renders once the lookup is in. */
export type InviteKind = "valid" | "joined" | "member" | "expired" | "used" | "revoked" | "not_found";

export const NAME_MAX = 60;

// ---- Form logic, as coded in the spec ----
export const clean = (s: string) => s.trim().replace(/\s+/g, " ");
// Array.from keeps a leading astral character (emoji, rare CJK) whole instead of half a surrogate pair.
export const initials = (n: string) =>
  n.split(" ").filter(Boolean).map((w) => Array.from(w)[0]).slice(0, 2).join("").toUpperCase();
// The spec's rule plus the backend's 60-character cap (maxlength already stops typing past it).
export const isValid = (n: string) => n.length >= 2 && n.length <= NAME_MAX && /\p{L}/u.test(n);
export const firstName = (n: string) => clean(n).split(" ")[0] ?? "";

export const roleLabel = (role: InviteRole | undefined) => (role === "admin" ? "Admin" : "Member");

/** Workspace logo letter: the first character of the name, uppercased. */
export const logoInitial = (workspace: string) => (Array.from(clean(workspace))[0] ?? "?").toUpperCase();

const DAY = 86_400_000;

function toDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Sep 24". timeZone is for tests; the page uses the viewer's zone. */
export function formatDay(iso: string | undefined, timeZone?: string): string {
  const d = toDate(iso);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone }) : "";
}

/** "Aug", or "Aug 2025" when it isn't the same year as now. */
export function formatMonth(iso: string | undefined, nowIso: string, timeZone?: string): string {
  const d = toDate(iso);
  if (!d) return "";
  const now = toDate(nowIso) ?? d;
  const year = (x: Date) => x.toLocaleDateString("en-US", { year: "numeric", timeZone });
  const sameYear = year(d) === year(now);
  return d.toLocaleDateString("en-US", { month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone });
}

/**
 * Expiry pill copy from server time, so client clock skew doesn't matter.
 * Whole days left are floored, so it never promises more time than is left.
 */
export function expiryLabel(
  expiresAt: string | undefined,
  serverNow: string,
  timeZone?: string,
): { expired: boolean; text: string } | null {
  const end = toDate(expiresAt);
  const now = toDate(serverNow);
  if (!end || !now) return null;
  const left = end.getTime() - now.getTime();
  if (left <= 0) return { expired: true, text: `Expired ${formatDay(expiresAt, timeZone)}` };
  const days = Math.floor(left / DAY);
  if (days === 0) return { expired: false, text: "Expires today" };
  return { expired: false, text: `Expires in ${days} ${days === 1 ? "day" : "days"}` };
}

export const ttlCopy = (ttlDays: number) => `Invites last ${ttlDays} ${ttlDays === 1 ? "day" : "days"}.`;

export const startUrl = (token: string, name: string) =>
  `/auth/google/start?invite=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;

// ---- Lookup → page state ----
const STATUSES: readonly InviteStatus[] = ["valid", "expired", "used", "revoked", "not_found"];
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Validates the untrusted lookup body. Returns null when it isn't the contract's shape. */
export function parseLookup(body: unknown): InviteLookup | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!STATUSES.includes(b.status as InviteStatus)) return null;
  const serverNow = str(b.serverNow);
  if (!serverNow) return null;
  const ttlDays = typeof b.ttlDays === "number" && b.ttlDays > 0 ? b.ttlDays : 7;
  const out: InviteLookup = { status: b.status as InviteStatus, serverNow, ttlDays };
  const tenantName = str(b.tenantName);
  const email = str(b.email);
  const sentAt = str(b.sentAt);
  const expiresAt = str(b.expiresAt);
  if (tenantName) out.tenantName = tenantName;
  if (email) out.email = email;
  if (b.role === "admin" || b.role === "user") out.role = b.role;
  if (sentAt) out.sentAt = sentAt;
  if (expiresAt) out.expiresAt = expiresAt;
  const v = b.viewer as Record<string, unknown> | undefined;
  const viewerEmail = v && typeof v === "object" ? str(v.email) : undefined;
  if (v && viewerEmail) {
    out.viewer = { email: viewerEmail, member: v.member === true };
    const name = str(v.name);
    const memberSince = str(v.memberSince);
    if (name) out.viewer.name = name;
    if (memberSince) out.viewer.memberSince = memberSince;
  }
  return out;
}

// Google callback errors that mean the invite itself changed between load and submit.
const ERROR_KIND: Record<string, InviteKind> = {
  invite_expired: "expired",
  invite_used: "used",
  invite_revoked: "revoked",
};

/**
 * Membership wins (a used invite you redeemed is just "you're in"); then an
 * invite-state error from the callback; then the lookup status.
 */
export function inviteKind(lookup: InviteLookup, joined: boolean, error: string | null): InviteKind {
  if (lookup.viewer?.member) return joined ? "joined" : "member";
  if (error && ERROR_KIND[error]) return ERROR_KIND[error];
  return lookup.status;
}

export type Notice = { tone: "warn" | "ok"; lead: string; rest?: string };

/**
 * Banner for a ?error= code in the valid state. invite_* codes become page states,
 * invalid_name uses the name-field error, and wrong_account has its own banner.
 */
export function errorNotice(code: string | null): Notice | null {
  if (!code || code in ERROR_KIND || code === "invalid_name" || code === "wrong_account") return null;
  switch (code) {
    case "email_unverified":
      return { tone: "warn", lead: "Google couldn't confirm your email address.", rest: "Sign in with the Google account this invite was sent to, and make sure its email is verified." };
    case "tenant_disabled":
      return { tone: "warn", lead: "This workspace is currently disabled.", rest: "Contact the person who invited you." };
    case "account_disabled":
      return { tone: "warn", lead: "This account has been disabled.", rest: "Contact the person who invited you." };
    case "account_conflict":
      return { tone: "warn", lead: "This email is linked to a different Google account.", rest: "Sign in with the Google account you used before, or ask the person who invited you for help." };
    default:
      return { tone: "warn", lead: "Sign-in didn't finish.", rest: "Try joining again." };
  }
}

export const INVALID_STEP: Record<"used" | "revoked" | "not_found", string> = {
  used: "Invite already used",
  revoked: "Invite revoked",
  not_found: "Invite not found",
};

// ---- Progress checkup (spec "Progress checkup" + "Page states") ----
export type StepTone = "" | "is-on" | "is-on is-busy" | "is-done" | "is-bad";
export type Step = { tone: StepTone; glyph: string; label: string };
export type Checkup = { steps: [Step, Step, Step]; count: 0 | 1 | 2 | 3; bad: boolean };

export const STEP_LABELS = ["Invite verified", "Add your name", "Join workspace"] as const;
const TICK = "✓";
const done = (label: string): Step => ({ tone: "is-done", glyph: TICK, label });

export function checkup(kind: InviteKind, nameOk: boolean, busy: boolean): Checkup {
  const [s1, s2, s3] = STEP_LABELS;
  switch (kind) {
    case "joined":
    case "member":
      return { steps: [done(s1), done(s2), done(s3)], count: 3, bad: false };
    case "expired":
    case "used":
    case "revoked":
    case "not_found": {
      const label = kind === "expired" ? "Invite expired" : INVALID_STEP[kind];
      return {
        steps: [{ tone: "is-bad", glyph: "!", label }, { tone: "", glyph: "2", label: s2 }, { tone: "", glyph: "3", label: s3 }],
        count: 0,
        bad: true,
      };
    }
    default:
      if (busy) return { steps: [done(s1), done(s2), { tone: "is-on is-busy", glyph: "", label: s3 }], count: 2, bad: false };
      return nameOk
        ? { steps: [done(s1), done(s2), { tone: "is-on", glyph: "3", label: s3 }], count: 2, bad: false }
        : { steps: [done(s1), { tone: "is-on", glyph: "2", label: s2 }, { tone: "", glyph: "3", label: s3 }], count: 1, bad: false };
  }
}

/** Bar fill: a bad state keeps one third filled so the red is visible (spec: Math.max(n, bad ? 1 : 0)). */
export const barPercent = (c: Checkup) => (Math.max(c.count, c.bad ? 1 : 0) * 100) / 3;
