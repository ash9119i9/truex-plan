import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  MongoClient,
  ObjectId,
  type Collection,
  type CommandStartedEvent,
} from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  createCredentials,
  RefreshRefusedError,
  type ConnectionRow,
  type CredentialOptions,
  type RefreshRequest,
  type TokenGrant,
} from "../src/credentials";
import {
  openTokens,
  sealTokens,
  type ConnectorTokens,
  type TokenKeys,
} from "../src/token-crypto";

// The leased refresh against a real (in-memory) Mongo. The row and lease
// shapes are platform-next's (connectors/connection.ts, connectors.service.ts
// refreshShared/refreshHeld), because both services refresh the same rows
// until the cutover.

const DB = "truex_next_t_credentials_test";
const KEYS: TokenKeys = {
  keys: new Map([["k1", Buffer.alloc(32, 7)]]),
  activeKeyId: "k1",
};
const MIN = 60_000;

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// The provider's token endpoint. `gate` holds every refresh until released.
class FakeProvider {
  calls: RefreshRequest[] = [];
  behaviour: "ok" | "refuse" | "down" = "ok";
  gate: Deferred | undefined;
  called = deferred();

  readonly refresh = async (request: RefreshRequest): Promise<TokenGrant> => {
    this.calls.push(request);
    this.called.resolve();
    if (this.gate) await this.gate.promise;
    if (this.behaviour === "refuse") throw new RefreshRefusedError();
    if (this.behaviour === "down") throw new Error("connect ECONNREFUSED");
    const n = this.calls.length;
    return {
      tokens: {
        accessToken: `new-access-${n}`,
        refreshToken: `new-refresh-${n}`,
      },
      accessExpiresInSec: 3600,
    };
  };
}

let mongo: MongoMemoryServer;
let client: MongoClient;
let rows: Collection<ConnectionRow>;
let provider: FakeProvider;
const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];

function aadOf(row: ConnectionRow) {
  return {
    tenantId: row.tenantId.toHexString(),
    ownerId: row.ownerId.toHexString(),
    connectorId: row.connectorId.toHexString(),
  };
}

async function seed(
  accessInMs: number | undefined,
  extra: Partial<ConnectionRow> = {},
  tokens: ConnectorTokens = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
  },
): Promise<ConnectionRow> {
  const base = {
    _id: new ObjectId(),
    tenantId: new ObjectId(),
    ownerId: new ObjectId(),
    connectorId: new ObjectId(),
    slug: "github",
    status: "active",
    revision: 1,
  };
  const row: ConnectionRow = {
    ...base,
    secret: sealTokens(KEYS, aadOf(base as ConnectionRow), tokens),
    ...(accessInMs === undefined
      ? {}
      : { accessExpiresAt: new Date(Date.now() + accessInMs) }),
    ...extra,
  };
  await rows.insertOne(row);
  return row;
}

function store(overrides: Partial<CredentialOptions> = {}) {
  return createCredentials({
    client,
    keys: KEYS,
    refresh: provider.refresh,
    log: (event, fields) => logs.push({ event, fields }),
    pollMs: 20,
    ...overrides,
  });
}

async function stored(row: ConnectionRow): Promise<ConnectionRow> {
  const current = await rows.findOne({ _id: row._id });
  assert.ok(current, "row still exists");
  return current;
}

describe("credentials: leased refresh", () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    // Command events let a test wait for a read instead of sleeping.
    client = await MongoClient.connect(mongo.getUri(), {
      monitorCommands: true,
    });
    rows = client.db(DB).collection<ConnectionRow>("mcp_connections");
  });

  after(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await rows.deleteMany({});
    provider = new FakeProvider();
    logs.length = 0;
  });

  test("a token valid past the margin, or with no expiry, is used without a refresh", async () => {
    const credentials = store();
    for (const row of [await seed(60 * MIN), await seed(undefined)]) {
      const result = await credentials.usableTokens(DB, row);
      assert.deepEqual(result, {
        ok: true,
        tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
      });
    }
    assert.equal(provider.calls.length, 0);
  });

  test("a token inside the margin is refreshed once for concurrent calls, and stored", async () => {
    const row = await seed(5 * MIN);
    const credentials = store();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => credentials.usableTokens(DB, row)),
    );
    assert.equal(provider.calls.length, 1, "single flight in one process");
    assert.deepEqual(provider.calls[0], {
      connectorId: row.connectorId,
      slug: "github",
      refreshToken: "old-refresh",
    });
    for (const result of results)
      assert.deepEqual(result, {
        ok: true,
        tokens: { accessToken: "new-access-1", refreshToken: "new-refresh-1" },
      });
    const after = await stored(row);
    assert.deepEqual(openTokens(KEYS, aadOf(after), after.secret), {
      accessToken: "new-access-1",
      refreshToken: "new-refresh-1",
    });
    assert.equal(after.revision, 2);
    assert.equal(after.refreshLease, undefined, "the lease is released");
    const lifetime = after.accessExpiresAt!.getTime() - Date.now();
    assert.ok(lifetime > 55 * MIN && lifetime <= 60 * MIN, String(lifetime));
  });

  test("two gateway instances refresh a connection once", async () => {
    const row = await seed(5 * MIN);
    provider.gate = deferred();
    const a = store().usableTokens(DB, row);
    // A holds the lease and is inside the provider call.
    await provider.called.promise;
    // B's claim fails on A's live lease, so B rereads the row to wait. Its
    // first `find` on the collection is that reread.
    const bWaiting = new Promise<void>((resolve) => {
      const onCommand = (event: CommandStartedEvent) => {
        if (event.commandName !== "find") return;
        if ((event.command as { find?: unknown }).find !== "mcp_connections")
          return;
        client.off("commandStarted", onCommand);
        resolve();
      };
      client.on("commandStarted", onCommand);
    });
    const b = store().usableTokens(DB, row);
    await bWaiting;
    provider.gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(provider.calls.length, 1);
    for (const result of [ra, rb]) {
      assert.ok(result.ok);
      assert.equal(result.tokens.accessToken, "new-access-1");
    }
  });

  test("a live lease held in platform-next's shape is waited for, never overridden", async () => {
    const platformLease = {
      id: new ObjectId(),
      until: new Date(Date.now() + 30_000),
    };
    const row = await seed(5 * MIN, { refreshLease: platformLease });
    const pending = store().usableTokens(DB, row);
    // platform-next finishes its refresh: new tokens, lease cleared.
    await rows.updateOne(
      { _id: row._id },
      {
        $set: {
          secret: sealTokens(KEYS, aadOf(row), {
            accessToken: "platform-access",
            refreshToken: "platform-refresh",
          }),
          accessExpiresAt: new Date(Date.now() + 60 * MIN),
        },
        $unset: { refreshLease: "" },
        $inc: { revision: 1 },
      },
    );
    const result = await pending;
    assert.deepEqual(result, {
      ok: true,
      tokens: {
        accessToken: "platform-access",
        refreshToken: "platform-refresh",
      },
    });
    assert.equal(provider.calls.length, 0, "the gateway didn't refresh too");
  });

  test("a lease that stays held past the wait falls back to the stored token, untouched", async () => {
    const platformLease = {
      id: new ObjectId(),
      until: new Date(Date.now() + 30_000),
    };
    const valid = await seed(5 * MIN, { refreshLease: platformLease });
    const result = await store({ waitMs: 150 }).usableTokens(DB, valid);
    assert.deepEqual(result, {
      ok: true,
      tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
    });
    assert.ok((await stored(valid)).refreshLease?.id.equals(platformLease.id));

    const expired = await seed(-MIN, { refreshLease: platformLease });
    assert.deepEqual(await store({ waitMs: 150 }).usableTokens(DB, expired), {
      ok: false,
      reason: "unavailable",
    });
    assert.equal(provider.calls.length, 0);
  });

  test("a refresh the provider refuses marks the connection needs_reconnect", async () => {
    provider.behaviour = "refuse";
    const row = await seed(5 * MIN);
    assert.deepEqual(await store().usableTokens(DB, row), {
      ok: false,
      reason: "needs_reconnect",
    });
    const after = await stored(row);
    assert.equal(after.status, "needs_reconnect");
    assert.equal(
      (after as { lastError?: { code: string } }).lastError?.code,
      "refresh_refused",
    );
    assert.equal(after.refreshLease, undefined);
    assert.equal(after.revision, 2);
  });

  test("an unreachable provider: a still-valid token is used, an expired one is unavailable", async () => {
    provider.behaviour = "down";
    const valid = await seed(5 * MIN);
    assert.deepEqual(await store().usableTokens(DB, valid), {
      ok: true,
      tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
    });
    const validAfter = await stored(valid);
    assert.equal(
      validAfter.status,
      "active",
      "nothing changed at the provider",
    );
    assert.equal(validAfter.refreshLease, undefined, "the lease is released");

    const expired = await seed(-MIN);
    assert.deepEqual(await store().usableTokens(DB, expired), {
      ok: false,
      reason: "unavailable",
    });
    assert.equal((await stored(expired)).status, "active");
  });

  test("a holder that lost its lease doesn't overwrite the newer tokens", async () => {
    const row = await seed(5 * MIN);
    provider.gate = deferred();
    const pending = store().usableTokens(DB, row);
    await provider.called.promise;
    // Our lease ran out and another holder took over and stored its grant.
    const other = { id: new ObjectId(), until: new Date(Date.now() + 30_000) };
    await rows.updateOne(
      { _id: row._id },
      {
        $set: {
          refreshLease: other,
          secret: sealTokens(KEYS, aadOf(row), { accessToken: "other-access" }),
        },
      },
    );
    provider.gate.resolve();
    const result = await pending;
    assert.ok(result.ok);
    assert.equal(
      result.tokens.accessToken,
      "new-access-1",
      "our grant is still valid to use",
    );
    const after = await stored(row);
    assert.equal(
      openTokens(KEYS, aadOf(after), after.secret).accessToken,
      "other-access",
    );
    assert.ok(after.refreshLease?.id.equals(other.id));
    assert.ok(logs.some((l) => l.event === "refresh_lease_lost"));
  });

  test("nothing to refresh with: valid is used to the end, expired needs a new sign-in", async () => {
    const tokens = { accessToken: "no-refresh-access" };
    const valid = await seed(5 * MIN, {}, tokens);
    assert.deepEqual(await store().usableTokens(DB, valid), {
      ok: true,
      tokens,
    });
    const expired = await seed(-MIN, {}, tokens);
    assert.deepEqual(await store().usableTokens(DB, expired), {
      ok: false,
      reason: "needs_reconnect",
    });
    const after = await stored(expired);
    assert.equal(after.status, "needs_reconnect");
    assert.equal(
      (after as { lastError?: { code: string } }).lastError?.code,
      "token_expired",
    );
    assert.equal(provider.calls.length, 0);
  });

  test("a token no key opens asks for a new sign-in instead of failing every call", async () => {
    const row = await seed(60 * MIN);
    const otherKeys: TokenKeys = {
      keys: new Map([["k1", Buffer.alloc(32, 9)]]),
      activeKeyId: "k1",
    };
    assert.deepEqual(await store({ keys: otherKeys }).usableTokens(DB, row), {
      ok: false,
      reason: "needs_reconnect",
    });
    const after = await stored(row);
    assert.equal(after.status, "needs_reconnect");
    assert.equal(
      (after as { lastError?: { code: string } }).lastError?.code,
      "token_unreadable",
    );
    assert.ok(
      !JSON.stringify(logs).includes("old-access"),
      "no token in the logs",
    );
  });
});
