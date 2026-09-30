import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

const script = resolve(__dirname, "../../scripts/purge-chats.mjs");
const TENANT_DB = "purge_default";
const CATALOG_DB = "purge_catalog";
const CHAT = ["sessions", "messages", "traces", "projects"];
const KEPT_TENANT = ["truex_agents", "truex_mcp"];
const KEPT_CATALOG = ["truex_models", "truex_skills", "tenants"];

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

const listen = (server: Server) =>
  new Promise<number>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok((server.address() as AddressInfo).port),
    ),
  );
const close = (server: Server) =>
  new Promise<void>((ok) => server.close(() => ok()));
// A port nothing listens on: bind an ephemeral one, then release it.
async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

const touch = (path: string) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "x");
};

function seedDisk(home: string) {
  for (const base of [join(home, "business-v1"), home]) {
    for (const dir of [
      "sessions",
      "archived_sessions",
      "thread-writer-locks",
      "business-threads",
      "business-workspaces",
      "adapter-records",
      "shell_snapshots",
    ])
      touch(join(base, dir, "nested", "file.json"));
    for (const db of ["state_5", "goals_1", "logs_2", "queue_1"])
      for (const suffix of ["", "-shm", "-wal"])
        touch(join(base, `${db}.sqlite${suffix}`));
    touch(join(base, "skills", "demo", "SKILL.md"));
    touch(join(base, "installation_id"));
    touch(join(base, "memories_1.sqlite"));
  }
}

async function seedMongo(client: MongoClient) {
  const catalog = client.db(CATALOG_DB);
  await catalog.collection("truex_models").insertOne({ _id: "m1" as never });
  await catalog.collection("truex_skills").insertOne({ _id: "s1" as never });
  await catalog.collection("tenants").insertMany([
    { _id: "acme" as never, dbName: "truex_t_acme", status: "active" },
    { _id: "globex" as never, dbName: "truex_t_globex", status: "disabled" },
  ]);
  for (const name of [TENANT_DB, "truex_t_acme", "truex_t_globex"]) {
    const db = client.db(name);
    for (const c of [...CHAT, ...KEPT_TENANT])
      await db.collection(c).insertMany([{ n: 1 }, { n: 2 }]);
  }
  await client.db(TENANT_DB).collection("truex_runs").insertOne({ n: 1 });
  // An unregistered database is not a tenant and stays untouched.
  await client.db("unrelated").collection("sessions").insertOne({ n: 1 });
}

async function counts(client: MongoClient) {
  const result: Record<string, number> = {};
  for (const name of [TENANT_DB, "truex_t_acme", "truex_t_globex"])
    for (const c of [...CHAT, ...KEPT_TENANT, "truex_runs"])
      result[`${name}.${c}`] = await client
        .db(name)
        .collection(c)
        .countDocuments();
  for (const c of KEPT_CATALOG)
    result[`${CATALOG_DB}.${c}`] = await client
      .db(CATALOG_DB)
      .collection(c)
      .countDocuments();
  result["unrelated.sessions"] = await client
    .db("unrelated")
    .collection("sessions")
    .countDocuments();
  return result;
}

const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

test("purge-chats: dry run, refusals, and a real run", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const client = await new MongoClient(mongo.getUri()).connect();
  const home = mkdtempSync(join(tmpdir(), "purge-chats-home-"));
  const outside = mkdtempSync(join(tmpdir(), "purge-chats-outside-"));
  t.after(async () => {
    await client.close();
    await mongo.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  await seedMongo(client);
  seedDisk(home);
  // A chat folder that links out of CODEX_HOME: only the link may go.
  touch(join(outside, "keep.txt"));
  rmSync(join(home, "business-v1", "shell_snapshots"), { recursive: true });
  symlinkSync(outside, join(home, "business-v1", "shell_snapshots"));

  const env = {
    MONGO_URI: mongo.getUri(),
    MONGO_DB: TENANT_DB,
    CATALOG_MONGO_DB: CATALOG_DB,
    CODEX_HOME: home,
    AGENT_CORE_URLS: `http://127.0.0.1:${await unusedPort()}`,
  };
  const before = await counts(client);
  const diskBefore = listing(home);

  await t.test("dry run writes nothing", async () => {
    const { code, out } = await run([], env);
    assert.equal(code, 0, out);
    assert.match(out, /\[dry run\] tenant "globex" \(disabled\)/);
    assert.match(out, /truex_runs: 1 would be deleted/);
    assert.match(out, /nothing was changed/);
    assert.deepEqual(await counts(client), before);
    assert.deepEqual(listing(home), diskBefore);
  });

  await t.test("real run without --confirm purge-chats refuses", async () => {
    for (const args of [["--confirm"], ["--confirm", "yes"], ["--force"]]) {
      const { code, out } = await run(args, env);
      assert.equal(code, 1, out);
      assert.match(out, /error:/);
    }
    assert.deepEqual(await counts(client), before);
    assert.deepEqual(listing(home), diskBefore);
  });

  await t.test(
    "real run refuses while agent-core answers /healthz",
    async () => {
      const server = createServer((_req, res) => {
        res.statusCode = 503; // even a draining agent-core counts as running
        res.end("{}");
      });
      const port = await listen(server);
      try {
        const { code, out } = await run(["--confirm", "purge-chats"], {
          ...env,
          AGENT_CORE_URLS: `${env.AGENT_CORE_URLS}, http://127.0.0.1:${port}/`,
        });
        assert.equal(code, 1, out);
        assert.match(out, /agent-core is running/);
      } finally {
        await close(server);
      }
      assert.deepEqual(await counts(client), before);
      assert.deepEqual(listing(home), diskBefore);
    },
  );

  await t.test("real run purges chats and keeps everything else", async () => {
    const { code, out } = await run(["--confirm", "purge-chats"], env);
    assert.equal(code, 0, out);
    assert.match(out, /restart agent-core/);
    const after = await counts(client);
    for (const name of [TENANT_DB, "truex_t_acme", "truex_t_globex"]) {
      for (const c of CHAT) assert.equal(after[`${name}.${c}`], 0, c);
      for (const c of KEPT_TENANT) assert.equal(after[`${name}.${c}`], 2, c);
    }
    assert.equal(after[`${TENANT_DB}.truex_runs`], 0);
    for (const c of KEPT_CATALOG)
      assert.equal(after[`${CATALOG_DB}.${c}`], before[`${CATALOG_DB}.${c}`]);
    assert.equal(after["unrelated.sessions"], 1);

    for (const base of [join(home, "business-v1"), home]) {
      const left = readdirSync(base).sort();
      const expected = ["installation_id", "memories_1.sqlite", "skills"];
      assert.deepEqual(
        left,
        base === home ? ["business-v1", ...expected] : expected,
      );
      assert.ok(existsSync(join(base, "skills", "demo", "SKILL.md")));
    }
    assert.ok(existsSync(join(outside, "keep.txt")), "symlink target kept");
  });
});
