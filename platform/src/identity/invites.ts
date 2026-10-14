import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { ApiError } from "../core/errors";
import { route } from "../http/handlers";
import type { Store } from "../persistence/store";
import type { TenantDocument } from "../tenancy/tenant";
import type { UserRole } from "./user";
import {
  emailKey,
  hashToken,
  newToken,
  rateLimit,
  readSession,
  validEmail,
  type InviteDocument,
} from "./auth";
import { errorFields, log } from "../../../shared/logging";

const DAY = 86_400_000;
export const INVITE_LIFETIME_MS = 7 * DAY;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

// ---- Email ----

export interface InviteEmail {
  inviteId: string;
  tokenHash: string;
  to: string;
  tenantName: string;
  role: UserRole;
  link: string;
  expiresAt: Date;
}
/** Resolves on success; throws with a short, log-safe message on failure. */
export interface InviteMailer {
  send(email: InviteEmail): Promise<void>;
}

export const inviteLink = (
  token: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  `${(env.APP_PUBLIC_URL || env.FRONTEND_ORIGIN || "http://localhost:3000").replace(/\/+$/, "")}/invite/${token}`;

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function inviteMessage(email: InviteEmail) {
  const expires = email.expiresAt.toUTCString();
  const role = email.role === "admin" ? "an admin" : "a member";
  const name = escapeHtml(email.tenantName);
  const link = escapeHtml(email.link);
  return {
    subject: `You're invited to ${email.tenantName} on Truex`,
    text: [
      `You're invited to join ${email.tenantName} on Truex as ${role}.`,
      "",
      `Accept the invite: ${email.link}`,
      "",
      `This link works once and expires on ${expires}.`,
      "Sign in with the Google account this email was sent to.",
    ].join("\n"),
    html: [
      `<p>You're invited to join <strong>${name}</strong> on Truex as ${role}.</p>`,
      `<p><a href="${link}">Accept the invite</a></p>`,
      `<p>Or open this link: ${link}</p>`,
      `<p>This link works once and expires on ${escapeHtml(expires)}. Sign in with the Google account this email was sent to.</p>`,
    ].join("\n"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resend over plain fetch. With no RESEND_API_KEY there is no email: outside
 * production the link is logged, which is only for development; in
 * production nothing is sent and nothing secret is logged, so each invite
 * records a visible, retryable "not sent" status. Invitations then go out
 * through the operator command (`npm run tenant -- invite`). This is not a
 * startup failure: public demo signup needs no email at all.
 */
export function inviteMailer(
  env: NodeJS.ProcessEnv = process.env,
): InviteMailer {
  const key = env.RESEND_API_KEY?.trim();
  if (!key) {
    if (env.NODE_ENV === "production") {
      log(
        "warn",
        "RESEND_API_KEY is not set; invitation email is unavailable. Use `npm run tenant -- invite` to issue links.",
      );
      return {
        async send() {
          throw new Error("Invitation email is not configured");
        },
      };
    }
    log(
      "warn",
      "RESEND_API_KEY is not set; invite links are logged, not emailed",
    );
    return {
      async send(email) {
        // Dev only: the raw link is the credential, so it never goes to logs
        // in production (handled above).
        log("info", "invite link (not emailed)", {
          inviteId: email.inviteId,
          to: email.to,
          link: email.link,
        });
      },
    };
  }
  const url = `${(env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "")}/emails`;
  const from = env.INVITE_FROM_EMAIL?.trim() || "Truex <onboarding@resend.dev>";
  return {
    async send(email) {
      const message = inviteMessage(email);
      const body = JSON.stringify({ from, to: [email.to], ...message });
      // The same key on every retry, so Resend never sends twice.
      const idempotencyKey = `${email.inviteId}:${email.tokenHash.slice(0, 12)}`;
      for (let attempt = 0; ; attempt++) {
        let response: globalThis.Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body,
            signal: AbortSignal.timeout(10_000),
          });
        } catch (error) {
          throw new Error("Email service unreachable", { cause: error });
        }
        if (response.ok) return;
        // Up to 3 retries on 429, backing off 0.5s, 1s, 2s (or Retry-After,
        // capped at 5s).
        if (response.status === 429 && attempt < 3) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(
            Number.isFinite(after) && after > 0
              ? Math.min(after * 1000, 5000)
              : 500 * 2 ** attempt,
          );
          continue;
        }
        let detail = "";
        try {
          const json = (await response.json()) as { name?: unknown };
          if (typeof json?.name === "string")
            detail = `: ${json.name.slice(0, 60)}`;
        } catch {
          // No JSON body.
        }
        throw new Error(`Email service returned ${response.status}${detail}`);
      }
    },
  };
}

// ---- Invites ----

export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";
const statusOf = (doc: InviteDocument): InviteStatus =>
  doc.status === "pending" && doc.expiresAt.getTime() <= Date.now()
    ? "expired"
    : doc.status;

/** What the admin API shows. Never includes the token or its hash. */
export const inviteView = (doc: InviteDocument) => ({
  id: doc._id,
  tenantId: doc.tenantId,
  email: doc.email,
  role: doc.role,
  status: statusOf(doc),
  delivery: doc.sentAt ? ("sent" as const) : ("not sent" as const),
  ...(doc.sendError ? { sendError: doc.sendError } : {}),
  createdAt: doc.createdAt,
  expiresAt: doc.expiresAt.toISOString(),
  ...(doc.sentAt ? { sentAt: doc.sentAt } : {}),
  ...(doc.acceptedAt ? { acceptedAt: doc.acceptedAt } : {}),
  ...(doc.acceptedBy ? { acceptedBy: doc.acceptedBy } : {}),
  ...(doc.revokedAt ? { revokedAt: doc.revokedAt } : {}),
});

const roleOf = (value: unknown): UserRole => {
  if (value !== "admin" && value !== "user")
    throw new ApiError(400, 'role must be "admin" or "user"', "INVALID_INPUT");
  return value;
};

// Sends, then records sentAt or sendError. A failed send keeps the invite.
async function deliver(
  store: Store,
  mailer: InviteMailer,
  tenant: TenantDocument,
  doc: InviteDocument,
  token: string,
) {
  try {
    await mailer.send({
      inviteId: doc._id,
      tokenHash: doc.tokenHash,
      to: doc.email,
      tenantName: tenant.name,
      role: doc.role,
      link: inviteLink(token),
      expiresAt: doc.expiresAt,
    });
    doc.sentAt = new Date().toISOString();
    delete doc.sendError;
    await store.invites.updateOne(
      { _id: doc._id, tokenHash: doc.tokenHash },
      { $set: { sentAt: doc.sentAt }, $unset: { sendError: "" } },
    );
  } catch (error) {
    doc.sendError =
      error instanceof Error ? error.message.slice(0, 200) : "Send failed";
    log("warn", "invite email failed", {
      inviteId: doc._id,
      tenantId: doc.tenantId,
      ...errorFields(error),
    });
    await store.invites.updateOne(
      { _id: doc._id, tokenHash: doc.tokenHash },
      { $set: { sendError: doc.sendError } },
    );
  }
}

/**
 * Creates a pending invite and returns its raw token (the only copy). Any
 * Google account address (Gmail or Workspace); 409 when the address is
 * already an active member or has a pending invite in this tenant.
 */
export async function issueInvite(
  store: Store,
  input: { tenant: TenantDocument; email: unknown; role: unknown },
) {
  const email = validEmail(input.email);
  if (!email)
    throw new ApiError(
      400,
      "Enter a valid email address for a Google account",
      "INVALID_EMAIL",
    );
  const role = roleOf(input.role);
  const key = emailKey(email);
  const tenantId = input.tenant._id;
  const user = await store.users.findOne({ emailKey: key });
  if (
    user &&
    (await store.memberships.findOne({
      userId: user._id,
      tenantId,
      status: "active",
    }))
  )
    throw new ApiError(
      409,
      "This person is already a member of the workspace",
      "ALREADY_MEMBER",
    );
  const alreadyInvited = () =>
    new ApiError(
      409,
      "This address already has a pending invite. Resend it instead.",
      "ALREADY_INVITED",
    );
  if (
    await store.invites.findOne({ tenantId, emailKey: key, status: "pending" })
  )
    throw alreadyInvited();
  const token = newToken();
  const now = new Date();
  const doc: InviteDocument = {
    _id: `inv_${randomUUID()}`,
    tenantId,
    email,
    emailKey: key,
    role,
    tokenHash: hashToken(token),
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
  };
  try {
    await store.invites.insertOne(doc);
  } catch (error) {
    // The unique pending index catches a parallel create.
    if ((error as { code?: number }).code === 11000) throw alreadyInvited();
    throw error;
  }
  return { doc, token };
}

export async function createInvite(
  store: Store,
  mailer: InviteMailer,
  input: { tenant: TenantDocument; email: unknown; role: unknown },
) {
  const { doc, token } = await issueInvite(store, input);
  await deliver(store, mailer, input.tenant, doc, token);
  return inviteView(doc);
}

export async function listInvites(store: Store, tenantId: string) {
  const docs = await store.invites
    .find({ tenantId })
    .sort({ createdAt: -1 })
    .limit(1000)
    .toArray();
  return docs.map(inviteView);
}

const inviteId = (value: string) => {
  if (!/^inv_[0-9a-f-]{36}$/.test(value))
    throw new ApiError(404, "Invite not found", "INVITE_NOT_FOUND");
  return value;
};
async function openInvite(store: Store, tenantId: string, id: string) {
  const doc = await store.invites.findOne({ _id: inviteId(id), tenantId });
  if (!doc) throw new ApiError(404, "Invite not found", "INVITE_NOT_FOUND");
  if (doc.status !== "pending")
    throw new ApiError(
      409,
      `This invite is already ${doc.status}`,
      "INVITE_CLOSED",
    );
  return doc;
}

/** New token and a fresh 7 days; the old link stops working at once. */
export async function resendInvite(
  store: Store,
  mailer: InviteMailer,
  tenant: TenantDocument,
  id: string,
) {
  const current = await openInvite(store, tenant._id, id);
  const token = newToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS);
  const doc = await store.invites.findOneAndUpdate(
    { _id: current._id, status: "pending" },
    { $set: { tokenHash, expiresAt }, $unset: { sentAt: "", sendError: "" } },
    { returnDocument: "after" },
  );
  if (!doc)
    throw new ApiError(
      409,
      "This invite is no longer pending",
      "INVITE_CLOSED",
    );
  await deliver(store, mailer, tenant, doc, token);
  return inviteView(doc);
}

export async function revokeInvite(store: Store, tenantId: string, id: string) {
  const current = await openInvite(store, tenantId, id);
  // status and revokedAt in one update; the pending index keys on status.
  const doc = await store.invites.findOneAndUpdate(
    { _id: current._id, status: "pending" },
    { $set: { status: "revoked", revokedAt: new Date().toISOString() } },
    { returnDocument: "after" },
  );
  if (!doc)
    throw new ApiError(
      409,
      "This invite is no longer pending",
      "INVITE_CLOSED",
    );
  return inviteView(doc);
}

// ---- Public lookup: GET /auth/invites/:token (dev and Google modes) ----

export interface InviteLookup {
  status: "valid" | "expired" | "used" | "revoked" | "not_found";
  /** For client countdowns. */
  serverNow: string;
  ttlDays: number;
  tenantName?: string;
  /** valid and expired only. */
  email?: string;
  role?: UserRole;
  sentAt?: string;
  expiresAt?: string;
  /** Only with a valid main session. */
  viewer?: {
    email: string;
    name?: string;
    member: boolean;
    memberSince?: string;
  };
}

const TTL_DAYS = Math.round(INVITE_LIFETIME_MS / DAY);

// Who is looking, from the main session. Any failure means no viewer.
async function lookupViewer(
  store: Store,
  req: Request | undefined,
  tenantId: string,
) {
  if (!req) return undefined;
  try {
    const session = await readSession(store, req, "main");
    if (!session?.userId) return undefined;
    const user = await store.users.findOne({ _id: session.userId });
    if (!user || user.status !== "active") return undefined;
    const membership = await store.memberships.findOne({
      userId: user._id,
      tenantId,
      status: "active",
    });
    return {
      email: user.email,
      ...(user.name ? { name: user.name } : {}),
      member: !!membership,
      ...(membership ? { memberSince: membership.createdAt } : {}),
    };
  } catch (error) {
    log("warn", "invite lookup could not read the viewer", errorFields(error));
    return undefined;
  }
}

export async function lookupInvite(
  store: Store,
  token: string,
  req?: Request,
): Promise<InviteLookup> {
  const base = { serverNow: new Date().toISOString(), ttlDays: TTL_DAYS };
  if (!TOKEN.test(token)) return { status: "not_found", ...base };
  const doc = await store.invites.findOne({ tokenHash: hashToken(token) });
  if (!doc) return { status: "not_found", ...base };
  const status =
    doc.status === "accepted"
      ? ("used" as const)
      : doc.status === "revoked"
        ? ("revoked" as const)
        : doc.expiresAt.getTime() <= Date.now()
          ? ("expired" as const)
          : ("valid" as const);
  const tenant = await store.tenantRegistry.findOne(
    { _id: doc.tenantId },
    { projection: { name: 1 } },
  );
  const viewer = await lookupViewer(store, req, doc.tenantId);
  // Anyone holding the link sees this before sign-in: never ids or hashes.
  // A tenant without a registry name omits tenantName rather than show its id.
  return {
    status,
    ...base,
    ...(tenant?.name ? { tenantName: tenant.name } : {}),
    ...(status === "valid" || status === "expired"
      ? { email: doc.email, role: doc.role }
      : {}),
    sentAt: doc.createdAt,
    expiresAt: doc.expiresAt.toISOString(),
    ...(viewer ? { viewer } : {}),
  };
}

export function inviteLookupRoutes(store: Store) {
  const router = Router();
  router.get(
    "/:token",
    rateLimit({ windowMs: 60_000, max: 20 }),
    route(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.json(await lookupInvite(store, String(req.params.token), req));
    }),
  );
  return router;
}
