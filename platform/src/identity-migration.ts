import { randomUUID, createHash } from "node:crypto";
import type { ClientSession } from "mongodb";
import {
  IdentityStore,
  identityBindingId,
  type IdentityPrincipal,
  type IdentityTenantBinding,
  type ExternalIdentityBinding,
} from "./identity";
import type { UserDocument } from "./auth";
import { ApiError } from "./errors";
import { tenantId } from "./tenant";
import { isPrincipal, type PrincipalRef } from "../../shared/authorization";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const externalId = (connection: string, issuer: string, subject: string) =>
  createHash("sha256")
    .update(JSON.stringify(["external", connection, issuer, subject]))
    .digest("hex");
export interface BackfillReport {
  version: 1;
  mode: "dry-run" | "apply";
  connectionId: string;
  users: number;
  ready: number;
  migrated: number;
  verified: number;
  issueCount: number;
  /** Bounded, ID/code only: no addresses, subjects, tokens or database URI. */
  issues: { userId: string; code: string }[];
}
const problem = (code: string) =>
  new ApiError(409, "Identity migration needs review", code);

/** Expansion only. No sessions are upgraded, no roles or grants are created,
 * and the legacy Google/email indexes remain until their readers migrate.
 * Google connection is operator-installed; migration never creates trust.
 */
export async function backfillGoogleIdentities(
  identity: IdentityStore,
  connectionId: string,
  apply = false,
  actor?: PrincipalRef,
): Promise<BackfillReport> {
  if (!ID.test(connectionId)) throw problem("INVALID_CONNECTION");
  if (apply && (!isPrincipal(actor) || actor.kind === "workload"))
    throw problem("NAMED_MIGRATION_ACTOR_REQUIRED");
  actor = actor === undefined ? undefined : structuredClone(actor);
  const report: BackfillReport = {
    version: 1,
    mode: apply ? "apply" : "dry-run",
    connectionId,
    users: 0,
    ready: 0,
    migrated: 0,
    verified: 0,
    issueCount: 0,
    issues: [],
  };
  const connection = await identity.connections.findOne({
    _id: connectionId,
    kind: "google",
    issuer: "https://accounts.google.com",
    status: "active",
  });
  if (
    !connection ||
    !ID.test(connection.generation) ||
    connection.tenantId !== undefined
  )
    throw problem("GOOGLE_CONNECTION_REQUIRED");
  // Capture expected connection generation; changing trust mid-run must stop
  // later rows from being silently rebound to a new connection.
  const checkUser = async (user: UserDocument, session?: ClientSession) => {
    if (
      typeof user._id !== "string" ||
      !ID.test(user._id) ||
      typeof user.googleSub !== "string" ||
      !/^[\x21-\x7e]{1,255}$/.test(user.googleSub) ||
      !["active", "disabled"].includes(user.status)
    )
      throw problem("LEGACY_USER_INVALID");
    if (
      user.authorizationGeneration !== undefined &&
      !ID.test(user.authorizationGeneration)
    )
      throw problem("LEGACY_GENERATION_INVALID");
    if (
      (await identity.store.users.countDocuments(
        { googleSub: user.googleSub },
        { session },
      )) !== 1
    )
      throw problem("DUPLICATE_GOOGLE_SUBJECT");
    const p = await identity.principals.findOne({ _id: user._id }, { session });
    if (
      p &&
      (p.kind !== "human" ||
        p.legacySource !== "google" ||
        p.status !== user.status ||
        !ID.test(p.generation) ||
        p.generation !== user.authorizationGeneration)
    )
      throw problem("PRINCIPAL_CONFLICT");
    if (!p && user.authorizationGeneration !== undefined)
      throw problem("PARTIAL_PRINCIPAL_MIGRATION");
    const external = await identity.externalBindings.findOne(
      { _id: externalId(connectionId, connection.issuer, user.googleSub) },
      { session },
    );
    if (
      external &&
      (!p ||
        external.principal.kind !== "human" ||
        external.principal.id !== user._id ||
        external.principal.generation !== p.generation ||
        external.connectionGeneration !== connection.generation ||
        external.status !== (user.status === "active" ? "active" : "revoked"))
    )
      throw problem("SUBJECT_BINDING_CONFLICT");
    const memberships = await identity.store.memberships
      .find({ userId: user._id }, { session })
      .limit(1001)
      .toArray();
    if (memberships.length > 1000) throw problem("MEMBERSHIP_LIMIT_REVIEW");
    const bindings: {
      legacy: (typeof memberships)[number];
      current: IdentityTenantBinding | null;
      tenantGeneration: string | undefined;
    }[] = [];
    for (const m of memberships) {
      if (
        typeof m._id !== "string" ||
        !ID.test(m._id) ||
        !["active", "removed"].includes(m.status) ||
        (m.authorizationGeneration !== undefined &&
          !ID.test(m.authorizationGeneration))
      )
        throw problem("LEGACY_MEMBERSHIP_INVALID");
      tenantId(m.tenantId);
      const t = await identity.store.tenantRegistry.findOne(
        { _id: m.tenantId },
        { session },
      );
      // An implicit default database is not an enterprise tenant.
      if (
        !t ||
        !["active", "disabled"].includes(t.status) ||
        t.provisioningStatus === "pending"
      )
        throw problem("TENANT_REVIEW_REQUIRED");
      if (
        t.authorizationGeneration !== undefined &&
        !ID.test(t.authorizationGeneration)
      )
        throw problem("TENANT_GENERATION_INVALID");
      const current = await identity.tenantBindings.findOne(
        { _id: identityBindingId(user._id, m.tenantId) },
        { session },
      );
      if (
        current &&
        (!p ||
          current.principal.id !== p._id ||
          current.principal.kind !== "human" ||
          current.principal.generation !== p.generation ||
          current.legacyMembershipId !== m._id ||
          current.status !== m.status ||
          current.generation !== m.authorizationGeneration ||
          current.tenantGeneration !== t.authorizationGeneration ||
          !ID.test(current.credentialGeneration) ||
          !Number.isSafeInteger(current.notBeforeMs) ||
          current.notBeforeMs < 0)
      )
        throw problem("MEMBERSHIP_BINDING_CONFLICT");
      if (!current && m.authorizationGeneration !== undefined)
        throw problem("PARTIAL_MEMBERSHIP_MIGRATION");
      bindings.push({
        legacy: m,
        current,
        tenantGeneration: t.authorizationGeneration,
      });
    }
    return { p, external, bindings };
  };
  const users = identity.store.users.find({}).sort({ _id: 1 }).batchSize(100);
  try {
    for await (const snapshot of users) {
      report.users++;
      try {
        if (!apply) {
          await checkUser(snapshot);
          report.ready++;
          continue;
        }
        const changed = await identity.store.withCatalogTransaction(
          async (session) => {
            const trusted = await identity.connections.findOne(
              {
                _id: connectionId,
                generation: connection.generation,
                status: "active",
                kind: "google",
                issuer: connection.issuer,
              },
              { session },
            );
            if (!trusted) throw problem("CONNECTION_CHANGED");
            const user = await identity.store.users.findOne(
              { _id: snapshot._id },
              { session },
            );
            if (!user || user.googleSub !== snapshot.googleSub)
              throw problem("LEGACY_USER_CHANGED");
            const { p, external, bindings } = await checkUser(user, session);
            let changed = false;
            const principal: IdentityPrincipal = p ?? {
              _id: user._id,
              kind: "human",
              legacySource: "google",
              generation: randomUUID(),
              status: user.status,
              createdAt: new Date(),
            };
            if (!p) {
              await identity.principals.insertOne(principal, { session });
              const stamped = await identity.store.users.updateOne(
                {
                  _id: user._id,
                  status: user.status,
                  googleSub: user.googleSub,
                  authorizationGeneration: { $exists: false },
                },
                { $set: { authorizationGeneration: principal.generation } },
                { session },
              );
              if (stamped.matchedCount !== 1)
                throw problem("LEGACY_USER_CHANGED");
              changed = true;
            }
            if (!external) {
              const next: ExternalIdentityBinding = {
                _id: externalId(
                  connectionId,
                  connection.issuer,
                  user.googleSub,
                ),
                connectionId,
                connectionGeneration: connection.generation,
                issuer: connection.issuer,
                subject: user.googleSub,
                principal: {
                  kind: "human",
                  id: principal._id,
                  generation: principal.generation,
                },
                status: user.status === "active" ? "active" : "revoked",
                createdAt: new Date(),
              };
              await identity.externalBindings.insertOne(next, { session });
              changed = true;
            }
            for (const { legacy: m, current, tenantGeneration } of bindings) {
              if (current) continue;
              const tg = tenantGeneration ?? randomUUID();
              if (!tenantGeneration) {
                const stampedTenant =
                  await identity.store.tenantRegistry.updateOne(
                    {
                      _id: m.tenantId,
                      authorizationGeneration: { $exists: false },
                    },
                    { $set: { authorizationGeneration: tg } },
                    { session },
                  );
                if (stampedTenant.matchedCount !== 1)
                  throw problem("TENANT_CHANGED");
              }
              const next: IdentityTenantBinding = {
                _id: identityBindingId(user._id, m.tenantId),
                legacyMembershipId: m._id,
                tenantId: m.tenantId,
                tenantGeneration: tg,
                principal: {
                  kind: "human",
                  id: principal._id,
                  generation: principal.generation,
                },
                generation: randomUUID(),
                credentialGeneration: randomUUID(),
                notBeforeMs: Date.now(),
                status: m.status,
                epoch: 1,
                createdAt: new Date(),
                ...(m.status === "removed" ? { removedAt: new Date() } : {}),
              };
              await identity.tenantBindings.insertOne(next, { session });
              const stampedMembership =
                await identity.store.memberships.updateOne(
                  {
                    _id: m._id,
                    userId: user._id,
                    status: m.status,
                    authorizationGeneration: { $exists: false },
                  },
                  { $set: { authorizationGeneration: next.generation } },
                  { session },
                );
              if (stampedMembership.matchedCount !== 1)
                throw problem("LEGACY_MEMBERSHIP_CHANGED");
              if (m.status === "removed")
                await identity.tombstones.insertOne(
                  {
                    _id: createHash("sha256")
                      .update(
                        JSON.stringify(["removed", next._id, next.generation]),
                      )
                      .digest("hex"),
                    bindingId: next._id,
                    generation: next.generation,
                    credentialGeneration: next.credentialGeneration,
                    tenantId: m.tenantId,
                    at: new Date(),
                  },
                  { session },
                );
              changed = true;
            }
            if (changed)
              await identity.audit.insertOne(
                {
                  _id: randomUUID(),
                  action: "identity.google.backfill",
                  actor: actor!,
                  targetId: user._id,
                  generation: principal.generation,
                  at: new Date(),
                },
                { session },
              );
            return changed;
          },
        );
        report.ready++;
        if (changed) report.migrated++;
        else report.verified++;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        report.issueCount++;
        if (report.issues.length < 100)
          report.issues.push({
            userId:
              typeof snapshot._id === "string" && ID.test(snapshot._id)
                ? snapshot._id
                : "invalid-id",
            code: error.code,
          });
      }
    }
  } finally {
    await users.close();
  }
  return report;
}
