// Purges chats from local dev data: conversations, messages, traces and
// projects in every tenant database, plus agent-core's chat files on disk.
//
//   npm run purge:chats                            dry run: counts only
//   npm run purge:chats -- --confirm purge-chats   delete (agent-core stopped)
//
// Keeps agents, MCP profiles, models, skills, tenants, CODEX_HOME's skills/
// and installation_id. Never drops a database: the catalog can share the
// default tenant's database.
//
// Reads MONGO_URI, MONGO_DB, CATALOG_MONGO_DB, CODEX_HOME and AGENT_CORE_URLS
// (process env first, then platform/.env; dotenv never overrides set values).
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "platform/package.json"));
const envFile = resolve(root, "platform/.env");
if (existsSync(envFile))
  require("dotenv").config({ path: envFile, quiet: true });
const { MongoClient } = require("mongodb");

const CONFIRM = "purge-chats";
const DEFAULT_TENANT_ID = "default";
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const database = process.env.MONGO_DB || "truex";
const catalogDatabase = process.env.CATALOG_MONGO_DB || database;
// Same default as agent-core (index.ts): <repo>/.runtime/codex.
const codexHome = resolve(
  process.env.CODEX_HOME || join(root, ".runtime/codex"),
);
// Same parsing as the platform (service.ts).
const agentCoreUrls = (
  process.env.AGENT_CORE_URLS ||
  process.env.AGENT_CORE_URL ||
  "http://127.0.0.1:4100"
)
  .split(",")
  .map((x) => x.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Chat collections in each tenant database (store.ts), plus the pre-tenancy
// copies, deleted only when present.
const CHAT_COLLECTIONS = ["sessions", "messages", "traces", "projects"];
const LEGACY_COLLECTIONS = [
  "truex_runs",
  "truex_conversations",
  "truex_live_sessions",
];
// Chat state under business-v1/ (agent-core's home) and the legacy top level.
const CHAT_DIRS = [
  "sessions",
  "archived_sessions",
  "thread-writer-locks",
  "business-threads",
  "business-workspaces",
  "adapter-records",
  "shell_snapshots",
];
const CHAT_DB_PREFIXES = [
  "state_5.sqlite",
  "goals_1.sqlite",
  "logs_2.sqlite",
  "queue_1.sqlite",
];

const usage = `usage: node scripts/purge-chats.mjs [--confirm ${CONFIRM}]
  (no arguments)          dry run: print what would be removed, write nothing
  --confirm ${CONFIRM}   delete chats in every tenant and CODEX_HOME (stop agent-core first)`;

class CliError extends Error {}
const fail = (message) => {
  throw new CliError(message);
};

function parseArgs(argv) {
  if (!argv.length) return { confirm: false };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help"))
    return { help: true };
  const [flag, value, ...rest] = argv;
  if (flag !== "--confirm" || rest.length)
    fail(`unknown argument ${argv.join(" ")}\n${usage}`);
  if (value !== CONFIRM)
    fail(`refusing to purge: pass --confirm ${CONFIRM} exactly\n${usage}`);
  return { confirm: true };
}

// Any HTTP answer (even 503 while draining) means agent-core is running.
async function runningAgentCores() {
  const running = [];
  await Promise.all(
    agentCoreUrls.map(async (url) => {
      try {
        const response = await fetch(url + "/healthz", {
          signal: AbortSignal.timeout(1500),
        });
        await response.body?.cancel();
        running.push(`${url} (HTTP ${response.status})`);
      } catch {
        // Unreachable: not running.
      }
    }),
  );
  return running;
}

// Registered tenants (disabled included) plus the implicit default database.
async function tenantDatabases(client) {
  const docs = await client
    .db(catalogDatabase)
    .collection("tenants")
    .find({}, { projection: { dbName: 1, status: 1 } })
    .sort({ _id: 1 })
    .toArray();
  const list = [{ id: DEFAULT_TENANT_ID, dbName: database, status: "active" }];
  for (const d of docs) {
    if (d._id === DEFAULT_TENANT_ID) {
      list[0].status = d.status ?? "active";
      continue;
    }
    if (typeof d.dbName !== "string" || !d.dbName) continue;
    list.push({ id: d._id, dbName: d.dbName, status: d.status ?? "active" });
  }
  const seen = new Set();
  return list.filter((t) => !seen.has(t.dbName) && seen.add(t.dbName));
}

async function purgeMongo(client, confirm) {
  const prefix = confirm ? "" : "[dry run] ";
  let total = 0;
  for (const tenant of await tenantDatabases(client)) {
    const db = client.db(tenant.dbName);
    const present = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map(
        (c) => c.name,
      ),
    );
    const names = [
      ...CHAT_COLLECTIONS,
      ...LEGACY_COLLECTIONS.filter((n) => present.has(n)),
    ];
    console.log(
      `${prefix}tenant "${tenant.id}" (${tenant.status}) -> database ${tenant.dbName}`,
    );
    for (const name of names) {
      const collection = db.collection(name);
      const count = present.has(name)
        ? confirm
          ? (await collection.deleteMany({})).deletedCount
          : await collection.countDocuments({})
        : 0;
      total += count;
      console.log(
        `${prefix}  ${name}: ${count} ${confirm ? "deleted" : "would be deleted"}`,
      );
    }
  }
  return total;
}

// Counts files under a path without following symlinks.
function countFiles(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return 1;
  let n = 0;
  for (const entry of readdirSync(path)) n += countFiles(join(path, entry));
  return n;
}

// Resolves a chat path inside home, refusing anything that escapes it.
function inside(home, dir, name) {
  const target = resolve(dir, name);
  if (!target.startsWith(home + sep))
    fail(`refusing ${target}: outside ${home}`);
  return target;
}

function chatTargets(home, dir) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return [];
  // A symlinked business-v1/ could point anywhere.
  if (!stat.isDirectory()) fail(`refusing ${dir}: not a plain directory`);
  const entries = readdirSync(dir);
  const names = [
    ...CHAT_DIRS.filter((n) => entries.includes(n)),
    ...entries
      .filter((e) => CHAT_DB_PREFIXES.some((p) => e.startsWith(p)))
      .sort(),
  ];
  return names.map((name) => inside(home, dir, name));
}

function purgeDisk(confirm) {
  const prefix = confirm ? "" : "[dry run] ";
  if (!existsSync(codexHome)) {
    console.log(
      `${prefix}CODEX_HOME ${codexHome} does not exist; nothing on disk`,
    );
    return 0;
  }
  if (!lstatSync(codexHome).isDirectory())
    fail(`refusing CODEX_HOME ${codexHome}: not a directory`);
  // Real path, so a symlinked CODEX_HOME still bounds every target.
  const home = realpathSync(codexHome);
  let total = 0;
  for (const dir of [join(home, "business-v1"), home]) {
    const targets = chatTargets(home, dir);
    console.log(`${prefix}${dir}${targets.length ? "" : ": no chat files"}`);
    for (const target of targets) {
      const isLink = lstatSync(target).isSymbolicLink();
      const files = countFiles(target);
      // rmSync removes a symlink itself and never recurses through one.
      if (confirm) rmSync(target, { recursive: true, force: true });
      total += files;
      const kind = isLink ? " (symlink, link only)" : "";
      console.log(
        `${prefix}  ${target.slice(dir.length + 1)}${kind}: ${files} file(s) ${confirm ? "removed" : "would be removed"}`,
      );
    }
  }
  return total;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage);
    return;
  }
  const { confirm } = args;
  const running = await runningAgentCores();
  if (running.length) {
    if (confirm)
      fail(
        `agent-core is running (${running.join(", ")}); stop it before purging`,
      );
    console.log(
      `[dry run] note: agent-core answers at ${running.join(", ")}; stop it before a real run`,
    );
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  let documents;
  try {
    documents = await purgeMongo(client, confirm);
  } finally {
    await client.close();
  }
  const files = purgeDisk(confirm);
  if (confirm) {
    console.log(
      `purged ${documents} document(s) and ${files} file(s) under ${codexHome}`,
    );
    console.log("restart agent-core before using the app again");
  } else {
    console.log(
      `[dry run] would purge ${documents} document(s) and ${files} file(s); nothing was changed`,
    );
    console.log(
      `run with --confirm ${CONFIRM} to delete (stop agent-core first)`,
    );
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof CliError ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
