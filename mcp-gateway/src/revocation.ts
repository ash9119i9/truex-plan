import { ObjectId, type MongoClient } from "mongodb";
import type { McpCallerClaims } from "../../shared/mcp-caller-token";
import type { ConnectionRow } from "./credentials";
import { policyOf, type ToolPolicy } from "./policy";

// The caller token never expires (shared/mcp-caller-token.ts), so this check,
// run on every request, is what ends access. It reads the records the
// platform writes; the collection names and fields mirror platform-next
// (tenants/tenant.ts, memberships/membership.ts, connectors/connector.ts,
// chats/chat.ts, connectors/connection.ts), which builds from its own sources
// only, so they are repeated here.
//
// Two round trips: three catalog reads in parallel, then two reads in the
// tenant's database, whose name comes from the tenant record. The connection
// read returns the sealed token too (still encrypted), so the server can
// open it without a third round trip. The connector and chat reads also
// carry the tool policy (policy.ts), so that costs no extra round trip either.

const TENANTS = "tenants";
const MEMBERSHIPS = "memberships";
const CONNECTORS = "truex_mcp_connectors";
const CHATS = "chats";
const CONNECTIONS = "mcp_connections";

// What credentials.ts needs from the row, nothing else.
const CONNECTION_PROJECTION = {
  tenantId: 1,
  ownerId: 1,
  connectorId: 1,
  slug: 1,
  status: 1,
  secret: 1,
  accessExpiresAt: 1,
  refreshExpiresAt: 1,
  refreshLease: 1,
  revision: 1,
} as const;

const OBJECT_ID = /^[0-9a-f]{24}$/;
// The platform's owned database names (platform-next app-config.ts).
const TENANT_DB = /^truex_next_[a-z0-9_]{1,52}$/;

export type RevokedReason =
  "claims" | "tenant" | "membership" | "connector" | "chat" | "connection";

export type CallerResolution =
  | {
      readonly ok: true;
      readonly upstreamUrl: string;
      readonly dbName: string;
      readonly connection: ConnectionRow;
      readonly policy: ToolPolicy;
    }
  | { readonly ok: false; readonly reason: RevokedReason };

interface TenantRow {
  _id: ObjectId;
  dbName?: unknown;
}

interface ConnectorRow {
  _id: ObjectId;
  url?: unknown;
  allowedTools?: unknown;
  writeTools?: unknown;
  toolHashes?: unknown;
}

interface ChatRow {
  _id: ObjectId;
  connectors?: Array<{ access?: unknown }>;
}

// Throws when Mongo can't answer; the server turns that into a 503, never a
// 401, so an outage doesn't look like a revoked token.
export function createCallerResolver(
  client: MongoClient,
  catalogDbName: string,
): (claims: McpCallerClaims) => Promise<CallerResolution> {
  const catalog = client.db(catalogDbName);
  return async (claims) => {
    if (
      ![claims.tenantId, claims.userId, claims.chatId].every((id) =>
        OBJECT_ID.test(id),
      )
    )
      return refused("claims");
    const tenantId = new ObjectId(claims.tenantId);
    const userId = new ObjectId(claims.userId);
    const chatId = new ObjectId(claims.chatId);
    const [tenant, membership, connector] = await Promise.all([
      catalog
        .collection<TenantRow>(TENANTS)
        .findOne(
          { _id: tenantId, status: "active", provisioningStatus: "ready" },
          { projection: { dbName: 1 } },
        ),
      catalog
        .collection(MEMBERSHIPS)
        .findOne(
          { userId, tenantId, status: "active" },
          { projection: { _id: 1 } },
        ),
      catalog.collection<ConnectorRow>(CONNECTORS).findOne(
        { slug: claims.connector, enabled: true },
        {
          projection: {
            url: 1,
            allowedTools: 1,
            writeTools: 1,
            toolHashes: 1,
          },
        },
      ),
    ]);
    if (
      !tenant ||
      typeof tenant.dbName !== "string" ||
      !TENANT_DB.test(tenant.dbName) ||
      tenant.dbName === catalogDbName
    )
      return refused("tenant");
    if (!membership) return refused("membership");
    if (!connector || typeof connector.url !== "string")
      return refused("connector");
    const db = client.db(tenant.dbName);
    const chatConnector = {
      connectorId: connector._id,
      slug: claims.connector,
    };
    const [chat, connection] = await Promise.all([
      db.collection<ChatRow>(CHATS).findOne(
        {
          _id: chatId,
          ownerId: userId,
          status: "active",
          // The chat's snapshot pins the connector's ID, so a reused slug
          // can't reach a chat started with another connector.
          connectors: { $elemMatch: chatConnector },
        },
        // Only the matching entry, for its access.
        { projection: { connectors: { $elemMatch: chatConnector } } },
      ),
      db.collection<ConnectionRow>(CONNECTIONS).findOne(
        {
          ownerId: userId,
          connectorId: connector._id,
          tenantId,
          status: "active",
        },
        { projection: CONNECTION_PROJECTION },
      ),
    ]);
    if (!chat) return refused("chat");
    if (!connection) return refused("connection");
    // platform-next writes `access: "read_only"` or nothing (read_write).
    // Any other value is unknown, so it gets the narrower access.
    const access =
      chat.connectors?.[0]?.access === undefined ? "read_write" : "read_only";
    return {
      ok: true,
      upstreamUrl: connector.url,
      dbName: tenant.dbName,
      connection,
      policy: policyOf(connector, access),
    };
  };
}

function refused(reason: RevokedReason): CallerResolution {
  return { ok: false, reason };
}
