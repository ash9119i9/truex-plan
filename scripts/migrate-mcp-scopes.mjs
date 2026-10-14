// Moves MCP profiles to tenant/user scopes (docs/USER_SCOPED_MCP_PLAN.md,
// "MCP: tenant and user scope"), in every tenant database including the
// default one (MONGO_DB):
//
//   npm run migrate:mcp-scopes                                   dry run
//   npm run migrate:mcp-scopes -- --confirm migrate-mcp-scopes   apply
//
// - profiles without an owner get scope "tenant" (with an owner: "user")
// - agent.mcpProfileIds attachments are added to each profile's agentIds
// - the scope indexes are created (same as platform/src/persistence/store.ts)
//
// Stored credentials are never read, decrypted, encrypted, moved or removed:
// apiKey, apikey and legacy apiKeyEnc keep their field names and values, and
// the platform reads each as it does today (platform/src/mcp/profiles.ts, secrets.ts).
// Encrypting plain keys is not part of this migration, because the platform
// no longer has an encryption path to do it with.
//
// agent.mcpProfileIds is left in place, but the platform no longer reads it.
// Every step is conditional, so running it again changes nothing.
//
// Names that would clash once scoped (two ownerless profiles named "qlik",
// or one owner with two of a name) are reported, and those profiles are left
// unscoped (never loaded) until an operator renames them and runs it again.
// The run then exits 1.
//
// Reads MONGO_URI, MONGO_DB and CATALOG_MONGO_DB (process env first, then
// platform/.env; dotenv never overrides set values).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "platform/package.json"));
const envFile = resolve(root, "platform/.env");
if (existsSync(envFile))
  require("dotenv").config({ path: envFile, quiet: true });
const { MongoClient, ObjectId } = require("mongodb");

const CONFIRM = "migrate-mcp-scopes";
const DEFAULT_TENANT_ID = "default";
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const database = process.env.MONGO_DB || "truex";
const catalogDatabase = process.env.CATALOG_MONGO_DB || database;

const usage = `usage: node scripts/migrate-mcp-scopes.mjs [--confirm ${CONFIRM}]
  (no arguments)                dry run: print what would change, write nothing
  --confirm ${CONFIRM}   apply to every tenant database`;

const args = process.argv.slice(2);
const confirmed =
  args.length === 2 && args[0] === "--confirm" && args[1] === CONFIRM;
if (args.length && !confirmed) {
  console.error(`error: unknown arguments ${args.join(" ")}\n${usage}`);
  process.exit(1);
}
const dryRun = !confirmed;
const prefix = dryRun ? "[dry run] " : "";
const would = (done, pending) => (dryRun ? pending : done);

// Same candidates as idCandidates() in platform/src/persistence/configuration-documents.ts.
const idCandidates = (id) => {
  const text = String(id);
  return ObjectId.isValid(text) ? [text, new ObjectId(text)] : [text];
};
const hasCredentialField = {
  $or: [
    { apiKey: { $exists: true } },
    { apikey: { $exists: true } },
    { apiKeyEnc: { $exists: true } },
  ],
};

// Same definitions as mcpIndexes() in platform/src/persistence/store.ts.
const INDEXES = [
  [
    { scope: 1, name: 1 },
    {
      name: "tenant_mcp_name",
      unique: true,
      partialFilterExpression: { scope: "tenant" },
    },
  ],
  [
    { ownerId: 1, name: 1 },
    {
      name: "user_mcp_name",
      unique: true,
      partialFilterExpression: { scope: "user" },
    },
  ],
  [{ agentIds: 1, scope: 1 }, {}],
];

// Every registered tenant database, plus the default one.
async function tenantDatabases(client) {
  const docs = await client
    .db(catalogDatabase)
    .collection("tenants")
    .find({}, { projection: { dbName: 1 } })
    .toArray();
  const names = new Map([[database, DEFAULT_TENANT_ID]]);
  for (const d of docs)
    if (d._id !== DEFAULT_TENANT_ID && typeof d.dbName === "string")
      names.set(d.dbName, d._id);
  return [...names].map(([dbName, tenant]) => ({ dbName, tenant }));
}

// The scope a profile has, or gets from step 1.
const scopeOf = (p) => p.scope || (p.ownerId ? "user" : "tenant");
// What the unique indexes compare, per scope.
const nameKey = (p) =>
  scopeOf(p) === "tenant" ? `tenant:${p.name}` : `user:${p.ownerId}/${p.name}`;

async function migrate(db, label) {
  const mcp = db.collection("truex_mcp");
  const agents = db.collection("truex_agents");
  const now = new Date().toISOString();
  let ok = true;

  // 1. Scopes, except for profiles whose name would clash once scoped.
  const all = await mcp
    .find({}, { projection: { scope: 1, ownerId: 1, name: 1 } })
    .toArray();
  const counts = new Map();
  for (const p of all) counts.set(nameKey(p), (counts.get(nameKey(p)) || 0) + 1);
  const clashing = new Set(
    [...counts].filter(([, n]) => n > 1).map(([key]) => key),
  );
  for (const key of clashing) {
    const [scope, name] = key.split(/:(.*)/s);
    console.error(
      `error: ${label}: several ${scope} MCP profiles are named ${scope === "tenant" ? name : `${name} (owner/name)`}; rename all but one, then run again. Until then the unscoped ones are left as they are and never load.`,
    );
    ok = false;
  }
  const unscoped = all.filter((p) => !p.scope && !clashing.has(nameKey(p)));
  const held = all.filter((p) => !p.scope && clashing.has(nameKey(p))).length;
  const toTenant = unscoped.filter((p) => !p.ownerId).map((p) => p._id);
  const toUser = unscoped.filter((p) => p.ownerId).map((p) => p._id);
  if (!dryRun)
    for (const [ids, scope] of [
      [toTenant, "tenant"],
      [toUser, "user"],
    ])
      if (ids.length)
        await mcp.updateMany(
          { _id: { $in: ids }, scope: { $exists: false } },
          { $set: { scope, updatedAt: now } },
        );
  console.log(
    `${prefix}${label}: ${toTenant.length} profile(s) ${would("marked", "would be marked")} scope "tenant", ${toUser.length} with an owner ${would("marked", "would be marked")} "user"${held ? `, ${held} left unscoped (name clash)` : ""}`,
  );

  // 2. Attachments: agent.mcpProfileIds -> profile.agentIds.
  let attached = 0,
    missing = 0;
  const withIds = await agents
    .find(
      { "mcpProfileIds.0": { $exists: true } },
      { projection: { mcpProfileIds: 1 } },
    )
    .toArray();
  for (const agent of withIds) {
    const agentKey = String(agent._id);
    for (const id of agent.mcpProfileIds) {
      const profile = await mcp.findOne(
        { _id: { $in: idCandidates(id) } },
        { projection: { agentIds: 1 } },
      );
      if (!profile) {
        missing++;
        console.warn(
          `${prefix}${label}: agent ${agentKey} lists missing MCP profile ${String(id)} (skipped)`,
        );
        continue;
      }
      if ((profile.agentIds || []).map(String).includes(agentKey)) continue;
      if (!dryRun)
        await mcp.updateOne(
          { _id: profile._id },
          { $addToSet: { agentIds: agentKey }, $set: { updatedAt: now } },
        );
      attached++;
    }
  }
  // Profiles never attached anywhere still get an (empty) agentIds.
  const noAgentIds = await mcp.countDocuments({ agentIds: { $exists: false } });
  if (!dryRun && noAgentIds)
    await mcp.updateMany(
      { agentIds: { $exists: false } },
      { $set: { agentIds: [] } },
    );
  console.log(
    `${prefix}${label}: ${attached} attachment(s) ${would("moved", "would be moved")} into agentIds from ${withIds.length} agent(s)${missing ? `, ${missing} missing profile reference(s) skipped` : ""}; agent.mcpProfileIds left in place (unread)`,
  );

  // 3. Credentials are only counted. Nothing in them is read or written.
  const withCredential = await mcp.countDocuments(hasCredentialField);
  console.log(
    `${prefix}${label}: ${withCredential} profile(s) with a stored API key left as they are`,
  );

  // 4. Indexes. One that cannot be built (profiles scoped before this run
  // that already clash) is reported, and the others are still created.
  if (!dryRun)
    for (const [keys, options] of INDEXES)
      try {
        await mcp.createIndex(keys, options);
      } catch (error) {
        ok = false;
        console.error(
          `error: ${label}: index ${options.name || Object.keys(keys).join("_")} could not be created: ${error.message}`,
        );
      }
  console.log(
    `${prefix}${label}: MCP indexes ${would("ensured", "would be ensured")}`,
  );
  return ok;
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
try {
  await client.connect();
  const targets = await tenantDatabases(client);
  console.log(
    `${prefix}migrating MCP scopes in ${targets.length} tenant database(s): ${targets.map((t) => `${t.tenant} (${t.dbName})`).join(", ")}`,
  );

  let ok = true;
  for (const { dbName, tenant } of targets)
    ok = (await migrate(client.db(dbName), tenant)) && ok;
  if (!ok) process.exitCode = 1;
  console.log(
    `${prefix}done${ok ? "" : " with errors (see above)"}.${dryRun ? ` Nothing was written; apply with --confirm ${CONFIRM}.` : ""}`,
  );
} catch (error) {
  console.error(`error: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
