import type { IndexDescription, ObjectId } from "mongodb";
import type { SealedSecret } from "./token-crypto";

// One user's connection to one directory connector, in the tenant database's
// `mcp_connections`. It holds the user's encrypted OAuth tokens and is never
// returned by any API with the secret attached. Reconnecting upserts the same
// row (unique on owner + connector).
export const CONNECTIONS_COLLECTION = "mcp_connections";

export type ConnectionStatus =
  "active" | "needs_reconnect" | "needs_admin_approval";

export interface McpConnectionDoc {
  _id: ObjectId;
  // The catalog connector's ID (catalog DB), pinned so a slug reuse cannot
  // repoint an existing connection.
  connectorId: ObjectId;
  // The connector's slug at connect time, used to build the Codex server name
  // and merge into the listing without a second catalog read.
  slug: string;
  ownerId: ObjectId;
  // The tenant this connection belongs to. The row already lives in the
  // tenant database, but the hex ID is stored so the token AAD
  // (tenantId|ownerId|connectorId|keyId) can be rebuilt by runSpecs, which is
  // given only the database name.
  tenantId: ObjectId;
  status: ConnectionStatus;
  // Never projected by default (SECRET_PROJECTION); only runSpecs and verify
  // read it. AES-256-GCM of { accessToken, refreshToken? }.
  secret: SealedSecret;
  // When the provider gave lifetimes. A connection without accessExpiresAt
  // never expires (a GitHub App with expiry turned off) and is never
  // refreshed.
  accessExpiresAt?: Date;
  refreshExpiresAt?: Date;
  lastRefreshedAt?: Date;
  // Held while one process refreshes the tokens. Providers that rotate the
  // refresh token (GitHub) invalidate the old one on use, so two refreshes at
  // once would leave one of them holding a dead token; the lease makes every
  // other run wait for the one refresh instead.
  refreshLease?: { id: ObjectId; until: Date };
  account?: { login: string };
  toolCount: number;
  lastVerifiedAt: Date;
  lastUsedAt?: Date;
  // Safe codes only, never provider text.
  lastError?: { code: string; at: Date };
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

// A connection a member sees, merged into the catalog listing. No secret, no
// tokens, no IDs the UI does not need.
export interface ConnectionView {
  status: ConnectionStatus | "not_connected";
  account?: { login: string };
  toolCount?: number;
  lastVerifiedAt?: string;
}

// The default projection excludes the sealed secret, like the models catalog.
// Only runSpecs and the verify path read the secret, with an explicit
// projection that includes it.
export const SECRET_PROJECTION = { secret: 0 } as const;

// Built when the tenant is provisioned (see tenant-indexes.ts). The unique
// index makes reconnect an upsert and lets two racing callbacks resolve to one
// row.
export const CONNECTION_INDEXES: Readonly<Record<string, IndexDescription[]>> =
  {
    [CONNECTIONS_COLLECTION]: [
      {
        key: { ownerId: 1, connectorId: 1 },
        name: "owner_connector_unique",
        unique: true,
      },
    ],
  };
