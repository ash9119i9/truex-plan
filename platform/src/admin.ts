import { createHash, scrypt, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { idCandidates } from "./documents";
import { ApiError } from "./errors";
import { route } from "./http";
import type { Store } from "./store";
import type { PlatformService } from "./service";
import {
  DEFAULT_TENANT_ID,
  admissionPolicyOf,
  chatVisibilityOf,
  effectivePrivacy,
  tenantDbName,
  tenantId,
  type TenantDocument,
  type TenantRef,
} from "./tenant";
import type { DemoGate } from "./demo";
import { auditAfter } from "./audit";
import { userId } from "./user";
import {
  createSession,
  deleteSession,
  rateLimit,
  readSession,
  revokeSessions,
} from "./auth";
import {
  createInvite,
  listInvites,
  resendInvite,
  revokeInvite,
  type InviteMailer,
} from "./invites";
import { errorFields, log } from "../../shared/logging";

// ---- Password hash: scrypt$N$r$p$<saltB64>$<hashB64> ----

interface ScryptHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}
export function parsePasswordHash(value: string | undefined) {
  const parts = value?.trim().split("$") ?? [];
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  const power = N > 1 && (N & (N - 1)) === 0;
  if (!power || !(r > 0) || !(p > 0) || salt.length < 8 || hash.length < 16)
    return undefined;
  return { N, r, p, salt, hash } satisfies ScryptHash;
}
const derive = (password: string, spec: Omit<ScryptHash, "hash">, length: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      spec.salt,
      length,
      { N: spec.N, r: spec.r, p: spec.p, maxmem: 256 * spec.N * spec.r + (1 << 20) },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export async function verifyPassword(spec: ScryptHash, password: string) {
  const key = await derive(password, spec, spec.hash.length);
  return timingSafeEqual(key, spec.hash);
}
// Equal-length digests, so the comparison takes the same time for any input.
const sameText = (a: string, b: string) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

// ---- /auth/admin/* (mounted in dev and Google modes) ----

export function adminAuthRoutes(store: Store, env: NodeJS.ProcessEnv = process.env) {
  const username = env.ADMIN_USERNAME?.trim() ?? "";
  const spec = parsePasswordHash(env.ADMIN_PASSWORD_HASH);
  const reason = !env.ADMIN_PASSWORD_HASH?.trim()
    ? "ADMIN_PASSWORD_HASH is not set"
    : !spec
      ? "ADMIN_PASSWORD_HASH is not a valid scrypt$N$r$p$salt$hash value"
      : !username
        ? "ADMIN_USERNAME is not set"
        : undefined;
  // Logged once at startup. There is never a default password.
  if (reason) log("warn", "admin login disabled", { reason });
  // Used when the username is wrong, so a miss costs the same scrypt run.
  const decoy = spec ?? {
    N: 16384,
    r: 8,
    p: 1,
    salt: Buffer.alloc(16),
    hash: Buffer.alloc(64),
  };
  const router = Router();
  router.post(
    "/login",
    rateLimit({ windowMs: 60_000, max: 5 }),
    route(async (req, res) => {
      if (reason)
        throw new ApiError(
          503,
          "Admin sign-in is disabled on this server",
          "ADMIN_LOGIN_DISABLED",
        );
      const name = typeof req.body?.username === "string" ? req.body.username : "";
      const password =
        typeof req.body?.password === "string" ? req.body.password : "";
      const userOk = sameText(name, username);
      // Always runs, whatever the username.
      const passOk = await verifyPassword(decoy, password.slice(0, 1024));
      if (!(userOk && passOk && spec))
        throw new ApiError(
          401,
          "Wrong username or password",
          "INVALID_CREDENTIALS",
        );
      await createSession(store, res, {
        userId: null,
        tenantId: null,
        app: "admin",
        userAgent: req.get("user-agent"),
      });
      res.json({ username });
    }),
  );
  router.post(
    "/logout",
    route(async (req, res) => {
      await deleteSession(store, req, res, "admin");
      res.status(204).end();
    }),
  );
  router.get(
    "/me",
    route(async (req, res) => {
      if (!(await readSession(store, req, "admin")))
        throw new ApiError(401, "Sign in to continue", "UNAUTHENTICATED");
      res.json({ username });
    }),
  );
  return router;
}

// ---- /api/admin/* gate (ahead of every other /api middleware) ----

/**
 * Only a valid admin session passes, in both modes; dev tenant and user
 * headers are never consulted. Mounted before the dev resolvers and before
 * google mode's authMiddleware, and the admin router ends every request, so
 * nothing downstream on /api ever sees /api/admin.
 */
export function adminGate(store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      if (await readSession(store, req, "admin")) {
        res.locals.admin = true;
        return;
      }
      if (await readSession(store, req, "main"))
        throw new ApiError(
          403,
          "This session belongs to a different app",
          "WRONG_APP",
        );
      throw new ApiError(401, "Sign in to continue", "UNAUTHENTICATED");
    })().then(() => next(), next);
  };
}

// ---- Tenants ----

const now = () => new Date().toISOString();

/** The registry entry, or the implicit default tenant; 404 otherwise. */
export async function findTenant(store: Store, id: unknown) {
  const tid = tenantId(id);
  const doc = await store.tenantRegistry.findOne({ _id: tid });
  if (doc) return { doc, registered: true };
  if (tid === DEFAULT_TENANT_ID)
    return {
      doc: {
        _id: tid,
        name: "Default",
        dbName: store.database,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      } satisfies TenantDocument as TenantDocument,
      registered: false,
    };
  throw new ApiError(404, "Unknown workspace", "TENANT_NOT_FOUND");
}

/**
 * A database that holds data but belongs to no tenant must never be adopted:
 * the new tenant would silently inherit someone's content. Empty collections
 * (left by an interrupted earlier run) are fine.
 */
export async function assertFreshDatabase(store: Store, dbName: string) {
  const db = store.client.db(dbName);
  const collections = await db
    .listCollections({}, { nameOnly: true })
    .toArray();
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    if (await db.collection(name).findOne({}, { projection: { _id: 1 } }))
      throw new ApiError(
        409,
        "That workspace's database already contains data and is not registered. Nothing was changed.",
        "TENANT_DB_NOT_EMPTY",
      );
  }
}

/**
 * Same id rules as `npm run tenant -- create` (TENANT_ID, tenantDbName, the
 * catalog-collision and dbName-ownership checks, and a fresh database).
 * Indexes come from the store's tenantIndexes(). A new workspace is invite-only
 * and private: members see only their own conversations and agents, so agent
 * handles are unique per creator. Adds no members.
 */
export async function createTenant(store: Store, input: { id: unknown; name: unknown }) {
  const id = tenantId(input.id);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100)
    throw new ApiError(400, "Name must be 1 to 100 characters", "INVALID_INPUT");
  if (await store.tenantRegistry.findOne({ _id: id }))
    throw new ApiError(409, `Tenant "${id}" already exists`, "TENANT_EXISTS");
  const dbName = id === DEFAULT_TENANT_ID ? store.database : tenantDbName(id);
  if (dbName === store.catalogDatabase && id !== DEFAULT_TENANT_ID)
    throw new ApiError(409, "Tenant database would collide with the catalog", "TENANT_EXISTS");
  if (await store.tenantRegistry.findOne({ dbName }))
    throw new ApiError(409, "Tenant database is already in use", "TENANT_EXISTS");
  if (id !== DEFAULT_TENANT_ID) await assertFreshDatabase(store, dbName);
  const doc: TenantDocument = {
    _id: id,
    name,
    dbName,
    status: "active",
    admissionPolicy: "inviteOnly",
    isUserSpecific: true,
    // Old readers know only this spelling; keep it in step.
    chatVisibility: "own",
    createdAt: now(),
    updatedAt: now(),
  };
  try {
    await store.tenantRegistry.insertOne(doc);
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      throw new ApiError(409, `Tenant "${id}" already exists`, "TENANT_EXISTS");
    throw error;
  }
  await store.ensureTenantIndexes(dbName, true);
  return doc;
}

const tenantView = (
  doc: TenantDocument,
  counts: { members: number; admins: number; pendingInvites: number },
) => {
  const privacy = effectivePrivacy(doc);
  return {
    id: doc._id,
    name: doc.name,
    status: doc.status,
    ...(doc.allowedModelIds ? { allowedModelIds: doc.allowedModelIds } : {}),
    ...(doc.allowedSkillIds ? { allowedSkillIds: doc.allowedSkillIds } : {}),
    // Legacy spelling, derived. "invalid" means the stored fields disagree and
    // the workspace refuses requests until an admin corrects it.
    chatVisibility: privacy.invalid
      ? ("invalid" as const)
      : privacy.isUserSpecific === undefined
        ? ("all" as const)
        : privacy.isUserSpecific
          ? ("own" as const)
          : ("all" as const),
    isUserSpecific: privacy.invalid ? null : (privacy.isUserSpecific ?? null),
    admissionPolicy: admissionPolicyOf(doc.admissionPolicy) ?? "inviteOnly",
    createdAt: doc.createdAt,
    ...counts,
  };
};

async function tenantCounts(store: Store) {
  const members = await store.memberships
    .aggregate<{ _id: { tenantId: string; role: string }; n: number }>([
      { $match: { status: "active" } },
      { $group: { _id: { tenantId: "$tenantId", role: "$role" }, n: { $sum: 1 } } },
    ])
    .toArray();
  const invites = await store.invites
    .aggregate<{ _id: string; n: number }>([
      { $match: { status: "pending", expiresAt: { $gt: new Date() } } },
      { $group: { _id: "$tenantId", n: { $sum: 1 } } },
    ])
    .toArray();
  return (id: string) => {
    const mine = members.filter((m) => m._id.tenantId === id);
    return {
      members: mine.reduce((sum, m) => sum + m.n, 0),
      admins: mine.find((m) => m._id.role === "admin")?.n ?? 0,
      pendingInvites: invites.find((i) => i._id === id)?.n ?? 0,
    };
  };
}

// Catalog ids may be strings or ObjectIds; allow-lists store them as strings.
async function allowList(store: Store, collection: string, value: unknown) {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((v) => typeof v !== "string" || !v || v.length > 200)
  )
    throw new ApiError(400, `${collection} must be a list of ids or null`, "INVALID_INPUT");
  const ids = [...new Set(value as string[])];
  const missing: string[] = [];
  for (const id of ids)
    if (
      !(await store.catalog
        .collection(collection)
        .findOne({ _id: { $in: idCandidates(id) as never[] } }, { projection: { _id: 1 } }))
    )
      missing.push(id);
  if (missing.length)
    throw new ApiError(400, `Unknown ids: ${missing.join(", ")}`, "INVALID_INPUT");
  return ids;
}

// Removing a member or disabling a workspace blocks every later request, but a
// turn already handed to the runtime keeps going. This asks the runtime to stop
// the recent ones, in the background, and records what happened: stop
// requested, nothing running, or failed. It does not undo anything a tool
// already did elsewhere.
function stopRunningTurns(
  store: Store,
  service: PlatformService,
  ref: TenantRef,
  scope: { userId?: string },
  requestId?: string,
) {
  void store
    .withTenant(ref, () => service.interruptRecent(scope))
    .then((outcome) =>
      auditAfter(store, {
        actor: "platform-admin",
        actorRole: "platform-admin",
        action: "turns.stop",
        tenantId: ref.id,
        ...(scope.userId ? { target: { type: "user", id: scope.userId } } : {}),
        requestId,
        detail: outcome,
      }),
    )
    .catch((error) =>
      log("error", "stopping running turns failed", {
        tenantId: ref.id,
        ...errorFields(error),
      }),
    );
}

// ---- Members ----

async function membersOf(store: Store, tid: string) {
  const memberships = await store.memberships
    .find({ tenantId: tid, status: "active" })
    .sort({ createdAt: 1 })
    .toArray();
  const users = await store.users
    .find({ _id: { $in: memberships.map((m) => m.userId) } })
    .toArray();
  const byId = new Map(users.map((u) => [u._id, u]));
  return memberships.map((m) => {
    const user = byId.get(m.userId);
    return {
      userId: m.userId,
      email: user?.email ?? null,
      ...(user?.name ? { name: user.name } : {}),
      role: m.role,
      userStatus: user?.status ?? "active",
      joinedAt: m.createdAt,
      lastLoginAt: user?.lastLoginAt ?? null,
    };
  });
}

const roleOf = (value: unknown) => {
  if (value !== "admin" && value !== "user")
    throw new ApiError(400, 'role must be "admin" or "user"', "INVALID_INPUT");
  return value;
};

// ---- /api/admin/* ----

export function adminApiRoutes(
  store: Store,
  service: PlatformService,
  mailer: InviteMailer,
  demo?: DemoGate,
) {
  const router = Router();
  // Why the public demo is, or is not, ready to admit people. Codes only.
  router.get(
    "/demo",
    route(async (_req, res) => {
      const readiness = await demo?.readiness();
      res.json(
        readiness
          ? { enabled: true, tenantId: demo!.config!.tenantId, ...readiness }
          : { enabled: false },
      );
    }),
  );
  router.get(
    "/tenants",
    route(async (_req, res) => {
      const docs = await store.tenantRegistry.find({}).sort({ _id: 1 }).toArray();
      if (!docs.some((d) => d._id === DEFAULT_TENANT_ID))
        docs.unshift((await findTenant(store, DEFAULT_TENANT_ID)).doc);
      const counts = await tenantCounts(store);
      res.json({ tenants: docs.map((d) => tenantView(d, counts(d._id))) });
    }),
  );
  router.post(
    "/tenants",
    route(async (req, res) => {
      const doc = await createTenant(store, req.body ?? {});
      res
        .status(201)
        .json({ tenant: tenantView(doc, { members: 0, admins: 0, pendingInvites: 0 }) });
    }),
  );
  router.patch(
    "/tenants/:id",
    route(async (req, res) => {
      const { doc, registered } = await findTenant(store, req.params.id);
      const body = req.body ?? {};
      const $set: Partial<TenantDocument> = {};
      const $unset: Record<string, ""> = {};
      if ("status" in body) {
        if (body.status !== "active" && body.status !== "disabled")
          throw new ApiError(400, 'status must be "active" or "disabled"', "INVALID_INPUT");
        $set.status = body.status;
      }
      for (const [field, collection] of [
        ["allowedModelIds", "truex_models"],
        ["allowedSkillIds", "truex_skills"],
      ] as const)
        if (field in body) {
          const ids = await allowList(store, collection, body[field]);
          if (ids) $set[field] = ids;
          else $unset[field] = "";
        }
      const current = effectivePrivacy(doc);
      let nextPrivate = current.isUserSpecific;
      if ("isUserSpecific" in body) {
        if (typeof body.isUserSpecific !== "boolean")
          throw new ApiError(400, "isUserSpecific must be true or false", "INVALID_INPUT");
        nextPrivate = body.isUserSpecific;
      }
      if ("chatVisibility" in body) {
        const value = chatVisibilityOf(body.chatVisibility);
        if (!value)
          throw new ApiError(400, 'chatVisibility must be "own" or "all"', "INVALID_INPUT");
        // Two spellings of one setting must agree; neither wins by order.
        if (
          "isUserSpecific" in body &&
          (value === "own") !== body.isUserSpecific
        )
          throw new ApiError(
            400,
            "chatVisibility and isUserSpecific disagree",
            "INVALID_INPUT",
          );
        nextPrivate = value === "own";
      }
      if ("isUserSpecific" in body || "chatVisibility" in body) {
        // Making a private workspace shared would expose its history to every
        // member. That is not a live toggle in this release. A record whose
        // fields disagree can only be repaired towards private.
        if (nextPrivate === false && (current.invalid || current.isUserSpecific === true))
          throw new ApiError(
            409,
            "A private workspace cannot be made shared. This needs a separate reviewed change.",
            "PRIVACY_LOCKED",
          );
        $set.isUserSpecific = nextPrivate;
        $set.chatVisibility = nextPrivate ? "own" : "all";
      }
      if ("admissionPolicy" in body) {
        const value = admissionPolicyOf(body.admissionPolicy);
        if (!value)
          throw new ApiError(
            400,
            'admissionPolicy must be "open" or "inviteOnly"',
            "INVALID_INPUT",
          );
        if (value === "open") {
          // Open admission is for the one configured demo tenant only, and
          // only once it is fully ready; closing it is always allowed.
          if (!demo?.config || demo.config.tenantId !== doc._id)
            throw new ApiError(
              409,
              "Open admission is only available for the configured demo workspace (DEMO_TENANT_ID).",
              "ADMISSION_NOT_ALLOWED",
            );
          const readiness = await demo.readiness(false);
          // Privacy set in this same request counts as set.
          const problems = (readiness?.problems ?? []).filter(
            (p) => !(p === "PRIVACY_NOT_USER_SPECIFIC" && $set.isUserSpecific === true),
          );
          if (problems.length)
            throw new ApiError(
              409,
              `The demo workspace is not ready to open: ${[...new Set(problems)].join(", ")}`,
              "DEMO_NOT_READY",
            );
        }
        $set.admissionPolicy = value;
      }
      if (!Object.keys($set).length && !Object.keys($unset).length)
        throw new ApiError(400, "Nothing to change", "INVALID_INPUT");
      // The implicit default tenant is registered on its first change.
      if (!registered) await store.tenantRegistry.insertOne(doc);
      const updated = await store.tenantRegistry.findOneAndUpdate(
        { _id: doc._id },
        {
          $set: { ...$set, updatedAt: now() },
          ...(Object.keys($unset).length ? { $unset } : {}),
        },
        { returnDocument: "after" },
      );
      store.invalidateTenant(doc._id);
      // Disabling is the incident control for a whole workspace: everyone
      // signed in to it is signed out, not only refused on the next request.
      let sessionsRevoked = 0;
      if ($set.status === "disabled")
        sessionsRevoked = (
          await store.authSessions.deleteMany({ tenantId: doc._id, app: "main" })
        ).deletedCount;
      if ($set.status === "disabled")
        stopRunningTurns(
          store,
          service,
          { id: doc._id, dbName: doc.dbName },
          {},
          res.locals.requestId,
        );
      await auditAfter(store, {
        actor: "platform-admin",
        actorRole: "platform-admin",
        action: "tenant.update",
        tenantId: doc._id,
        requestId: res.locals.requestId,
        detail: {
          fields: Object.keys({ ...$set, ...$unset }).sort().join(","),
          ...(sessionsRevoked ? { sessionsRevoked } : {}),
        },
      });
      const counts = await tenantCounts(store);
      res.json({ tenant: tenantView(updated!, counts(doc._id)) });
    }),
  );

  router.get(
    "/tenants/:id/invites",
    route(async (req, res) => {
      const { doc } = await findTenant(store, req.params.id);
      res.json({ invites: await listInvites(store, doc._id) });
    }),
  );
  router.post(
    "/tenants/:id/invites",
    route(async (req, res) => {
      const { doc } = await findTenant(store, req.params.id);
      const invite = await createInvite(store, mailer, {
        tenant: doc,
        email: req.body?.email,
        role: req.body?.role,
      });
      await auditAfter(store, {
        actor: "platform-admin",
        actorRole: "platform-admin",
        action: "invite.create",
        tenantId: doc._id,
        target: { type: "invite", id: invite.id },
        requestId: res.locals.requestId,
        detail: { role: invite.role },
      });
      res.status(201).json({ invite });
    }),
  );
  router.post(
    "/tenants/:id/invites/:inviteId/resend",
    route(async (req, res) => {
      const { doc } = await findTenant(store, req.params.id);
      res.json({
        invite: await resendInvite(store, mailer, doc, String(req.params.inviteId)),
      });
    }),
  );
  router.delete(
    "/tenants/:id/invites/:inviteId",
    route(async (req, res) => {
      const { doc } = await findTenant(store, req.params.id);
      res.json({
        invite: await revokeInvite(store, doc._id, String(req.params.inviteId)),
      });
    }),
  );

  router.get(
    "/tenants/:id/members",
    route(async (req, res) => {
      const { doc } = await findTenant(store, req.params.id);
      res.json({ members: await membersOf(store, doc._id) });
    }),
  );
  router.patch(
    "/tenants/:id/members/:userId",
    route(async (req, res) => {
      const { doc } = await findTenant(store, req.params.id);
      const uid = userId(req.params.userId);
      const role = roleOf(req.body?.role);
      const { matchedCount } = await store.memberships.updateOne(
        { userId: uid, tenantId: doc._id, status: "active" },
        { $set: { role } },
      );
      if (!matchedCount)
        throw new ApiError(404, "Member not found", "MEMBER_NOT_FOUND");
      await auditAfter(store, {
        actor: "platform-admin",
        actorRole: "platform-admin",
        action: "member.role",
        tenantId: doc._id,
        target: { type: "user", id: uid },
        requestId: res.locals.requestId,
        detail: { role },
      });
      res.json({ userId: uid, role });
    }),
  );
  router.delete(
    "/tenants/:id/members/:userId",
    route(async (req, res) => {
      const { doc } = await findTenant(store, req.params.id);
      const uid = userId(req.params.userId);
      const { matchedCount } = await store.memberships.updateOne(
        { userId: uid, tenantId: doc._id, status: "active" },
        { $set: { status: "removed" } },
      );
      if (!matchedCount)
        throw new ApiError(404, "Member not found", "MEMBER_NOT_FOUND");
      const sessionsRevoked = await revokeSessions(store, {
        userId: uid,
        tenantId: doc._id,
      });
      // Built from the registry, not resolveTenant(): a disabled tenant's
      // member must still be removable.
      const ref: TenantRef = { id: doc._id, dbName: doc.dbName };
      let mcpsDeleted = 0;
      try {
        mcpsDeleted = (
          await store.withTenant(ref, () => service.deleteUserMcps(uid))
        ).deleted;
      } catch (error) {
        log("error", "member MCP cleanup failed", {
          tenantId: doc._id,
          userId: uid,
          ...errorFields(error),
        });
        throw error;
      }
      await auditAfter(store, {
        actor: "platform-admin",
        actorRole: "platform-admin",
        action: "member.remove",
        tenantId: doc._id,
        target: { type: "user", id: uid },
        requestId: res.locals.requestId,
        detail: { sessionsRevoked, mcpsDeleted },
      });
      stopRunningTurns(store, service, ref, { userId: uid }, res.locals.requestId);
      res.json({ userId: uid, status: "removed", sessionsRevoked, mcpsDeleted });
    }),
  );
  // Nothing under /api/admin may fall through to the tenant middleware.
  router.use(
    route(() => {
      throw new ApiError(404, "Not found", "NOT_FOUND");
    }),
  );
  return router;
}
