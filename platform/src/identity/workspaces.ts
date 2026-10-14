import { Router, type Request } from "express";
import type { Store } from "../persistence/store";
import { accountSession, userTenants } from "./auth";
import { tenantId } from "../tenancy/tenant";
import { ApiError } from "../core/errors";
import { route } from "../http/handlers";
import { auditAfter } from "../tenancy/audit";
import {
  createInvite,
  listInvites,
  resendInvite,
  revokeInvite,
  inviteView,
  type InviteMailer,
} from "./invites";

/** Customer-facing delivery errors must not expose provider details. */
export const workspaceInviteView = (invite: ReturnType<typeof inviteView>) => ({
  ...invite,
  ...(invite.sendError
    ? {
        sendError:
          "Invitation email could not be sent. Resend it or contact your administrator.",
      }
    : {}),
});
export function workspaceRoutes(
  store: Store,
  mailer: InviteMailer,
  enabled: boolean,
  defaultTenantId: string,
) {
  const router = Router();
  const available = () => {
    if (!enabled)
      throw new ApiError(
        403,
        "Workspace invitation management is unavailable in this deployment",
        "SELF_SERVICE_DISABLED",
      );
  };
  router.get(
    "/account",
    route(async (req, res) => {
      const { session, user } = await accountSession(store, req);
      res.json({
        user: { id: user._id, email: user.email, name: user.name },
        tenantId: session.tenantId,
        tenants: await userTenants(store, user._id),
        canCreate: false,
        canManageInvites: enabled,
        showWorkspaces: session.tenantId !== defaultTenantId,
        pendingWorkspaces: [],
      });
    }),
  );
  router.post(
    "/workspaces",
    route(async (req, res) => {
      await accountSession(store, req);
      throw new ApiError(
        403,
        "Only the platform operator can create workspaces",
        "TENANT_CREATION_OPERATOR_ONLY",
      );
    }),
  );
  const adminWorkspace = async (req: Request) => {
    const { user } = await accountSession(store, req);
    available();
    const id = tenantId(req.params.id);
    const membership = await store.memberships.findOne({
      userId: user._id,
      tenantId: id,
      status: "active",
      role: "admin",
    });
    if (!membership)
      throw new ApiError(
        403,
        "Only a workspace admin can manage invitations",
        "NOT_A_MEMBER",
      );
    await store.resolveTenant(id, { fresh: true });
    const tenant = await store.tenantRegistry.findOne({ _id: id });
    if (!tenant || tenant.kind === "personal")
      throw new ApiError(
        403,
        "Only team workspaces support invitations",
        "PERSONAL_WORKSPACE",
      );
    return { user, tenant };
  };
  router.get(
    "/workspaces/:id/invites",
    route(async (req, res) => {
      const { tenant } = await adminWorkspace(req);
      res.json({
        invites: (await listInvites(store, tenant._id)).map(
          workspaceInviteView,
        ),
      });
    }),
  );
  router.post(
    "/workspaces/:id/invites",
    route(async (req, res) => {
      const { user, tenant } = await adminWorkspace(req);
      const invite = await createInvite(store, mailer, {
        tenant,
        email: req.body?.email,
        role: req.body?.role,
      });
      await auditAfter(store, {
        actor: user._id,
        actorRole: "admin",
        action: "invite.create",
        tenantId: tenant._id,
        target: { type: "invite", id: invite.id },
        requestId: res.locals.requestId,
        detail: { role: invite.role },
      });
      res.status(201).json({ invite: workspaceInviteView(invite) });
    }),
  );
  router.post(
    "/workspaces/:id/invites/:inviteId/resend",
    route(async (req, res) => {
      const { user, tenant } = await adminWorkspace(req);
      const invite = await resendInvite(
        store,
        mailer,
        tenant,
        String(req.params.inviteId),
      );
      await auditAfter(store, {
        actor: user._id,
        actorRole: "admin",
        action: "invite.resend",
        tenantId: tenant._id,
        target: { type: "invite", id: invite.id },
        requestId: res.locals.requestId,
      });
      res.json({ invite: workspaceInviteView(invite) });
    }),
  );
  router.delete(
    "/workspaces/:id/invites/:inviteId",
    route(async (req, res) => {
      const { user, tenant } = await adminWorkspace(req);
      const invite = await revokeInvite(
        store,
        tenant._id,
        String(req.params.inviteId),
      );
      await auditAfter(store, {
        actor: user._id,
        actorRole: "admin",
        action: "invite.revoke",
        tenantId: tenant._id,
        target: { type: "invite", id: invite.id },
        requestId: res.locals.requestId,
      });
      res.json({ invite: workspaceInviteView(invite) });
    }),
  );
  return router;
}
