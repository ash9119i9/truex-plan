// The signed-in person, as the platform says they are (GET /api/me), and the
// few session actions the app needs: sign out and switch workspace. The server
// is the only authority; nothing here is trusted by anything but the screen.

export type Role = "user" | "admin";
export interface WorkspaceRef {
  id: string;
  name: string;
  role: Role;
  kind?: "personal" | "team";
}
export interface Me {
  user: { id: string; email: string; name?: string };
  tenant: { id: string; name: string; isUserSpecific?: boolean };
  role: Role;
  tenants: WorkspaceRef[];
  /** "google" has a session to end; the dev and POC modes do not. */
  auth: "google" | "dev" | "poc";
  selfService?: boolean;
  /** Presentation only; membership checks still control access. */
  showWorkspaces?: boolean;
}
export const meKey = (me: Me) => `${me.user.id}:${me.tenant.id}`;

export type MeResult =
  | { kind: "ok"; me: Me }
  /** No valid session: show sign-in. */
  | { kind: "signedOut" }
  | { kind: "onboarding" }
  /** Signed in, but this workspace cannot be used right now. */
  | { kind: "blocked"; code: string; message: string }
  /** The platform could not be asked. Not the same as signed out. */
  | { kind: "unavailable"; message: string };

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;

export function parseMe(data: unknown): Me | null {
  const d = data as Record<string, any> | null;
  if (!d || typeof d !== "object") return null;
  const id = text(d.user?.id, 128),
    email = text(d.user?.email, 320),
    tenantId = text(d.tenant?.id, 64),
    tenantName = text(d.tenant?.name, 200) ?? tenantId;
  if (!id || !email || !tenantId || !tenantName) return null;
  if (d.role !== "user" && d.role !== "admin") return null;
  const tenants: WorkspaceRef[] = [];
  for (const t of Array.isArray(d.tenants) ? d.tenants.slice(0, 200) : []) {
    const tid = text(t?.id, 64);
    if (!tid || (t.role !== "user" && t.role !== "admin")) continue;
    tenants.push({
      id: tid,
      name: text(t.name, 200) ?? tid,
      role: t.role,
      ...(t.kind === "personal" || t.kind === "team" ? { kind: t.kind } : {}),
    });
  }
  const name = text(d.user?.name, 200);
  return {
    user: { id, email, ...(name ? { name } : {}) },
    tenant: {
      id: tenantId,
      name: tenantName,
      ...(typeof d.tenant?.isUserSpecific === "boolean"
        ? { isUserSpecific: d.tenant.isUserSpecific }
        : {}),
    },
    role: d.role,
    tenants,
    auth: d.auth === "google" || d.auth === "poc" ? d.auth : "dev",
    ...(typeof d.selfService === "boolean"
      ? { selfService: d.selfService }
      : {}),
    ...(typeof d.showWorkspaces === "boolean"
      ? { showWorkspaces: d.showWorkspaces }
      : {}),
  };
}

const OUTAGE =
  "Truex is temporarily unavailable. Your session is not affected. Try again in a moment.";

/**
 * Asks the platform who this is. Only a real 401 means signed out: a timeout,
 * a dropped connection or a 5xx is an outage and must not look like a logout.
 */
export async function fetchMe(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<MeResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/me", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "unavailable", message: OUTAGE };
  }
  if (res.status === 401) return { kind: "signedOut" };
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* Handled below by status. */
  }
  if (res.ok) {
    const me = parseMe(data);
    return me ? { kind: "ok", me } : { kind: "unavailable", message: OUTAGE };
  }
  const code = typeof data?.code === "string" ? data.code : "";
  if (res.status === 409 && code === "ONBOARDING_REQUIRED")
    return { kind: "onboarding" };
  // An admin-console cookie on the main app is not a session for it.
  if (res.status === 403 && code === "WRONG_APP") return { kind: "signedOut" };
  if (res.status === 403)
    return {
      kind: "blocked",
      code,
      message:
        code === "TENANT_DISABLED"
          ? "Your workspace is currently disabled. Contact your administrator."
          : "You don't have access to this workspace. Contact your administrator.",
    };
  return { kind: "unavailable", message: OUTAGE };
}

const post = (fetchImpl: typeof fetch, path: string, body?: unknown) =>
  fetchImpl(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

/**
 * Ends this browser's session on the server. `confirmed` is false when the
 * server could not be reached or refused: the caller clears what is on screen
 * either way, but must not tell the person they are signed out.
 */
export async function signOut(
  fetchImpl: typeof fetch = fetch,
): Promise<{ confirmed: boolean }> {
  try {
    const res = await post(fetchImpl, "/auth/logout");
    // 401: there was no session to end, which is the same outcome.
    return { confirmed: res.ok || res.status === 401 };
  } catch {
    return { confirmed: false };
  }
}

export type SwitchResult =
  { ok: true } | { ok: false; signedOut: boolean; message: string };
export async function switchWorkspace(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SwitchResult> {
  let res: Response;
  try {
    res = await post(fetchImpl, "/auth/switch-tenant", { tenantId });
  } catch {
    return { ok: false, signedOut: false, message: OUTAGE };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401)
    return {
      ok: false,
      signedOut: true,
      message: "Your session has ended. Sign in again.",
    };
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* Generic message below. */
  }
  const message =
    res.status === 403
      ? data?.code === "TENANT_DISABLED"
        ? "That workspace is currently disabled."
        : "You're not a member of that workspace."
      : res.status >= 500
        ? OUTAGE
        : "Couldn't switch workspace. Try again.";
  return { ok: false, signedOut: false, message };
}

export type TenantsResult =
  | { kind: "ok"; tenants: WorkspaceRef[] }
  | { kind: "signedOut" }
  | { kind: "unavailable"; message: string };
export async function fetchTenants(
  fetchImpl: typeof fetch = fetch,
): Promise<TenantsResult> {
  try {
    const res = await fetchImpl("/auth/tenants", {
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { kind: "signedOut" };
    if (!res.ok) return { kind: "unavailable", message: OUTAGE };
    const data = await res.json();
    const tenants = (Array.isArray(data?.tenants) ? data.tenants : [])
      .map((t: any): WorkspaceRef | null => {
        const id = text(t?.id, 64);
        return id && (t.role === "user" || t.role === "admin")
          ? {
              id,
              name: text(t.name, 200) ?? id,
              role: t.role,
              ...(t.kind === "personal" || t.kind === "team"
                ? { kind: t.kind }
                : {}),
            }
          : null;
      })
      .filter((t: WorkspaceRef | null): t is WorkspaceRef => !!t);
    return { kind: "ok", tenants };
  } catch {
    return { kind: "unavailable", message: OUTAGE };
  }
}

// Messages other tabs act on. They carry no credentials and no private data;
// the server session is what is authoritative, and a tab that hears one simply
// asks again.
export type TabMessage = { type: "logout" | "switch" | "login"; key?: string };
export function openTabChannel(onMessage: (m: TabMessage) => void) {
  if (typeof BroadcastChannel === "undefined") return { post() {}, close() {} };
  const channel = new BroadcastChannel("truex-session");
  channel.onmessage = (e) => {
    const m = e.data as TabMessage | null;
    if (m && (m.type === "logout" || m.type === "switch" || m.type === "login"))
      onMessage(m);
  };
  return {
    post: (m: TabMessage) => channel.postMessage(m),
    close: () => channel.close(),
  };
}
