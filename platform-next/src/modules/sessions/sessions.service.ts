import { Inject, Injectable, Logger } from "@nestjs/common";
import { ObjectId, type Collection } from "mongodb";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { DatabaseService } from "../../database/database.service";
import { AuditService } from "../audit/audit.service";
import { MembershipsService } from "../memberships/memberships.service";
import { dbNameFor } from "../tenants/tenant";
import { TenantsService } from "../tenants/tenants.service";
import type { UserDoc } from "../users/user";
import { UsersService } from "../users/users.service";
import {
  InvalidAccessTokenError,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenTenant,
} from "./access-token";
import {
  SESSIONS_COLLECTION,
  formatRefreshCredential,
  hashRefreshSecret,
  isLive,
  newRefreshSecret,
  parseRefreshCredential,
  sameHash,
  type SessionDoc,
  type SessionRevokeReason,
} from "./session";
import {
  REFRESH_HISTORY_SIZE,
  REFRESH_RACE_GRACE_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from "./session-policy";

// The session is missing, expired, revoked, or the credential is wrong. The
// caller must sign in again; the reason is deliberately not distinguished.
export class InvalidSessionError extends Error {
  constructor() {
    super("The session is not valid.");
    this.name = "InvalidSessionError";
  }
}

// Another request rotated the same credential a moment ago (two tabs
// refreshing at once). Retrying with the current cookie succeeds.
export class RefreshRaceError extends Error {
  constructor() {
    super("The session was refreshed by another request.");
    this.name = "RefreshRaceError";
  }
}

export interface IssuedSession {
  userId: ObjectId;
  sessionId: ObjectId;
  // The tenant the access token is for, when one was asked for and granted.
  tenant?: AccessTokenTenant;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshCredential: string;
  // When the refresh cookie should expire in the browser.
  refreshExpiresAt: Date;
}

// What a valid access token says, checked by signature alone. The session
// and account were live when it was issued, at most a token lifetime ago.
export interface TokenCaller {
  userId: ObjectId;
  sessionId: ObjectId;
  tenant?: AccessTokenTenant;
}

export interface AuthenticatedCaller extends TokenCaller {
  // The active account, as read while authenticating.
  user: UserDoc;
}

// Kept for a day past the absolute expiry, then removed by MongoDB. Validity
// never depends on this cleanup: every check compares the expiry dates.
const CLEANUP_AFTER_SECONDS = 24 * 60 * 60;

@Injectable()
export class SessionsService {
  private readonly logger = new Logger("Sessions");
  private indexesReady?: Promise<void>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private sessions(): Collection<SessionDoc> {
    return this.database.catalog().collection<SessionDoc>(SESSIONS_COLLECTION);
  }

  ensureIndexes(): Promise<void> {
    this.indexesReady ??= this.createIndexes().catch((error: unknown) => {
      this.indexesReady = undefined;
      throw error;
    });
    return this.indexesReady;
  }

  private async createIndexes(): Promise<void> {
    await this.sessions().createIndexes([
      { key: { userId: 1 }, name: "by_user" },
      {
        key: { absoluteExpiresAt: 1 },
        name: "cleanup_after_expiry",
        expireAfterSeconds: CLEANUP_AFTER_SECONDS,
      },
    ]);
  }

  // Starts a session for an account that has just signed in.
  async create(userId: ObjectId, now = new Date()): Promise<IssuedSession> {
    await this.ensureIndexes();
    const secret = newRefreshSecret();
    const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS);
    const session: SessionDoc = {
      _id: new ObjectId(),
      userId,
      refreshHash: hashRefreshSecret(secret),
      previousRefreshHashes: [],
      generation: 0,
      createdAt: now,
      lastRefreshedAt: now,
      idleExpiresAt: idleExpiry(absoluteExpiresAt, now),
      absoluteExpiresAt,
    };
    await this.sessions().insertOne(session);
    return this.issue(session, secret, now);
  }

  // Exchanges the current refresh credential for a new one and a new access
  // token. Exactly one of several concurrent refreshes wins. With a tenantId
  // the token also carries that tenant and the caller's role there, when the
  // caller is an active member of a usable tenant; otherwise it carries no
  // tenant, which is not an error: tenant routes then check the catalog.
  async refresh(
    credential: unknown,
    now = new Date(),
    tenantId?: ObjectId,
  ): Promise<IssuedSession> {
    const parsed = parseRefreshCredential(credential);
    if (!parsed) throw new InvalidSessionError();
    await this.ensureIndexes();

    const session = await this.sessions().findOne({ _id: parsed.sessionId });
    if (!session || !isLive(session, now)) throw new InvalidSessionError();
    const presented = hashRefreshSecret(parsed.secret);
    if (!sameHash(session.refreshHash, presented))
      return this.rejectStale(session, presented, now);

    // One round trip: the account and, when asked, the tenant access.
    const [user, tenant] = await Promise.all([
      this.users.findById(session.userId),
      tenantId ? this.tenantAccess(session.userId, tenantId) : undefined,
    ]);
    if (user?.status !== "active") {
      await this.revoke(session._id, "account_disabled", now);
      throw new InvalidSessionError();
    }

    const secret = newRefreshSecret();
    const rotated = await this.sessions().findOneAndUpdate(
      {
        _id: session._id,
        refreshHash: session.refreshHash,
        revokedAt: { $exists: false },
      },
      {
        $set: {
          refreshHash: hashRefreshSecret(secret),
          lastRefreshedAt: now,
          idleExpiresAt: idleExpiry(session.absoluteExpiresAt, now),
        },
        $inc: { generation: 1 },
        $push: {
          previousRefreshHashes: {
            $each: [{ hash: session.refreshHash, rotatedAt: now }],
            $slice: -REFRESH_HISTORY_SIZE,
          },
        },
      },
      { returnDocument: "after" },
    );
    if (rotated) return this.issue(rotated, secret, now, tenant);

    // Lost the rotation to a concurrent request, or the session was revoked.
    const latest = await this.sessions().findOne({ _id: session._id });
    if (!latest || !isLive(latest, now)) throw new InvalidSessionError();
    return this.rejectStale(latest, presented, now);
  }

  // A credential that is not current. Recently rotated means another tab won
  // a race; rotated longer ago means it was copied, so the whole session is
  // revoked. An unknown secret revokes nothing: knowing a session ID alone
  // must not let anyone end someone else's session.
  private async rejectStale(
    session: SessionDoc,
    presented: string,
    now: Date,
  ): Promise<never> {
    const previous = session.previousRefreshHashes.find((entry) =>
      sameHash(entry.hash, presented),
    );
    if (!previous) throw new InvalidSessionError();
    if (now.getTime() - previous.rotatedAt.getTime() <= REFRESH_RACE_GRACE_MS)
      throw new RefreshRaceError();

    await this.revoke(session._id, "refresh_reuse", now);
    this.logger.warn({
      message: "refresh credential reused; session revoked",
      sessionId: session._id.toHexString(),
    });
    await this.audit.record({
      action: "session.refresh_reuse",
      actor: { kind: "user", userId: session.userId },
      result: "denied",
      targetUserId: session.userId,
      details: { sessionId: session._id.toHexString() },
    });
    throw new InvalidSessionError();
  }

  // Ends the session the credential belongs to. Idempotent, and quiet about
  // credentials that do not match, so logout always succeeds for the caller.
  async logout(credential: unknown, now = new Date()): Promise<void> {
    const parsed = parseRefreshCredential(credential);
    if (!parsed) return;
    const session = await this.sessions().findOne({ _id: parsed.sessionId });
    if (!session || session.revokedAt) return;
    const presented = hashRefreshSecret(parsed.secret);
    const known =
      sameHash(session.refreshHash, presented) ||
      session.previousRefreshHashes.some((entry) =>
        sameHash(entry.hash, presented),
      );
    if (known) await this.revoke(session._id, "logout", now);
  }

  // The tenant claims for a token: an active membership in a usable tenant
  // whose database is the one its kind and ID give, or undefined.
  private async tenantAccess(
    userId: ObjectId,
    tenantId: ObjectId,
  ): Promise<AccessTokenTenant | undefined> {
    const [membership, tenant] = await Promise.all([
      this.memberships.findActive(userId, tenantId),
      this.tenants.findUsable(tenantId),
    ]);
    if (!membership || !tenant) return undefined;
    // Tenant routes derive the database from the token's kind and ID. A
    // registry record that disagrees keeps its tenant out of tokens, so its
    // requests take the catalog path and use the recorded database.
    if (tenant.dbName !== dbNameFor(tenant.kind, tenant._id)) {
      this.logger.warn({
        message: "tenant database does not match its kind; not put in token",
        tenantId: tenant._id.toHexString(),
      });
      return undefined;
    }
    return { tenantId: tenant._id, role: membership.role, kind: tenant.kind };
  }

  // Checks an access token by signature and claims alone, without MongoDB.
  // A logout, a disabled account or a membership change after it was issued
  // is not seen; tokens live ACCESS_TOKEN_TTL_SECONDS for that reason.
  verifyToken(accessToken: unknown, now = new Date()): TokenCaller {
    try {
      const verified = verifyAccessToken(this.config.auth, accessToken, now);
      return {
        userId: verified.userId,
        sessionId: verified.sessionId,
        ...(verified.tenant ? { tenant: verified.tenant } : {}),
      };
    } catch (error) {
      if (error instanceof InvalidAccessTokenError)
        throw new InvalidSessionError();
      throw error;
    }
  }

  // Verifies an access token and that its session and account are still
  // active. Any failure is the same InvalidSessionError: there is no other
  // way to authenticate and nothing to fall back to.
  async authenticate(
    accessToken: unknown,
    now = new Date(),
  ): Promise<AuthenticatedCaller> {
    const verified = this.verifyToken(accessToken, now);
    // One round trip; the session's owner is compared once both are back.
    const [session, user] = await Promise.all([
      this.sessions().findOne({ _id: verified.sessionId }),
      this.users.findById(verified.userId),
    ]);
    if (
      !session ||
      !isLive(session, now) ||
      !session.userId.equals(verified.userId)
    )
      throw new InvalidSessionError();
    if (user?.status !== "active") throw new InvalidSessionError();
    return { ...verified, user };
  }

  private async revoke(
    sessionId: ObjectId,
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<void> {
    await this.sessions().updateOne(
      { _id: sessionId, revokedAt: { $exists: false } },
      { $set: { revokedAt: now, revokedReason: reason } },
    );
  }

  private issue(
    session: SessionDoc,
    secret: string,
    now: Date,
    tenant?: AccessTokenTenant,
  ): IssuedSession {
    const access = signAccessToken(
      this.config.auth,
      { userId: session.userId, sessionId: session._id, tenant },
      now,
    );
    return {
      userId: session.userId,
      sessionId: session._id,
      ...(tenant ? { tenant } : {}),
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshCredential: formatRefreshCredential({
        sessionId: session._id,
        secret,
      }),
      refreshExpiresAt: session.idleExpiresAt,
    };
  }
}

function idleExpiry(absoluteExpiresAt: Date, now: Date): Date {
  return new Date(
    Math.min(now.getTime() + SESSION_IDLE_TTL_MS, absoluteExpiresAt.getTime()),
  );
}
