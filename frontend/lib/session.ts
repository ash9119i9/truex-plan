// The signed-in person and the tenant this tab opens, as platform-next says
// they are (GET /api/v1/me and /api/v1/me/tenants), plus sign-out. The server
// is the only authority; nothing here is trusted by anything but the screen.

import { auth as defaultAuth, type Auth, type Authorized } from "./auth.ts";

export type Role = "user" | "admin";
export interface WorkspaceRef {
  id: string;
  name: string;
  role: Role;
}
export interface Me {
  user: { id: string; email: string; name: string; picture?: string };
  /** The tenant this tab is showing, and the person's role in it. */
  tenant: { id: string; name: string };
  role: Role;
  tenants: WorkspaceRef[];
  /** The tenant's goal budgets for a new chat; null when goals are off. */
  goals: GoalSettings | null;
  /** Sessions always come from Google sign-in and can be ended. */
  auth: "google";
}

export interface GoalSettings {
  /** Three budgets a member chooses from. */
  presets: [number, number, number];
  /** The most any goal in a new chat can be raised to. */
  maxTokenBudget: number;
}

const budget = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// Anything malformed reads as goals off.
function parseGoalSettings(value: unknown): GoalSettings | null {
  const g = value as { presets?: unknown; maxTokenBudget?: unknown } | null;
  if (!g || typeof g !== "object") return null;
  const { presets, maxTokenBudget } = g;
  if (
    !Array.isArray(presets) ||
    presets.length !== 3 ||
    !presets.every(budget) ||
    !budget(maxTokenBudget)
  )
    return null;
  return {
    presets: [presets[0], presets[1], presets[2]],
    maxTokenBudget,
  };
}
export const meKey = (me: Me) => `${me.user.id}:${me.tenant.id}`;

export type MeResult =
  | { kind: "ok"; me: Me }
  /** No valid session: show sign-in. */
  | { kind: "signedOut" }
  /** Signed in, but no tenant can be opened right now. */
  | { kind: "blocked"; code: string; message: string }
  /** The platform could not be asked. Not the same as signed out. */
  | { kind: "unavailable"; message: string };

const WIRE_ID = /^[0-9a-f]{24}$/;
const OUTAGE =
  "Truex is temporarily unavailable. Your session is not affected. Try again in a moment.";

// The platform lists at most 500 memberships.
const MAX_TENANTS = 500;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;

function parseUser(data: unknown): Me["user"] | null {
  const u = (data as { user?: Record<string, unknown> } | null)?.user;
  const id = text(u?.id, 24),
    email = text(u?.email, 320),
    name = typeof u?.name === "string" && u.name.length <= 200 ? u.name : null,
    picture = text(u?.picture, 2048);
  if (!id || !WIRE_ID.test(id) || !email || name === null) return null;
  return { id, email, name: name || email, ...(picture ? { picture } : {}) };
}

type Entry =
  | { outcome: "enterTenant"; tenantId: string }
  | { outcome: "chooseTenant" }
  | { outcome: "noTenant" };

function parseTenants(
  data: unknown,
): { entry: Entry; tenants: WorkspaceRef[] } | null {
  const d = data as Record<string, any> | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.tenants)) return null;
  const tenants: WorkspaceRef[] = [];
  // A bad entry in the list is dropped, not fatal.
  for (const t of d.tenants.slice(0, MAX_TENANTS)) {
    const id = text(t?.id, 24);
    if (!id || !WIRE_ID.test(id) || (t.role !== "user" && t.role !== "admin"))
      continue;
    tenants.push({ id, name: text(t.name, 200) ?? id, role: t.role });
  }
  const outcome = d.entry?.outcome;
  if (outcome === "chooseTenant" || outcome === "noTenant")
    return { entry: { outcome }, tenants };
  const tenantId = text(d.entry?.tenantId, 24);
  if (outcome === "enterTenant" && tenantId && WIRE_ID.test(tenantId))
    return { entry: { outcome, tenantId }, tenants };
  return null;
}

/** Joins the two account answers into the tab's identity, or says why not. */
export function toMe(meBody: unknown, tenantsBody: unknown): MeResult {
  const user = parseUser(meBody);
  const listed = parseTenants(tenantsBody);
  if (!user || !listed) return { kind: "unavailable", message: OUTAGE };
  const { entry, tenants } = listed;
  if (entry.outcome === "noTenant")
    return {
      kind: "blocked",
      code: "NO_TENANT",
      message:
        "Your account isn't a member of any workspace. Contact your administrator.",
    };
  // Choosing between workspaces is on hold; nobody has several yet.
  if (entry.outcome === "chooseTenant")
    return {
      kind: "blocked",
      code: "CHOOSE_TENANT",
      message:
        "Your account belongs to several workspaces, and choosing between them isn't available yet. Contact your administrator.",
    };
  const tenant = tenants.find((t) => t.id === entry.tenantId);
  if (!tenant) return { kind: "unavailable", message: OUTAGE };
  return {
    kind: "ok",
    me: {
      user,
      tenant: { id: tenant.id, name: tenant.name },
      role: tenant.role,
      tenants,
      // The account listing carries no settings; a tenant route reads them.
      goals: null,
      auth: "google",
    },
  };
}

/**
 * Asks the platform who this is. Only a 401 that survives a token refresh
 * means signed out: a timeout, a dropped connection or a 5xx is an outage and
 * must not look like a logout.
 */
export async function fetchMe(
  options: { auth?: Auth; timeoutMs?: number; tenantId?: string } = {},
): Promise<MeResult> {
  const { tenantId } = options;
  if (tenantId !== undefined && !WIRE_ID.test(tenantId))
    return {
      kind: "blocked",
      code: "INVALID_TENANT",
      message: "This workspace address is invalid.",
    };
  const session = options.auth ?? defaultAuth;
  const get = (path: string): Promise<Authorized> =>
    session.request(path, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  let answers: Authorized[];
  try {
    // The tenant's request is sent first, so the token it refreshes is for
    // that tenant and /me shares the same refresh.
    const tenantAnswer = get(
      tenantId === undefined
        ? "/api/v1/me/tenants"
        : `/api/v1/tenant?tenantId=${tenantId}`,
    );
    answers = await Promise.all([get("/api/v1/me"), tenantAnswer]);
  } catch {
    return { kind: "unavailable", message: OUTAGE };
  }
  if (
    answers.some(
      (answer) =>
        answer.kind === "signedOut" ||
        (answer.kind === "response" && answer.response.status === 401),
    )
  )
    return { kind: "signedOut" };
  const tenantAnswer = answers[1];
  if (
    tenantId !== undefined &&
    tenantAnswer?.kind === "response" &&
    tenantAnswer.response.status === 403
  )
    return {
      kind: "blocked",
      code: "TENANT_ACCESS_DENIED",
      message:
        "You no longer have access to this workspace. Contact your administrator or sign in with another account.",
    };
  const bodies: unknown[] = [];
  for (const answer of answers) {
    if (answer.kind === "signedOut") return { kind: "signedOut" };
    if (answer.kind === "unavailable")
      return { kind: "unavailable", message: OUTAGE };
    if (answer.response.status === 401) return { kind: "signedOut" };
    if (!answer.response.ok) return { kind: "unavailable", message: OUTAGE };
    bodies.push(await answer.response.json().catch(() => null));
  }
  if (tenantId === undefined) return toMe(bodies[0], bodies[1]);
  const user = parseUser(bodies[0]);
  const tenant = (
    bodies[1] as { tenant?: WorkspaceRef & { goals?: unknown } } | null
  )?.tenant;
  if (
    !user ||
    !tenant ||
    tenant.id !== tenantId ||
    !text(tenant.name, 200) ||
    (tenant.role !== "user" && tenant.role !== "admin")
  )
    return { kind: "unavailable", message: OUTAGE };
  return {
    kind: "ok",
    me: {
      user,
      tenant: { id: tenant.id, name: tenant.name },
      role: tenant.role,
      tenants: [{ id: tenant.id, name: tenant.name, role: tenant.role }],
      goals: parseGoalSettings(tenant.goals),
      auth: "google",
    },
  };
}

/**
 * Ends the session on the server and in every tab. `confirmed` is false when
 * the server could not be reached or refused: the caller clears what is on
 * screen either way, but must not tell the person they are signed out.
 */
export const signOut = (session: Auth = defaultAuth) => session.signOut();

// Messages other tabs act on. They carry no credentials and no private data;
// the server session is what is authoritative, and a tab that hears one simply
// asks again.
export type TabMessage = { type: "logout" | "login"; key?: string };
export function openTabChannel(onMessage: (m: TabMessage) => void) {
  if (typeof BroadcastChannel === "undefined") return { post() {}, close() {} };
  const channel = new BroadcastChannel("truex-session");
  channel.onmessage = (e) => {
    const m = e.data as TabMessage | null;
    if (m && (m.type === "logout" || m.type === "login")) onMessage(m);
  };
  return {
    post: (m: TabMessage) => channel.postMessage(m),
    close: () => channel.close(),
  };
}
