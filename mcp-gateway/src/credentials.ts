import { ObjectId, type Collection, type MongoClient } from "mongodb";
import {
  openTokens,
  sealTokens,
  TokenDecryptError,
  type ConnectorTokens,
  type SealedSecret,
  type TokenKeys,
} from "./token-crypto";

// A usable access token for a member's connection, refreshed first when it is
// near expiry. Refreshes are single-flight: within this process through
// `refreshing`, across processes through the row's `refreshLease`. Providers
// that rotate refresh tokens (GitHub) invalidate the old one on use, so two
// refreshes at once would leave one holder with a dead token.
//
// The lease protocol is platform-next's (connectors.service.ts refreshShared /
// refreshHeld): same field, same claim conditions, same conditional write.
// Until the cutover both services refresh the same rows, so they must never
// disagree on who holds a refresh. The provider call itself is injected
// (`refresh`; refresh-grant.ts in production).

const CONNECTIONS = "mcp_connections";
// Refresh when the token expires sooner than this (platform-next's
// REFRESH_MARGIN_MS). The gateway refreshes at call time, so this only needs
// to cover one call, but sharing the value keeps both services' rows calm.
const DEFAULT_MARGIN_MS = 15 * 60_000;
// Longer than a token request's own timeout, so a live holder never loses it.
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 200;
const DEFAULT_WAIT_MS = 15_000;

export interface ConnectionRow {
  _id: ObjectId;
  tenantId: ObjectId;
  ownerId: ObjectId;
  connectorId: ObjectId;
  slug: string;
  status: string;
  secret: SealedSecret;
  accessExpiresAt?: Date;
  refreshExpiresAt?: Date;
  refreshLease?: { id: ObjectId; until: Date };
  revision: number;
}

export interface TokenGrant {
  tokens: ConnectorTokens;
  accessExpiresInSec?: number;
  refreshExpiresInSec?: number;
}

// The provider refused the refresh token: revoked, already used or expired.
// Only a new sign-in helps. Any other error from `refresh` means the provider
// couldn't be reached, and the stored tokens are still the right ones.
export class RefreshRefusedError extends Error {
  constructor() {
    super("The provider refused the refresh token.");
    this.name = "RefreshRefusedError";
  }
}

export interface RefreshRequest {
  readonly connectorId: ObjectId;
  readonly slug: string;
  readonly refreshToken: string;
}

export type UsableTokens =
  | { readonly ok: true; readonly tokens: ConnectorTokens }
  | { readonly ok: false; readonly reason: "needs_reconnect" | "unavailable" };

export interface CredentialOptions {
  readonly client: MongoClient;
  readonly keys: TokenKeys;
  readonly refresh: (request: RefreshRequest) => Promise<TokenGrant>;
  // Fields never include a token.
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
  readonly marginMs?: number;
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly waitMs?: number;
}

export function createCredentials(options: CredentialOptions) {
  const { client, keys } = options;
  const log = options.log ?? (() => {});
  const marginMs = options.marginMs ?? DEFAULT_MARGIN_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const refreshing = new Map<string, Promise<UsableTokens>>();

  const connections = (dbName: string): Collection<ConnectionRow> =>
    client.db(dbName).collection<ConnectionRow>(CONNECTIONS);
  const needsRefresh = (row: ConnectionRow, now: number) =>
    row.accessExpiresAt !== undefined &&
    row.accessExpiresAt.getTime() - now < marginMs;
  const open = (row: ConnectionRow) => openTokens(keys, aadOf(row), row.secret);

  function usableTokens(
    dbName: string,
    row: ConnectionRow,
  ): Promise<UsableTokens> {
    if (!needsRefresh(row, Date.now())) {
      try {
        return Promise.resolve({ ok: true, tokens: open(row) });
      } catch (error) {
        if (!(error instanceof TokenDecryptError)) throw error;
        return unreadable(dbName, row);
      }
    }
    const key = `${dbName}/${row._id.toHexString()}`;
    let pending = refreshing.get(key);
    if (!pending) {
      pending = refreshShared(dbName, row)
        .catch((error: unknown) => {
          if (error instanceof TokenDecryptError)
            return unreadable(dbName, row);
          throw error;
        })
        .finally(() => refreshing.delete(key));
      refreshing.set(key, pending);
    }
    return pending;
  }

  async function refreshShared(
    dbName: string,
    stale: ConnectionRow,
  ): Promise<UsableTokens> {
    const rows = connections(dbName);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = new Date();
      // Take the lease, unless another holder's is still live.
      const leaseId = new ObjectId();
      const claimed = await rows.findOneAndUpdate(
        {
          _id: stale._id,
          status: "active",
          $or: [
            { refreshLease: { $exists: false } },
            { "refreshLease.until": { $lte: now } },
          ],
        },
        {
          $set: {
            refreshLease: {
              id: leaseId,
              until: new Date(now.getTime() + leaseMs),
            },
          },
        },
        { returnDocument: "after" },
      );
      if (claimed) {
        // Someone else refreshed between our read and the claim.
        if (!needsRefresh(claimed, now.getTime())) {
          await releaseLease(dbName, claimed._id, leaseId);
          return { ok: true, tokens: open(claimed) };
        }
        return refreshHeld(dbName, claimed, leaseId);
      }
      // Another process holds the lease, or the row changed state.
      const current = await rows.findOne({ _id: stale._id });
      if (!current || current.status !== "active")
        return { ok: false, reason: "needs_reconnect" };
      if (!needsRefresh(current, Date.now()))
        return { ok: true, tokens: open(current) };
      if (Date.now() >= deadline) return fallback(current);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // Refreshes while holding the lease. The write requires the lease to still
  // be ours, so a holder that overran it can't overwrite a newer refresh.
  async function refreshHeld(
    dbName: string,
    row: ConnectionRow,
    leaseId: ObjectId,
  ): Promise<UsableTokens> {
    const current = open(row);
    const now = new Date();
    if (
      !current.refreshToken ||
      (row.refreshExpiresAt !== undefined &&
        row.refreshExpiresAt.getTime() <= now.getTime())
    ) {
      // Nothing to refresh with: a still-valid token is used to the end of
      // its life; an expired one means the member signs in again.
      await releaseLease(dbName, row._id, leaseId);
      if (!isExpired(row, now.getTime())) return { ok: true, tokens: current };
      await markNeedsReconnect(dbName, row._id, now, "token_expired");
      return { ok: false, reason: "needs_reconnect" };
    }

    let grant: TokenGrant;
    try {
      grant = await options.refresh({
        connectorId: row.connectorId,
        slug: row.slug,
        refreshToken: current.refreshToken,
      });
    } catch (error) {
      if (error instanceof RefreshRefusedError) {
        log("refresh_refused", { slug: row.slug });
        await markNeedsReconnect(dbName, row._id, now, "refresh_refused");
        return { ok: false, reason: "needs_reconnect" };
      }
      log("refresh_unavailable", {
        slug: row.slug,
        error: error instanceof Error ? error.name : "unknown",
      });
      await releaseLease(dbName, row._id, leaseId);
      return fallback(row);
    }

    // A provider that doesn't rotate refresh tokens omits a new one; keep
    // the one that still works.
    const refreshToken = grant.tokens.refreshToken ?? current.refreshToken;
    const tokens: ConnectorTokens = {
      accessToken: grant.tokens.accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
    const stored = new Date();
    const set: Record<string, unknown> = {
      secret: sealTokens(keys, aadOf(row), tokens),
      lastRefreshedAt: stored,
      updatedAt: stored,
    };
    if (grant.accessExpiresInSec !== undefined)
      set.accessExpiresAt = new Date(
        stored.getTime() + grant.accessExpiresInSec * 1000,
      );
    if (grant.refreshExpiresInSec !== undefined)
      set.refreshExpiresAt = new Date(
        stored.getTime() + grant.refreshExpiresInSec * 1000,
      );
    const written = await connections(dbName).updateOne(
      { _id: row._id, "refreshLease.id": leaseId },
      {
        $set: set,
        $unset: {
          refreshLease: "",
          lastError: "",
          ...(grant.accessExpiresInSec === undefined
            ? { accessExpiresAt: "" }
            : {}),
        },
        $inc: { revision: 1 },
      },
    );
    // The lease was lost (overrun, or the member reconnected). The fresh
    // tokens are valid either way; the row's own are the record.
    if (written.matchedCount !== 1)
      log("refresh_lease_lost", { slug: row.slug });
    else log("token_refreshed", { slug: row.slug });
    return { ok: true, tokens };
  }

  // When a refresh couldn't happen: a token that hasn't expired is still
  // usable with less margin; an expired one can't be sent.
  function fallback(row: ConnectionRow): UsableTokens {
    if (isExpired(row, Date.now())) return { ok: false, reason: "unavailable" };
    return { ok: true, tokens: open(row) };
  }

  // A stored token no configured key opens (its key retired too early): the
  // member signs in again rather than every call failing.
  async function unreadable(
    dbName: string,
    row: ConnectionRow,
  ): Promise<UsableTokens> {
    log("token_unreadable", { slug: row.slug, keyId: row.secret.keyId });
    await markNeedsReconnect(dbName, row._id, new Date(), "token_unreadable");
    return { ok: false, reason: "needs_reconnect" };
  }

  async function releaseLease(
    dbName: string,
    id: ObjectId,
    leaseId: ObjectId,
  ): Promise<void> {
    await connections(dbName).updateOne(
      { _id: id, "refreshLease.id": leaseId },
      { $unset: { refreshLease: "" } },
    );
  }

  async function markNeedsReconnect(
    dbName: string,
    id: ObjectId,
    now: Date,
    code: string,
  ): Promise<void> {
    await connections(dbName).updateOne(
      { _id: id },
      {
        $set: {
          status: "needs_reconnect",
          lastError: { code, at: now },
          updatedAt: now,
        },
        $unset: { refreshLease: "" },
        $inc: { revision: 1 },
      },
    );
  }

  // The provider answered 401 to the token `row` holds. platform-next's
  // tokenRejected: a refreshable connection is marked expired so the next
  // usableTokens renews it (a refresh the provider then refuses asks for a
  // new sign-in); one with nothing to refresh with needs a new sign-in now.
  // The write matches the revision read, so a refresh that landed since
  // keeps its tokens. Returns the row as it now stands, or null when it is
  // gone or no longer active.
  async function tokenRejected(
    dbName: string,
    row: ConnectionRow,
  ): Promise<ConnectionRow | null> {
    let refreshable = false;
    try {
      refreshable = open(row).refreshToken !== undefined;
    } catch {
      refreshable = false;
    }
    const now = new Date();
    if (!refreshable)
      await markNeedsReconnect(dbName, row._id, now, "unauthorized");
    else
      await connections(dbName).updateOne(
        { _id: row._id, revision: row.revision },
        {
          $set: { accessExpiresAt: now, updatedAt: now },
          $inc: { revision: 1 },
        },
      );
    const current = await connections(dbName).findOne({ _id: row._id });
    return current?.status === "active" ? current : null;
  }

  // A token renewed moments ago was refused too: only a new sign-in helps.
  async function needsReconnect(
    dbName: string,
    row: ConnectionRow,
  ): Promise<void> {
    await markNeedsReconnect(dbName, row._id, new Date(), "unauthorized");
  }

  return { usableTokens, tokenRejected, needsReconnect };
}

export type Credentials = ReturnType<typeof createCredentials>;

function isExpired(row: ConnectionRow, now: number): boolean {
  return (
    row.accessExpiresAt !== undefined && row.accessExpiresAt.getTime() <= now
  );
}

function aadOf(row: ConnectionRow) {
  return {
    tenantId: row.tenantId.toHexString(),
    ownerId: row.ownerId.toHexString(),
    connectorId: row.connectorId.toHexString(),
  };
}
