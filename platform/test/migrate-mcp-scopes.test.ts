import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { decryptSecret } from "../src/secrets";
import { tenantDbName } from "../src/tenant";
import { testEncryptionKey } from "./fixtures";

const script = resolve(__dirname, "../../scripts/migrate-mcp-scopes.mjs");
const DEFAULT_DB = "migrate_default";
const CATALOG_DB = "migrate_catalog";
const T1_DB = tenantDbName("t1");

// Runs the script with only explicit env, so neither the developer's shell
// nor platform/.env can point it at real data.
function run(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}

test(
  "migrate-mcp-scopes: dry run, key check, scopes, attachments, encryption, indexes, idempotent",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const client = await new MongoClient(mongo.getUri()).connect();
    t.after(async () => {
      await client.close();
      await mongo.stop();
    });
    const env = {
      MONGO_URI: mongo.getUri(),
      MONGO_DB: DEFAULT_DB,
      CATALOG_MONGO_DB: CATALOG_DB,
    };
    const withKey = { ...env, MCP_ENCRYPTION_KEY: testEncryptionKey };
    const confirm = ["--confirm", "migrate-mcp-scopes"];

    // The pre-scope layout: qlik and btp with plain keys, attached through
    // agent.mcpProfileIds (qlik by ObjectId hex string, as the seeds did).
    const qlikId = new ObjectId();
    const db = client.db(DEFAULT_DB);
    await db.collection("truex_mcp").insertMany([
      {
        _id: qlikId,
        name: "qlik",
        transport: "http",
        url: "https://example.com/qlik",
        auth: { kind: "header", headerName: "x-api-qlik-key" },
        apiKey: "qlik-plain-key",
      },
      {
        _id: "btp" as any,
        name: "btp",
        transport: "http",
        url: "https://example.com/btp",
        apikey: "btp-plain-key",
      },
      {
        _id: "own" as any,
        name: "notes",
        ownerId: "ashok",
        transport: "http",
        url: "https://example.com/notes",
      },
    ]);
    await db.collection("truex_agents").insertMany([
      {
        _id: "assistant" as any,
        name: "Assistant",
        modelProfileId: "default",
        mcpProfileIds: [qlikId.toHexString(), "btp", "gone"],
      },
      {
        _id: "developer" as any,
        name: "Developer",
        modelProfileId: "default",
        mcpProfileIds: ["btp"],
      },
    ]);
    // t1 (registered) has two ownerless profiles with one name.
    const now = new Date().toISOString();
    await client
      .db(CATALOG_DB)
      .collection("tenants")
      .insertOne({
        _id: "t1" as any,
        name: "T1",
        dbName: T1_DB,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    await client
      .db(T1_DB)
      .collection("truex_mcp")
      .insertMany([
        { _id: "d1" as any, name: "dup", transport: "http", url: "https://example.com/1" },
        { _id: "d2" as any, name: "dup", transport: "http", url: "https://example.com/2" },
      ]);

    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          [DEFAULT_DB, T1_DB].flatMap((name) =>
            ["truex_mcp", "truex_agents"].map(async (c) => ({
              docs: await client.db(name).collection(c).find({}).sort({ _id: 1 }).toArray(),
              indexes: (await client.db(name).collection(c).listIndexes().toArray().catch(() => []))
                .map((i) => i.name)
                .sort(),
            })),
          ),
        ),
      );
    const original = await snapshot();

    // Unknown arguments are refused.
    assert.equal((await run(["--confirm", "yes"], withKey)).code, 1);

    // Dry run: reports, writes nothing (a missing key is only a warning).
    const dry = await run([], env);
    assert.match(dry.out, /\[dry run\]/);
    assert.match(dry.out, /default: 2 profile\(s\) would be marked scope "tenant", 1 with an owner/);
    assert.match(dry.out, /3 attachment\(s\) would be moved/);
    assert.match(dry.out, /2 plain key\(s\) would be encrypted/);
    assert.match(dry.out, /MCP_ENCRYPTION_KEY is not set/);
    assert.match(dry.out, /several tenant MCP profiles are named dup/);
    assert.equal(await snapshot(), original);

    // A real run without the key refuses before writing anything.
    const refused = await run(confirm, env);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /2 MCP profile\(s\) store a plain API key, and MCP_ENCRYPTION_KEY is not set/);
    assert.match(refused.out, /Nothing was changed/);
    assert.equal(await snapshot(), original);

    // The real run. The duplicate is reported (exit 1), not a crash, and
    // everything else is migrated.
    const applied = await run(confirm, withKey);
    assert.equal(applied.code, 1, applied.out);
    assert.match(applied.out, /several tenant MCP profiles are named dup/);
    assert.match(applied.out, /missing MCP profile gone/);
    assert.doesNotMatch(applied.out, /qlik-plain-key|btp-plain-key|TypeError/);
    const mcp = db.collection("truex_mcp");
    const qlik = await mcp.findOne({ _id: qlikId });
    const btp = await mcp.findOne({ _id: "btp" as any });
    const own = await mcp.findOne({ _id: "own" as any });
    assert.equal(qlik?.scope, "tenant");
    assert.equal(btp?.scope, "tenant");
    assert.equal(own?.scope, "user");
    assert.deepEqual(qlik?.agentIds, ["assistant"]);
    assert.deepEqual(btp?.agentIds.sort(), ["assistant", "developer"]);
    assert.deepEqual(own?.agentIds, []);
    // Encrypted with the platform's code, plain fields gone.
    process.env.MCP_ENCRYPTION_KEY = testEncryptionKey;
    assert.equal(decryptSecret(qlik?.apiKeyEnc), "qlik-plain-key");
    assert.equal(decryptSecret(btp?.apiKeyEnc), "btp-plain-key");
    for (const p of [qlik, btp]) {
      assert.equal("apiKey" in p!, false);
      assert.equal("apikey" in p!, false);
    }
    // agent.mcpProfileIds stays, unread.
    assert.deepEqual(
      (await db.collection("truex_agents").findOne({ _id: "assistant" as any }))
        ?.mcpProfileIds,
      [qlikId.toHexString(), "btp", "gone"],
    );
    for (const name of [DEFAULT_DB, T1_DB]) {
      const indexes = await client.db(name).collection("truex_mcp").listIndexes().toArray();
      const byName = new Map(indexes.map((i) => [i.name, i]));
      assert.equal(byName.get("tenant_mcp_name")?.unique, true, name);
      assert.deepEqual(
        byName.get("tenant_mcp_name")?.partialFilterExpression,
        { scope: "tenant" },
      );
      assert.equal(byName.get("user_mcp_name")?.unique, true, name);
      assert.ok(byName.has("agentIds_1_scope_1"), name);
    }
    // The clashing pair is left unscoped (never loaded) until renamed.
    const dups = await client.db(T1_DB).collection("truex_mcp").find({}).toArray();
    assert.deepEqual(dups.map((d) => d.scope), [undefined, undefined]);

    // A second run changes nothing.
    const migrated = await snapshot();
    const again = await run(confirm, withKey);
    assert.match(again.out, /default: 0 profile\(s\) marked/);
    assert.match(again.out, /0 attachment\(s\) moved/);
    assert.match(again.out, /0 plain key\(s\) encrypted/);
    assert.equal(await snapshot(), migrated);

    // Once renamed, the next run finishes cleanly.
    await client
      .db(T1_DB)
      .collection("truex_mcp")
      .updateOne({ _id: "d2" as any }, { $set: { name: "dup-2" } });
    const clean = await run(confirm, withKey);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /t1: 2 profile\(s\) marked scope "tenant"/);
    assert.deepEqual(
      (await client.db(T1_DB).collection("truex_mcp").find({}).toArray()).map(
        (d) => d.scope,
      ),
      ["tenant", "tenant"],
    );
  },
);
