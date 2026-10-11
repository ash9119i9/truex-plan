import type { Role, WorkspaceRef } from "./session";

export interface Account {
  user: { id: string; email: string; name?: string };
  tenantId: string | null;
  tenants: WorkspaceRef[];
  canCreate: boolean;
  canManageInvites?: boolean;
  showWorkspaces?: boolean;
}
export interface WorkspaceInvite {
  id: string;
  email: string;
  role: Role;
  status: "pending" | "expired" | "accepted" | "revoked";
  expiresAt: string;
  sentAt?: string;
  sendError?: string;
}
export type WorkspaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; signedOut: boolean; retryable: boolean; message: string };
const OUTAGE = "Workspace services are temporarily unavailable. Try again.";
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL: "Enter a valid email address for a Google account.",
  ALREADY_MEMBER: "This person is already a member of the workspace.",
  ALREADY_INVITED: "This address already has an invitation. Resend it below.",
  INVITE_CLOSED: "This invitation is no longer pending. Refresh the list.",
  SELF_SERVICE_DISABLED:
    "Invitation management is unavailable in this deployment.",
  TENANT_DISABLED: "That workspace is currently disabled.",
  TENANT_NOT_READY: "That workspace is still being set up. Try again shortly.",
  PERSONAL_WORKSPACE:
    "Only team workspaces support invitations. Contact your administrator.",
  NOT_A_MEMBER: "You no longer have permission to manage this workspace.",
  RATE_LIMITED: "Too many requests. Wait a minute, then try again.",
};

export function parseWorkspace(value: unknown): WorkspaceRef | null {
  const t = value as Partial<WorkspaceRef> | null;
  if (
    !t ||
    typeof t.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(t.id) ||
    typeof t.name !== "string" ||
    !t.name ||
    t.name.length > 200 ||
    (t.role !== "admin" && t.role !== "user")
  )
    return null;
  return {
    id: t.id,
    name: t.name,
    role: t.role,
    ...(t.kind === "personal" || t.kind === "team" ? { kind: t.kind } : {}),
  };
}
export function parseAccount(value: unknown): Account | null {
  const d = value as Account | null;
  if (
    !d ||
    typeof d.user?.id !== "string" ||
    !d.user.id ||
    typeof d.user.email !== "string" ||
    !d.user.email ||
    (d.tenantId !== null && typeof d.tenantId !== "string") ||
    typeof d.canCreate !== "boolean" ||
    !Array.isArray(d.tenants)
  )
    return null;
  const tenants = d.tenants.map(parseWorkspace);
  if (tenants.some((t) => !t)) return null;
  if (
    d.canManageInvites !== undefined &&
    typeof d.canManageInvites !== "boolean"
  )
    return null;
  if (d.showWorkspaces !== undefined && typeof d.showWorkspaces !== "boolean")
    return null;
  return {
    user: {
      id: d.user.id,
      email: d.user.email,
      ...(typeof d.user.name === "string" ? { name: d.user.name } : {}),
    },
    tenantId: d.tenantId,
    tenants: tenants as WorkspaceRef[],
    canCreate: d.canCreate,
    ...(d.canManageInvites !== undefined
      ? { canManageInvites: d.canManageInvites }
      : {}),
    ...(d.showWorkspaces !== undefined
      ? { showWorkspaces: d.showWorkspaces }
      : {}),
  };
}
function parseInvite(value: unknown): WorkspaceInvite | null {
  const i = value as WorkspaceInvite | null;
  if (
    !i ||
    typeof i.id !== "string" ||
    !/^inv_[0-9a-f-]{36}$/.test(i.id) ||
    typeof i.email !== "string" ||
    (i.role !== "admin" && i.role !== "user") ||
    !["pending", "expired", "accepted", "revoked"].includes(i.status) ||
    typeof i.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(i.expiresAt))
  )
    return null;
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    status: i.status,
    expiresAt: i.expiresAt,
    ...(typeof i.sentAt === "string" ? { sentAt: i.sentAt } : {}),
    ...(typeof i.sendError === "string"
      ? {
          sendError:
            "Invitation email could not be sent. Resend it or contact your administrator.",
        }
      : {}),
  };
}
async function request<T>(
  path: string,
  method: string,
  body: unknown,
  parse: (value: any) => T | null,
  fetchImpl: typeof fetch,
): Promise<WorkspaceResult<T>> {
  try {
    const res = await fetchImpl(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    if (
      res.status === 401 ||
      (res.status === 403 &&
        (
          await res
            .clone()
            .json()
            .catch(() => null)
        )?.code === "WRONG_APP")
    )
      return {
        ok: false,
        signedOut: true,
        retryable: false,
        message: "Your session has ended. Sign in again.",
      };
    const data = await res.json().catch(() => null);
    if (res.ok) {
      const value = parse(data);
      if (value !== null) return { ok: true, value };
    }
    return {
      ok: false,
      signedOut: false,
      retryable: res.ok || res.status >= 500 || res.status === 429,
      message:
        typeof data?.code === "string" && Object.hasOwn(MESSAGES, data.code)
          ? MESSAGES[data.code]
          : res.status === 403
            ? "You don't have permission to manage this workspace."
            : OUTAGE,
    };
  } catch {
    return { ok: false, signedOut: false, retryable: true, message: OUTAGE };
  }
}
export const fetchAccount = (fetchImpl: typeof fetch = fetch) =>
  request("/auth/account", "GET", undefined, parseAccount, fetchImpl);
export const fetchWorkspaceInvites = (
  id: string,
  fetchImpl: typeof fetch = fetch,
) =>
  request(
    `/auth/workspaces/${encodeURIComponent(id)}/invites`,
    "GET",
    undefined,
    (d): WorkspaceInvite[] | null => {
      if (!Array.isArray(d?.invites)) return null;
      const invites = d.invites.map(parseInvite);
      return invites.some((i: WorkspaceInvite | null) => !i) ? null : invites;
    },
    fetchImpl,
  );
export const sendWorkspaceInvite = (
  id: string,
  email: string,
  role: Role,
  fetchImpl: typeof fetch = fetch,
) =>
  request(
    `/auth/workspaces/${encodeURIComponent(id)}/invites`,
    "POST",
    { email, role },
    (d) => parseInvite(d?.invite),
    fetchImpl,
  );
export const changeWorkspaceInvite = (
  id: string,
  inviteId: string,
  action: "resend" | "revoke",
  fetchImpl: typeof fetch = fetch,
) =>
  request(
    `/auth/workspaces/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}${action === "resend" ? "/resend" : ""}`,
    action === "resend" ? "POST" : "DELETE",
    undefined,
    (d) => parseInvite(d?.invite),
    fetchImpl,
  );
