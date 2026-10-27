import { Inject, Injectable, Logger } from "@nestjs/common";
import { ObjectId, type Collection } from "mongodb";
import { DomainError } from "../../common/domain-error";
import { timed } from "../../common/http/server-timing";
import { TtlCache } from "../../common/ttl-cache";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import type { ConnectorsConfig } from "../../config/connectors-config";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import { MembershipsService } from "../memberships/memberships.service";
import {
  ClientSecretResolver,
  ClientSecretUnavailableError,
} from "./client-secret.resolver";
import {
  CONNECTIONS_COLLECTION,
  SECRET_PROJECTION,
  type ConnectionStatus,
  type ConnectionView,
  type McpConnectionDoc,
} from "./connection";
import type { ConnectorDoc } from "./connector";
import {
  codeChallengeOf,
  flowSecret,
  sealConnectorFlow,
  type ConnectorFlow,
} from "./connector-oauth-flow";
import { ConnectorsCatalogService } from "./connectors-catalog.service";
import type { RunNetworkConnector } from "../network/network-policy";
import type { McpServerSpec } from "./mcp-server-spec";
import {
  verifyConnection,
  VerifyFailedError,
  VerifyUnauthorizedError,
  type VerifyResult,
} from "./mcp-verify";
import {
  discoverEndpoints,
  DiscoveryUnavailableError,
  type DiscoveredEndpoints,
  type FetchLike,
} from "./oauth-discovery";
import {
  exchangeCode,
  ExchangeFailedError,
  refreshGrant,
  revokeGrant,
  type TokenGrant,
} from "./oauth-exchange";
import {
  openTokens,
  sealTokens,
  TokenDecryptError,
  type ConnectorTokens,
  type SecretAad,
} from "./token-crypto";

// Discovery is small and changes only when the product team edits a connector
// (a new revision), so a short per-revision cache avoids re-probing the server
// on every connect.
const DISCOVERY_CACHE_TTL_MS = 10 * 60_000;
// A run starts only with a token that stays valid at least this long, so a
// reply with several tool calls never meets an expired token midway. Codex
// cannot refresh a token it was handed; the platform refreshes at run start.
export const REFRESH_MARGIN_MS = 15 * 60_000;
// How long one process may hold a connection's refresh. Longer than the token
// request's own 10 s timeout, so a live holder never loses it.
const REFRESH_LEASE_MS = 30_000;
// A run waiting for another process's refresh rereads the row this often, for
// at most this long.
const REFRESH_POLL_MS = 200;
const REFRESH_WAIT_MS = 15_000;
// lastUsedAt is a coarse signal; writing it on every run would add a write.
const LAST_USED_MS = 60 * 60_000;

// What a token refresh needs from outside the row.
type RefreshInputs = [DiscoveredEndpoints, string];

// The outcome of getting a usable access token for a stored connection.
type UsableTokens =
  | { ok: true; tokens: ConnectorTokens }
  | { ok: false; reason: "needs_reconnect" | "unavailable" };

// The connectors feature is off (no token keys configured).
export class ConnectorsDisabledError extends DomainError {
  constructor() {
    super(
      "CONNECTORS_NOT_CONFIGURED",
      "Directory connectors are not configured on this server.",
    );
  }
}

// What a connect produced: where to send the browser, and the sealed cookie to
// set (the controller owns the HTTP response and cookie scope).
export interface ConnectStart {
  authorizeUrl: string;
  sealedCookie: string;
  // The authorization-server issuer, so the callback can check iss without a
  // second discovery call when the cookie does not carry it.
  issuer: string;
  issParameterSupported: boolean;
}

// A safe code the callback redirects with. Never provider text.
export type CallbackErrorCode =
  | "cancelled"
  | "state_invalid"
  | "expired"
  | "not_member"
  | "exchange_failed"
  | "verify_failed"
  | "permissions_missing"
  | "unavailable";

// A connector a run cannot use yet. `available: false` means the product team
// disabled it, so connecting cannot help.
export interface MissingConnector {
  slug: string;
  displayName: string;
  available: boolean;
}

// `network`: the connections whose connector has egress data, for the run's
// sandbox network policy (network-policy.ts), with the same token as the MCP
// spec. Only connections already in `specs`: active, the chat owner's own.
export type RunSpecsResult =
  | { ok: true; specs: McpServerSpec[]; network: RunNetworkConnector[] }
  | { ok: false; missing: MissingConnector[] };

// One connector a run attaches: its catalog ID and the chat's access choice.
// A bare ObjectId means read_write (what a chat snapshotted before write
// access existed, and what the recovery path passes).
export type RunConnectorRef =
  ObjectId | { connectorId: ObjectId; access?: "read_only" };

// The per-chat approvals a run carries: tools the member allowed for this
// chat, forwarded to the adapter as approvedTools (keyed by connector slug).
export interface RunToolApproval {
  connector: string;
  tool: string;
}

export interface RunSpecsOptions {
  // Tools the member allowed for this whole chat (chat.toolApprovals), sent as
  // approvedTools per connector when non-empty.
  toolApprovals?: readonly RunToolApproval[];
  fetchImpl?: FetchLike;
}

function refIdOf(ref: RunConnectorRef): ObjectId {
  return ref instanceof ObjectId ? ref : ref.connectorId;
}

function refReadOnly(ref: RunConnectorRef): boolean {
  return !(ref instanceof ObjectId) && ref.access === "read_only";
}

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger("Connectors");
  // One discovery cache per connector revision key.
  private readonly discoveryCaches = new Map<
    string,
    TtlCache<DiscoveredEndpoints>
  >();
  // Refreshes in flight in this process, by database and connection, so runs
  // of one user starting together share one refresh (and one lease wait).
  private readonly refreshing = new Map<string, Promise<UsableTokens>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConnectorsCatalogService)
    private readonly catalog: ConnectorsCatalogService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
    @Inject(ClientSecretResolver)
    private readonly secrets: ClientSecretResolver,
  ) {}

  // The connectors config, or a disabled error. Every entry point calls this
  // first so a misconfigured server answers 503 instead of half-working.
  private requireConfig(): ConnectorsConfig {
    if (!this.config.connectors) throw new ConnectorsDisabledError();
    return this.config.connectors;
  }

  // True when the feature is on; the controller uses it to gate routes with a
  // clear 503 before any work.
  get enabled(): boolean {
    return this.config.connectors !== undefined;
  }

  private connections(dbName: string): Collection<McpConnectionDoc> {
    return this.database
      .tenantDb(dbName)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION);
  }

  private discoveryCache(
    connector: ConnectorDoc,
    allowLoopback: boolean,
    fetchImpl?: FetchLike,
  ): TtlCache<DiscoveredEndpoints> {
    const key = `${connector._id.toHexString()}:${connector.revision}`;
    let cache = this.discoveryCaches.get(key);
    if (!cache) {
      cache = new TtlCache<DiscoveredEndpoints>(
        () =>
          discoverEndpoints({
            connectorUrl: connector.url,
            allowLoopback,
            ...(fetchImpl ? { fetchImpl } : {}),
          }),
        DISCOVERY_CACHE_TTL_MS,
      );
      this.discoveryCaches.set(key, cache);
    }
    return cache;
  }

  // Starts a connect: discovers endpoints, builds the PKCE challenge and the
  // sealed flow cookie, and returns the authorize URL. Writes nothing. The
  // dbName is the one the tenant guard resolved for this request, carried in
  // the cookie so the callback writes to the right database.
  async startConnect(
    slug: string,
    tenantId: ObjectId,
    userId: ObjectId,
    dbName: string,
    fetchImpl?: FetchLike,
  ): Promise<ConnectStart> {
    const config = this.requireConfig();
    const connector = await this.catalog.findEnabledBySlug(slug);
    if (!connector)
      throw new DomainError("NOT_FOUND", "No such connector is available.");

    const endpoints = await this.discover(connector, config, fetchImpl);
    const flow: ConnectorFlow = {
      state: flowSecret(),
      codeVerifier: flowSecret(),
      connectorId: connector._id.toHexString(),
      connectorRevision: connector.revision,
      slug: connector.slug,
      tenantId: tenantId.toHexString(),
      userId: userId.toHexString(),
      dbName,
      startedAt: Math.floor(Date.now() / 1000),
    };
    const authorize = new URL(endpoints.authorizationEndpoint);
    const params = new URLSearchParams({
      client_id: connector.auth.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      state: flow.state,
      code_challenge: codeChallengeOf(flow.codeVerifier),
      code_challenge_method: "S256",
      ...(connector.auth.scopes.length > 0
        ? { scope: connector.auth.scopes.join(" ") }
        : {}),
    });
    // Allowlisted provider extras (parseConnectorSpec fixes their names and
    // values), added after the core parameters and never replacing one.
    for (const [name, value] of Object.entries(
      connector.auth.authorizeParams ?? {},
    ))
      if (!params.has(name)) params.set(name, value);
    authorize.search = params.toString();
    return {
      authorizeUrl: authorize.href,
      sealedCookie: sealConnectorFlow(config, flow),
      issuer: endpoints.issuer,
      issParameterSupported: endpoints.issParameterSupported,
    };
  }

  // Discovers the authorization-server endpoints for a callback, so the
  // controller can check iss. Returns undefined when discovery is unavailable
  // (the callback then redirects with `unavailable`).
  async callbackEndpoints(
    connectorId: ObjectId,
    fetchImpl?: FetchLike,
  ): Promise<DiscoveredEndpoints | undefined> {
    const config = this.requireConfig();
    const connector = await this.catalog.findById(connectorId);
    if (!connector || !connector.enabled) return undefined;
    try {
      return await this.discover(connector, config, fetchImpl);
    } catch {
      return undefined;
    }
  }

  private async discover(
    connector: ConnectorDoc,
    config: ConnectorsConfig,
    fetchImpl?: FetchLike,
  ): Promise<DiscoveredEndpoints> {
    try {
      return await this.discoveryCache(
        connector,
        config.allowLoopback,
        fetchImpl,
      ).get();
    } catch (error) {
      if (error instanceof DiscoveryUnavailableError)
        throw new DomainError(
          "UNAVAILABLE",
          "The connector is temporarily unavailable. Try again shortly.",
        );
      // A DiscoveryError is a misconfigured connector, not the user's fault.
      this.logger.error({
        message: "connector discovery failed",
        slug: connector.slug,
        error: error instanceof Error ? error.name : "unknown",
      });
      throw new DomainError(
        "UNAVAILABLE",
        "The connector is not available right now.",
      );
    }
  }

  // Finishes a connect that has already passed cookie, state, iss and
  // membership checks in the controller. Exchanges the code, verifies the
  // connection, and on success stores one encrypted row. Returns the slug for
  // the redirect, or a safe error code. Nothing is stored on any failure.
  async completeConnect(args: {
    flow: ConnectorFlow;
    code: string;
    fetchImpl?: FetchLike;
  }): Promise<
    | { ok: true; slug: string; status: ConnectionStatus }
    | { ok: false; code: CallbackErrorCode }
  > {
    const config = this.requireConfig();
    const connectorId = ObjectId.createFromHexString(args.flow.connectorId);
    const connector = await this.catalog.findById(connectorId);
    if (!connector || !connector.enabled)
      return { ok: false, code: "unavailable" };

    let endpoints: DiscoveredEndpoints;
    let clientSecret: string;
    try {
      endpoints = await this.discoveryCache(
        connector,
        config.allowLoopback,
        args.fetchImpl,
      ).get();
      clientSecret = await this.secrets.resolve(connector.auth.clientSecret);
    } catch (error) {
      if (error instanceof ClientSecretUnavailableError)
        this.logger.error({
          message: "connector client secret unavailable",
          slug: connector.slug,
        });
      return { ok: false, code: "unavailable" };
    }

    const grant = await (async () => {
      try {
        return await exchangeCode({
          tokenEndpoint: endpoints.tokenEndpoint,
          code: args.code,
          codeVerifier: args.flow.codeVerifier,
          clientId: connector.auth.clientId,
          clientSecret,
          redirectUri: config.redirectUri,
          ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
        });
      } catch (error) {
        if (error instanceof ExchangeFailedError)
          return "exchange_failed" as const;
        return "unavailable" as const;
      }
    })();
    if (typeof grant === "string") return { ok: false, code: grant };
    const tokens = grant.tokens;
    // A provider with granular consent may grant fewer scopes than asked.
    // Storing that grant would fail later on the first tool call, so refuse it
    // now and let the member connect again with everything ticked.
    if (missingScopes(connector.auth.scopes, grant.grantedScopes))
      return { ok: false, code: "permissions_missing" };

    // Verify with the fresh token. A 401 (or any verify failure) means store
    // nothing.
    let verification: VerifyResult;
    try {
      verification = await verifyConnection({
        url: connector.url,
        accessToken: tokens.accessToken,
        fixedHeaders: connector.fixedHeaders,
        ...(connector.auth.accountTool
          ? { accountTool: connector.auth.accountTool }
          : {}),
        ...userinfoOf(connector, endpoints),
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      });
    } catch (error) {
      if (
        error instanceof VerifyUnauthorizedError ||
        error instanceof VerifyFailedError
      )
        return { ok: false, code: "verify_failed" };
      return { ok: false, code: "unavailable" };
    }

    const tenantId = ObjectId.createFromHexString(args.flow.tenantId);
    const ownerId = ObjectId.createFromHexString(args.flow.userId);
    const sealed = sealTokens(
      config,
      aadFor(tenantId, ownerId, connectorId),
      tokens,
    );
    const now = new Date();
    const lifetimes = lifetimesOf(grant, now);
    const set = {
      slug: connector.slug,
      tenantId,
      status: "active" as const,
      secret: sealed,
      toolCount: verification.toolCount,
      lastVerifiedAt: now,
      updatedAt: now,
      ...lifetimes.set,
      ...(verification.account ? { account: verification.account } : {}),
    };
    // A reconnect replaces everything about the old grant, including a
    // refresh lease another process may still hold for it.
    const unset: Record<string, ""> = {
      lastError: "",
      refreshLease: "",
      ...lifetimes.unset,
    };
    try {
      await this.connections(args.flow.dbName).findOneAndUpdate(
        { ownerId, connectorId },
        {
          $set: set,
          $unset: unset,
          $setOnInsert: {
            _id: new ObjectId(),
            connectorId,
            ownerId,
            createdAt: now,
          },
          $inc: { revision: 1 },
        },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      // Two racing callbacks: the unique index means one wins; the loser
      // retries once and upserts onto the same row.
      if (!isDuplicateKeyError(error)) throw error;
      await this.connections(args.flow.dbName).updateOne(
        { ownerId, connectorId },
        { $set: set, $unset: unset, $inc: { revision: 1 } },
      );
    }
    return { ok: true, slug: connector.slug, status: "active" };
  }

  // The enabled catalog merged with the caller's connection status. No auth
  // secrets or client ids: the controller maps to ConnectorView.
  async listForUser(
    tenantId: ObjectId,
    userId: ObjectId,
    dbName: string,
  ): Promise<Array<{ connector: ConnectorDoc; connection: ConnectionView }>> {
    this.requireConfig();
    const connectors = await this.catalog.enabledConnectors();
    if (connectors.length === 0) return [];
    const ids = connectors.map((c) => c._id);
    const rows = await this.connections(dbName)
      .find(
        { ownerId: userId, connectorId: { $in: ids } },
        { projection: SECRET_PROJECTION },
      )
      .toArray();
    const byConnector = new Map(
      rows.map((row) => [row.connectorId.toHexString(), row]),
    );
    return connectors.map((connector) => ({
      connector,
      connection: viewOf(byConnector.get(connector._id.toHexString())),
    }));
  }

  // Re-runs the MCP verify with the stored token and updates the status. A 401
  // moves the connection to needs_reconnect.
  async verifyStored(
    slug: string,
    tenantId: ObjectId,
    userId: ObjectId,
    dbName: string,
    fetchImpl?: FetchLike,
  ): Promise<ConnectionView> {
    const config = this.requireConfig();
    const connector = await this.catalog.findEnabledBySlug(slug);
    if (!connector)
      throw new DomainError("NOT_FOUND", "No such connector is available.");
    const row = await this.connections(dbName).findOne({
      ownerId: userId,
      connectorId: connector._id,
    });
    if (!row)
      throw new DomainError("NOT_FOUND", "You have no such connection.");
    if (row.status !== "active") return viewOf(row);

    const usable = await this.usableTokens(dbName, connector, row, fetchImpl);
    if (!usable.ok) {
      if (usable.reason === "unavailable")
        throw new DomainError(
          "UNAVAILABLE",
          "The connector could not be reached. Try again shortly.",
        );
      return viewOf(
        (await this.connections(dbName).findOne(
          { _id: row._id },
          { projection: SECRET_PROJECTION },
        )) ?? undefined,
      );
    }
    const tokens = usable.tokens;
    const now = new Date();
    // Only a userinfo account needs the discovered endpoints (cached).
    const endpoints = connector.auth.accountUserinfo
      ? await this.discover(connector, config, fetchImpl)
      : undefined;
    try {
      const verification = await verifyConnection({
        url: connector.url,
        accessToken: tokens.accessToken,
        fixedHeaders: connector.fixedHeaders,
        ...(connector.auth.accountTool
          ? { accountTool: connector.auth.accountTool }
          : {}),
        ...(endpoints ? userinfoOf(connector, endpoints) : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      const updated = await this.connections(dbName).findOneAndUpdate(
        { _id: row._id },
        {
          $set: {
            status: "active",
            toolCount: verification.toolCount,
            lastVerifiedAt: now,
            updatedAt: now,
            ...(verification.account ? { account: verification.account } : {}),
          },
          $unset: { lastError: "" },
          $inc: { revision: 1 },
        },
        { returnDocument: "after", projection: SECRET_PROJECTION },
      );
      return viewOf(updated ?? undefined);
    } catch (error) {
      if (error instanceof VerifyUnauthorizedError)
        return viewOf(await this.markNeedsReconnect(dbName, row._id, now));
      if (error instanceof VerifyFailedError)
        throw new DomainError(
          "UNAVAILABLE",
          "The connector could not be reached. Try again shortly.",
        );
      throw error;
    }
  }

  // Revokes the grant at the provider (best effort), then deletes the record.
  // Returns whether revocation succeeded; the record is deleted either way.
  async disconnect(
    slug: string,
    tenantId: ObjectId,
    userId: ObjectId,
    dbName: string,
    fetchImpl?: FetchLike,
  ): Promise<{ revoked: boolean }> {
    const config = this.requireConfig();
    const connector = await this.catalog.findEnabledBySlug(slug);
    if (!connector)
      throw new DomainError("NOT_FOUND", "No such connector is available.");
    const row = await this.connections(dbName).findOne({
      ownerId: userId,
      connectorId: connector._id,
    });
    if (!row)
      throw new DomainError("NOT_FOUND", "You have no such connection.");

    let revoked = false;
    if (connector.auth.revoke) {
      try {
        // An expired access token cannot revoke its grant; refresh first when
        // it can be refreshed, else try the stored one.
        const usable =
          row.status === "active"
            ? await this.usableTokens(dbName, connector, row, fetchImpl)
            : undefined;
        const tokens = usable?.ok
          ? usable.tokens
          : openTokens(
              config,
              aadFor(tenantId, userId, connector._id),
              row.secret,
            );
        const clientSecret = await this.secrets.resolve(
          connector.auth.clientSecret,
        );
        revoked = await revokeGrant({
          revoke: connector.auth.revoke,
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          clientId: connector.auth.clientId,
          clientSecret,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      } catch {
        revoked = false;
      }
      if (!revoked)
        this.logger.warn({
          message: "connector revoke did not succeed; deleting record anyway",
          slug: connector.slug,
          code: "revoke_failed",
        });
    }
    await this.connections(dbName).deleteOne({ _id: row._id });
    return { revoked };
  }

  // The executor's view: the MCP server specs for the connectors a run
  // attaches, with each token refreshed first when it is near expiry. One
  // tenant query (connections, $in); the catalog comes from its cache. A
  // connector that is disabled, not connected, or whose connection needs a
  // new sign-in is reported in `missing`; a refresh that cannot reach the
  // provider while the token has already expired throws UNAVAILABLE.
  //
  // enabledTools = allowedTools, minus writeTools when the chat's connector is
  // read_only. approvedTools = the chat's toolApprovals for that connector,
  // only when non-empty (the adapter answers those requests itself).
  async runSpecs(
    dbName: string,
    userId: ObjectId,
    connectors: readonly RunConnectorRef[],
    options: RunSpecsOptions = {},
  ): Promise<RunSpecsResult> {
    this.requireConfig();
    if (connectors.length === 0) return { ok: true, specs: [], network: [] };
    const fetchImpl = options.fetchImpl;
    const connectorIds = connectors.map(refIdOf);
    const [enabled, rows] = await Promise.all([
      this.catalog.enabledConnectors(),
      this.connections(dbName)
        .find({ ownerId: userId, connectorId: { $in: connectorIds } })
        .toArray(),
    ]);
    const catalog = new Map(enabled.map((c) => [c._id.toHexString(), c]));
    const byConnector = new Map(
      rows.map((row) => [row.connectorId.toHexString(), row]),
    );
    const missing: MissingConnector[] = [];
    const ready: Array<{
      connector: ConnectorDoc;
      row: McpConnectionDoc;
      readOnly: boolean;
    }> = [];
    for (const ref of connectors) {
      const id = refIdOf(ref).toHexString();
      const connector = catalog.get(id);
      const row = byConnector.get(id);
      if (!connector) {
        // Disabled by the product team: nothing the member can fix, but the
        // chat cannot run with the tools its prompt describes.
        missing.push({
          slug: row?.slug ?? id,
          displayName: row?.slug ?? "A connector",
          available: false,
        });
        continue;
      }
      if (!row || row.status !== "active") {
        missing.push(missingOf(connector));
        continue;
      }
      ready.push({ connector, row, readOnly: refReadOnly(ref) });
    }
    const usable = await Promise.all(
      ready.map(({ connector, row }) =>
        this.usableTokens(dbName, connector, row, fetchImpl),
      ),
    );
    // The member's per-chat approvals, grouped by connector slug.
    const approvedByConnector = new Map<string, string[]>();
    for (const approval of options.toolApprovals ?? []) {
      const tools = approvedByConnector.get(approval.connector) ?? [];
      tools.push(approval.tool);
      approvedByConnector.set(approval.connector, tools);
    }
    const specs: McpServerSpec[] = [];
    const network: RunNetworkConnector[] = [];
    for (let i = 0; i < ready.length; i++) {
      const { connector, row, readOnly } = ready[i]!;
      const result = usable[i]!;
      if (!result.ok) {
        if (result.reason === "unavailable")
          throw new DomainError(
            "UNAVAILABLE",
            `${connector.displayName} could not be reached to renew your connection. Try again shortly.`,
          );
        missing.push(missingOf(connector));
        continue;
      }
      const spec: McpServerSpec = {
        name: connector.slug,
        url: connector.url,
        headers: {
          ...connector.fixedHeaders,
          Authorization: `Bearer ${result.tokens.accessToken}`,
        },
        toolTimeoutSec: connector.toolTimeoutSec,
        startupTimeoutSec: connector.startupTimeoutSec,
      };
      const enabledTools = enabledToolsOf(connector, readOnly);
      if (enabledTools !== undefined) spec.enabledTools = enabledTools;
      const critical = connector.criticalTools ?? [];
      // A critical tool is never allowed for the chat.
      const approved = approvedByConnector
        .get(connector.slug)
        ?.filter((tool) => !critical.includes(tool));
      if (approved && approved.length > 0) spec.approvedTools = approved;
      if (critical.length > 0) spec.criticalTools = [...critical];
      specs.push(spec);
      if (connector.egress)
        network.push(
          networkConnectorOf(
            connector,
            row,
            readOnly,
            result.tokens.accessToken,
          ),
        );
    }
    if (missing.length > 0) return { ok: false, missing };
    this.touch(
      dbName,
      ready.map(({ row }) => row),
    );
    return { ok: true, specs, network };
  }

  // Records use at most once an hour per connection, off the request path.
  private touch(dbName: string, rows: readonly McpConnectionDoc[]): void {
    const now = Date.now();
    const stale = rows
      .filter(
        (row) =>
          !row.lastUsedAt || now - row.lastUsedAt.getTime() >= LAST_USED_MS,
      )
      .map((row) => row._id);
    if (stale.length === 0) return;
    void this.connections(dbName)
      .updateMany(
        {
          _id: { $in: stale },
          $or: [
            { lastUsedAt: { $exists: false } },
            { lastUsedAt: { $lt: new Date(now - LAST_USED_MS) } },
          ],
        },
        { $set: { lastUsedAt: new Date(now) } },
      )
      .catch(() => undefined);
  }

  // An access token that is valid for at least REFRESH_MARGIN_MS, refreshing
  // it first when it expires sooner. A connection without an expiry is used
  // as stored. Refreshes are single-flight: within this process through
  // `refreshing`, across processes through the row's refresh lease.
  private usableTokens(
    dbName: string,
    connector: ConnectorDoc,
    row: McpConnectionDoc,
    fetchImpl?: FetchLike,
  ): Promise<UsableTokens> {
    const config = this.requireConfig();
    if (!needsRefresh(row, Date.now())) {
      try {
        return Promise.resolve({ ok: true, tokens: this.open(config, row) });
      } catch (error) {
        if (!(error instanceof TokenDecryptError)) throw error;
        return this.unreadable(dbName, connector, row);
      }
    }
    const key = `${dbName}/${row._id.toHexString()}`;
    let pending = this.refreshing.get(key);
    if (!pending) {
      pending = timed("token-refresh", () =>
        this.refreshShared(dbName, connector, row, fetchImpl),
      )
        .catch((error: unknown) => {
          if (error instanceof TokenDecryptError)
            return this.unreadable(dbName, connector, row);
          throw error;
        })
        .finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, pending);
    }
    return pending;
  }

  private async refreshShared(
    dbName: string,
    connector: ConnectorDoc,
    stale: McpConnectionDoc,
    fetchImpl?: FetchLike,
  ): Promise<UsableTokens> {
    const config = this.requireConfig();
    const connections = this.connections(dbName);
    const deadline = Date.now() + REFRESH_WAIT_MS;
    // The provider's token endpoint and the client secret, fetched while the
    // lease is claimed rather than after it: discovery is two HTTPS calls.
    // Started early only when the refresh token may still work; unused when
    // another process refreshes first. A failure surfaces where refreshHeld
    // awaits it.
    let early: Promise<RefreshInputs> | undefined;
    const inputs = (): Promise<RefreshInputs> =>
      (early ??= this.refreshInputs(connector, config, fetchImpl));
    if (!refreshTokenExpired(stale, Date.now()))
      inputs().catch(() => undefined);
    for (;;) {
      const now = new Date();
      // Take the lease, unless another holder's is still live. Matching the
      // revision read means the tokens being refreshed are the current ones.
      const leaseId = new ObjectId();
      const claimed = await connections.findOneAndUpdate(
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
              until: new Date(now.getTime() + REFRESH_LEASE_MS),
            },
          },
        },
        { returnDocument: "after" },
      );
      if (claimed) {
        // Someone else refreshed between our read and the claim.
        if (!needsRefresh(claimed, now.getTime())) {
          await this.releaseLease(dbName, claimed._id, leaseId);
          return { ok: true, tokens: this.open(config, claimed) };
        }
        return this.refreshHeld(
          dbName,
          connector,
          claimed,
          leaseId,
          inputs,
          fetchImpl,
        );
      }
      // No claim: another process holds the lease, or the row changed state.
      const current = await connections.findOne({ _id: stale._id });
      if (!current || current.status !== "active")
        return { ok: false, reason: "needs_reconnect" };
      if (!needsRefresh(current, Date.now()))
        return { ok: true, tokens: this.open(config, current) };
      if (Date.now() >= deadline) return this.fallback(config, current);
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
    }
  }

  // Refreshes while holding the lease and stores the new grant. The write
  // requires the lease to still be ours, so a holder that overran its lease
  // cannot overwrite a newer refresh.
  private async refreshHeld(
    dbName: string,
    connector: ConnectorDoc,
    row: McpConnectionDoc,
    leaseId: ObjectId,
    inputs: () => Promise<RefreshInputs>,
    fetchImpl?: FetchLike,
  ): Promise<UsableTokens> {
    const config = this.requireConfig();
    const connections = this.connections(dbName);
    const current = this.open(config, row);
    const now = new Date();
    if (!current.refreshToken || refreshTokenExpired(row, now.getTime())) {
      // Nothing to refresh with. A still-valid token is used to the end of
      // its life; an expired one means the user signs in again.
      await this.releaseLease(dbName, row._id, leaseId);
      if (!isExpired(row, now.getTime())) return { ok: true, tokens: current };
      await this.markNeedsReconnect(dbName, row._id, now, "token_expired");
      return { ok: false, reason: "needs_reconnect" };
    }

    let grant: TokenGrant;
    try {
      const [endpoints, clientSecret] = await inputs();
      grant = await refreshGrant({
        tokenEndpoint: endpoints.tokenEndpoint,
        refreshToken: current.refreshToken,
        clientId: connector.auth.clientId,
        clientSecret,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    } catch (error) {
      if (error instanceof ExchangeFailedError) {
        // The provider refused the refresh token: revoked, already used or
        // expired. Only a new sign-in helps.
        this.logger.warn({
          message: "connector token refresh refused",
          slug: connector.slug,
          code: "refresh_refused",
        });
        await this.markNeedsReconnect(dbName, row._id, now, "refresh_refused");
        return { ok: false, reason: "needs_reconnect" };
      }
      // Unreachable provider, discovery or secret: nothing changed at the
      // provider, so the stored tokens are still the right ones.
      this.logger.warn({
        message: "connector token refresh unavailable",
        slug: connector.slug,
        code: "refresh_unavailable",
        error: error instanceof Error ? error.name : "unknown",
      });
      await this.releaseLease(dbName, row._id, leaseId);
      return this.fallback(config, row);
    }

    // A provider that does not rotate refresh tokens omits a new one; keep
    // the one that still works.
    const tokens: ConnectorTokens = {
      accessToken: grant.tokens.accessToken,
      ...(grant.tokens.refreshToken || current.refreshToken
        ? { refreshToken: grant.tokens.refreshToken ?? current.refreshToken }
        : {}),
    };
    const stored = new Date();
    const lifetimes = lifetimesOf(grant, stored);
    const written = await connections.updateOne(
      { _id: row._id, "refreshLease.id": leaseId },
      {
        $set: {
          secret: sealTokens(
            config,
            aadFor(row.tenantId, row.ownerId, row.connectorId),
            tokens,
          ),
          lastRefreshedAt: stored,
          updatedAt: stored,
          ...lifetimes.set,
          // Keep the refresh token's known expiry when the provider did not
          // restate it.
          ...(grant.refreshExpiresInSec === undefined && row.refreshExpiresAt
            ? { refreshExpiresAt: row.refreshExpiresAt }
            : {}),
        },
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
    if (written.matchedCount !== 1) {
      // The lease was lost (we overran it, or the user reconnected). The
      // fresh tokens are valid either way; the row's own are the record.
      this.logger.warn({
        message: "connector refresh lease lost before the write",
        slug: connector.slug,
        code: "refresh_lease_lost",
      });
    }
    this.logger.log({
      message: "connector token refreshed",
      slug: connector.slug,
    });
    return { ok: true, tokens };
  }

  private refreshInputs(
    connector: ConnectorDoc,
    config: ConnectorsConfig,
    fetchImpl?: FetchLike,
  ): Promise<RefreshInputs> {
    return Promise.all([
      this.discover(connector, config, fetchImpl),
      this.secrets.resolve(connector.auth.clientSecret),
    ]);
  }

  // A stored token no configured key opens (its key was retired too early):
  // the member signs in again rather than every run failing.
  private async unreadable(
    dbName: string,
    connector: ConnectorDoc,
    row: McpConnectionDoc,
  ): Promise<UsableTokens> {
    this.logger.error({
      message: "connector token could not be decrypted",
      slug: connector.slug,
      keyId: row.secret.keyId,
      code: "token_unreadable",
    });
    await this.markNeedsReconnect(
      dbName,
      row._id,
      new Date(),
      "token_unreadable",
    );
    return { ok: false, reason: "needs_reconnect" };
  }

  private async releaseLease(
    dbName: string,
    id: ObjectId,
    leaseId: ObjectId,
  ): Promise<void> {
    await this.connections(dbName).updateOne(
      { _id: id, "refreshLease.id": leaseId },
      { $unset: { refreshLease: "" } },
    );
  }

  // When a refresh could not happen (provider down, or another process still
  // refreshing): a token that has not expired yet is still usable, just with
  // less margin; an expired one cannot be sent, so the run waits for later.
  private fallback(
    config: ConnectorsConfig,
    row: McpConnectionDoc,
  ): UsableTokens {
    if (isExpired(row, Date.now())) return { ok: false, reason: "unavailable" };
    return { ok: true, tokens: this.open(config, row) };
  }

  private open(
    config: ConnectorsConfig,
    row: McpConnectionDoc,
  ): ConnectorTokens {
    return openTokens(
      config,
      aadFor(row.tenantId, row.ownerId, row.connectorId),
      row.secret,
    );
  }

  // A run reported that the connector refused the token (connector.status
  // reason "auth"). A refreshable connection is marked expired so the next
  // run refreshes it, and a refresh the provider refuses then asks for a new
  // sign-in; one without a refresh token needs a new sign-in now.
  async tokenRejected(
    dbName: string,
    userId: ObjectId,
    slug: string,
  ): Promise<void> {
    const config = this.requireConfig();
    const connector = await this.catalog.findEnabledBySlug(slug);
    if (!connector) return;
    const row = await this.connections(dbName).findOne({
      ownerId: userId,
      connectorId: connector._id,
      status: "active",
    });
    if (!row) return;
    const now = new Date();
    let refreshable = false;
    try {
      refreshable = this.open(config, row).refreshToken !== undefined;
    } catch {
      refreshable = false;
    }
    if (!refreshable) {
      await this.markNeedsReconnect(dbName, row._id, now, "unauthorized");
      return;
    }
    // Only the revision read: a refresh that landed since keeps its tokens.
    await this.connections(dbName).updateOne(
      { _id: row._id, revision: row.revision },
      {
        $set: { accessExpiresAt: now, updatedAt: now },
        $inc: { revision: 1 },
      },
    );
  }

  // The caller is still an active member of the tenant. The callback re-checks
  // this before exchanging the code.
  async isActiveMember(tenantId: ObjectId, userId: ObjectId): Promise<boolean> {
    return (await this.memberships.findActive(userId, tenantId)) !== null;
  }

  private async markNeedsReconnect(
    dbName: string,
    id: ObjectId,
    now: Date,
    code = "unauthorized",
  ): Promise<McpConnectionDoc | undefined> {
    const updated = await this.connections(dbName).findOneAndUpdate(
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
      { returnDocument: "after", projection: SECRET_PROJECTION },
    );
    return updated ?? undefined;
  }
}

// The additional authenticated data that binds a sealed token to one tenant,
// owner and connector. keyId is added by the crypto layer.
// True when the provider reported its granted scopes and one the connector
// asks for is not among them. A response with no scope field means the
// request was granted as asked (RFC 6749 §5.1).
function missingScopes(
  requested: readonly string[],
  granted: readonly string[] | undefined,
): boolean {
  if (granted === undefined || requested.length === 0) return false;
  const have = new Set(granted);
  return requested.some((scope) => !have.has(scope));
}

// The userinfo verify option, when the connector names its account that way.
// A connector that asks for it on a server whose authorization server has no
// userinfo endpoint is misconfigured, so verify fails rather than silently
// skipping the token check.
function userinfoOf(
  connector: ConnectorDoc,
  endpoints: DiscoveredEndpoints,
): { userinfo?: { url: string; field: string } } {
  const wanted = connector.auth.accountUserinfo;
  if (!wanted) return {};
  if (!endpoints.userinfoEndpoint)
    throw new VerifyFailedError("no userinfo endpoint");
  return {
    userinfo: { url: endpoints.userinfoEndpoint, field: wanted.field },
  };
}

function aadFor(
  tenantId: ObjectId,
  ownerId: ObjectId,
  connectorId: ObjectId,
): SecretAad {
  return {
    tenantId: tenantId.toHexString(),
    ownerId: ownerId.toHexString(),
    connectorId: connectorId.toHexString(),
  };
}

// A connection summary for the member listing. A missing row is not_connected.
function viewOf(row: McpConnectionDoc | undefined): ConnectionView {
  if (!row) return { status: "not_connected" };
  const view: ConnectionView = {
    status: row.status,
    toolCount: row.toolCount,
    lastVerifiedAt: row.lastVerifiedAt.toISOString(),
  };
  if (row.account) view.account = row.account;
  return view;
}

// One connection's entry in a run's network policy. The egress data is the
// catalog's; only the token and the account are the member's.
function networkConnectorOf(
  connector: ConnectorDoc,
  row: McpConnectionDoc,
  readOnly: boolean,
  token: string,
): RunNetworkConnector {
  const egress = connector.egress!;
  const entry: RunNetworkConnector = {
    name: connector.slug,
    displayName: connector.displayName,
    access: readOnly ? "read_only" : "read_write",
    hosts: [...egress.hosts],
    reads: egress.reads,
    critical: egress.critical,
  };
  if (row.account?.login) entry.account = row.account.login;
  if (egress.credential) entry.credential = { ...egress.credential, token };
  return entry;
}

function missingOf(connector: ConnectorDoc): MissingConnector {
  return {
    slug: connector.slug,
    displayName: connector.displayName,
    available: true,
  };
}

// The tools a run enables for a connector: its allowedTools, minus writeTools
// for a read_only chat. undefined (no enabled_tools restriction) when the
// connector set no allowedTools. A read_only connector with writeTools === its
// whole allowedTools yields [], which still restricts to no tools.
export function enabledToolsOf(
  connector: ConnectorDoc,
  readOnly: boolean,
): string[] | undefined {
  if (connector.allowedTools === undefined) return undefined;
  if (!readOnly || !connector.writeTools || connector.writeTools.length === 0)
    return connector.allowedTools;
  const write = new Set(connector.writeTools);
  return connector.allowedTools.filter((tool) => !write.has(tool));
}

// Whether the row's refresh token is past its known expiry.
function refreshTokenExpired(row: McpConnectionDoc, now: number): boolean {
  return (
    row.refreshExpiresAt !== undefined && row.refreshExpiresAt.getTime() <= now
  );
}

// Whether a run should refresh before using the row's token.
function needsRefresh(row: McpConnectionDoc, now: number): boolean {
  return (
    row.accessExpiresAt !== undefined &&
    row.accessExpiresAt.getTime() - now < REFRESH_MARGIN_MS
  );
}

function isExpired(row: McpConnectionDoc, now: number): boolean {
  return (
    row.accessExpiresAt !== undefined && row.accessExpiresAt.getTime() <= now
  );
}

// The expiry fields a grant sets, and the ones it clears (a grant without a
// lifetime replaces one that had one).
function lifetimesOf(
  grant: TokenGrant,
  now: Date,
): {
  set: { accessExpiresAt?: Date; refreshExpiresAt?: Date };
  unset: Record<string, "">;
} {
  const set: { accessExpiresAt?: Date; refreshExpiresAt?: Date } = {};
  const unset: Record<string, ""> = {};
  if (grant.accessExpiresInSec !== undefined)
    set.accessExpiresAt = new Date(
      now.getTime() + grant.accessExpiresInSec * 1000,
    );
  else unset.accessExpiresAt = "";
  if (grant.refreshExpiresInSec !== undefined)
    set.refreshExpiresAt = new Date(
      now.getTime() + grant.refreshExpiresInSec * 1000,
    );
  else unset.refreshExpiresAt = "";
  return { set, unset };
}
