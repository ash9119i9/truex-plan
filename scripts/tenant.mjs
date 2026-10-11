// Tenant registry CLI. Tenants live in the catalog database (`tenants`); each
// tenant's agents, MCP profiles and conversations live in its own database.
//
//   npm run tenant -- create <id> <name...>
//   npm run tenant -- list
//   npm run tenant -- disable <id> | enable <id>
//   npm run tenant -- allow-models <id> <modelId...|--all>
//   npm run tenant -- allow-skills <id> <skillId...|--all>
//   npm run tenant -- chat-visibility <id> own|all
//   npm run tenant -- admission <id> open|inviteOnly
//   npm run tenant -- agent-indexes <id>
//   npm run tenant -- provision-demo [id] [--name <name...>] [--dry-run]
//   npm run tenant -- provision-default [id] [--name <name...>] [--dry-run]
//   npm run tenant -- drop <id> --confirm <id>
//   npm run tenant -- invite <id> <email> --role admin|user
//   npm run tenant -- members <id>
//
// Reads MONGO_URI, MONGO_DB and CATALOG_MONGO_DB (process env first, then
// platform/.env). Unset CATALOG_MONGO_DB means the catalog is MONGO_DB.
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

const DEFAULT_TENANT_ID = "default";
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const database = process.env.MONGO_DB || "truex";
const catalogDatabase = process.env.CATALOG_MONGO_DB || database;

const usage = `usage: node scripts/tenant.mjs <command>
  create <id> <name...>                 register a tenant and create its indexes
  list                                  list registered tenants
  disable <id> | enable <id>            block or allow a tenant's requests
  allow-models <id> <modelId...|--all|--none>
  allow-skills <id> <skillId...|--all|--none>
                                        restrict catalog entries (--all lifts the
                                        restriction, --none approves nothing)
  chat-visibility <id> own|all          who can read chats (unset means all); a private
                                        workspace cannot be made shared
  admission <id> open|inviteOnly        who may join (open: the demo tenant only)
  agent-indexes <id>                    read-only: agent handle indexes, duplicates and
                                        ownerless agents (for the staged index migration)
  provision-demo [id] [--name <n...>] [--dry-run]
                                        register a fresh, empty, private demo workspace
                                        (default id "demo"); repeatable, never copies data
  provision-default [id] [--name <n...>] [--dry-run]
                                        provision the private default signup workspace
                                        (default id "default-tenant", name "Default tenant")
  drop <id> --confirm <id>              delete a tenant database and registry entry
  invite <id> <email> --role admin|user create an invite and print its link (no email)
  members <id>                          list active members with role and last sign-in`;

class CliError extends Error {}
const fail = (message) => {
  throw new CliError(message);
};
const validId = (id) => {
  if (typeof id !== "string" || !TENANT_ID.test(id))
    fail(
      `invalid tenant id "${id ?? ""}": use ${TENANT_ID} (lowercase letters, digits, "-")`,
    );
  return id;
};
// Server-generated; never taken from user input beyond the validated id.
const dbNameFor = (id) =>
  id === DEFAULT_TENANT_ID
    ? database
    : "truex_t_" + validId(id).replace(/-/g, "_");
const now = () => new Date().toISOString();

// Same rules as emailKey/validEmail in platform/src/auth.ts: the whole address
// is lower-cased; Gmail (gmail.com, googlemail.com) drops dots and the +tag and
// maps to gmail.com; every other domain keeps its dots and +tags. Only plain
// ASCII addresses are accepted. platform/test covers both with shared vectors.
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const emailKey = (email) => {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1) return value;
  if (!GMAIL_DOMAINS.has(value.slice(at + 1))) return value;
  const local = value.slice(0, at).split("+")[0].replace(/\./g, "");
  return `${local}@gmail.com`;
};
const validEmail = (value) => {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  const lower = email.toLowerCase();
  if (email.length > 254 || !EMAIL.test(lower)) return undefined;
  const local = lower.slice(0, lower.lastIndexOf("@"));
  if (local.startsWith(".") || local.endsWith(".") || local.includes(".."))
    return undefined;
  if (emailKey(lower).startsWith("@")) return undefined;
  return email;
};
const INVITE_LIFETIME_MS = 7 * 86_400_000;
const inviteLink = (token) =>
  `${(process.env.APP_PUBLIC_URL || process.env.FRONTEND_ORIGIN || "http://localhost:3000").replace(/\/+$/, "")}/invite/${token}`;

// Same definitions as agentIndexes()/tenantIndexes() in platform/src/store.ts.
// A private tenant keys agent handles by creator and never gets the
// workspace-wide handle index.
async function tenantIndexes(db, creatorHandles = false) {
  await Promise.all([
    db.collection("messages").createIndex({ sessionId: 1, at: 1 }),
    db.collection("sessions").createIndex({ status: 1 }),
    db.collection("traces").createIndex({ sessionId: 1, startedAt: 1 }),
    db.collection("sessions").createIndex({ projectId: 1, createdAt: -1 }),
    db.collection("sessions").createIndex({ userId: 1, createdAt: -1 }),
    db.collection("projects").createIndex({ ownerId: 1, updatedAt: -1 }),
    ...(creatorHandles
      ? [
          db.collection("truex_agents").createIndex(
            { createdBy: 1, handle: 1 },
            {
              name: "agent_creator_handle",
              unique: true,
              partialFilterExpression: {
                createdBy: { $type: "string" },
                handle: { $type: "string" },
              },
            },
          ),
          db
            .collection("truex_agents")
            .createIndex({ createdBy: 1, enabled: 1 }),
        ]
      : [
          db
            .collection("truex_agents")
            .createIndex({ handle: 1 }, { unique: true, sparse: true }),
        ]),
    ...mcpIndexes(db),
  ]);
}
// Same definitions as mcpIndexes() in platform/src/store.ts.
function mcpIndexes(db) {
  const mcp = db.collection("truex_mcp");
  return [
    mcp.createIndex(
      { scope: 1, name: 1 },
      {
        name: "tenant_mcp_name",
        unique: true,
        partialFilterExpression: { scope: "tenant" },
      },
    ),
    mcp.createIndex(
      { ownerId: 1, name: 1 },
      {
        name: "user_mcp_name",
        unique: true,
        partialFilterExpression: { scope: "user" },
      },
    ),
    mcp.createIndex({ agentIds: 1, scope: 1 }),
  ];
}
async function catalogIndexes(catalog) {
  await Promise.all([
    catalog.collection("tenants").createIndex({ dbName: 1 }, { unique: true }),
    catalog
      .collection("truex_skills")
      .createIndex({ name: 1 }, { unique: true }),
  ]);
}

// The single effective privacy value of a registry record, as in
// effectivePrivacy() in platform/src/tenant.ts: the canonical isUserSpecific
// and the legacy chatVisibility alias must agree when both are present.
const effectivePrivate = (doc) => {
  const canonicalPresent = doc.isUserSpecific !== undefined;
  const legacyPresent = doc.chatVisibility !== undefined;
  const canonical =
    typeof doc.isUserSpecific === "boolean" ? doc.isUserSpecific : undefined;
  const legacy =
    doc.chatVisibility === "own"
      ? true
      : doc.chatVisibility === "all"
        ? false
        : undefined;
  if (canonicalPresent && canonical === undefined) return { invalid: true };
  if (legacyPresent && legacy === undefined) return { invalid: true };
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy)
    return { invalid: true };
  return { value: canonical ?? legacy, invalid: false };
};
// The names of a database's agent indexes ([] when there is no collection yet).
// Any other failure is real and is raised, never read as "no indexes".
async function agentIndexNames(db) {
  try {
    return (await db.collection("truex_agents").indexes()).map((i) => i.name);
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound")
      return [];
    throw error;
  }
}
// A private workspace keys agent handles by creator. A workspace-wide handle_1
// would make two people's agents with the same name collide, so the demo is not
// ready while it exists. This tool creates handle_1 only for non-private
// workspaces, so finding it on a private one means something else added it.
const handleIndexProblem = (dbName) =>
  `${dbName} has a workspace-wide agent handle index (handle_1); a private workspace must not. ` +
  "This tool only creates it for non-private workspaces, so a copy of the platform from before " +
  "owner-aware agents is probably connected to this database and added it (that version adds it to " +
  "every registered workspace). Stop or upgrade that copy, then drop the index " +
  `(mongosh: use ${dbName}; db.truex_agents.dropIndex("handle_1")) and run provision-demo again. ` +
  "Not touching it.";

// A database that holds data but is not registered must never be adopted by a
// new tenant. Empty collections (an interrupted earlier run) are fine.
async function populatedCollections(db) {
  const found = [];
  for (const { name } of await db
    .listCollections({}, { nameOnly: true })
    .toArray()) {
    if (name.startsWith("system.")) continue;
    if (await db.collection(name).findOne({}, { projection: { _id: 1 } }))
      found.push(name);
  }
  return found;
}

// Catalog ids may be strings or ObjectIds; allow-lists store them as strings.
const idQuery = (id) =>
  ObjectId.isValid(id) && String(new ObjectId(id)) === id
    ? { _id: { $in: [id, new ObjectId(id)] } }
    : { _id: id };

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(usage);
    return;
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  try {
    const catalog = client.db(catalogDatabase);
    const tenants = catalog.collection("tenants");
    const find = async (id) => {
      const doc = await tenants.findOne({ _id: validId(id) });
      if (doc) return doc;
      // The default tenant exists implicitly; register it on first change.
      if (id === DEFAULT_TENANT_ID) {
        const created = {
          _id: id,
          name: "Default",
          dbName: database,
          status: "active",
          createdAt: now(),
          updatedAt: now(),
        };
        await catalogIndexes(catalog);
        await tenants.insertOne(created);
        return created;
      }
      fail(`tenant "${id}" is not registered`);
    };

    switch (command) {
      case "create": {
        const [id, ...nameParts] = args;
        validId(id);
        const name = nameParts.join(" ").trim();
        if (!name) fail("usage: create <id> <name...>");
        const existing = await tenants.findOne({ _id: id });
        if (existing) {
          console.log(
            `tenant "${id}" already exists (db ${existing.dbName}, ${existing.status}); nothing changed`,
          );
          return;
        }
        const dbName = dbNameFor(id);
        if (dbName === catalogDatabase && id !== DEFAULT_TENANT_ID)
          fail(
            `tenant database ${dbName} would collide with the catalog database`,
          );
        const owner = await tenants.findOne({ dbName });
        if (owner)
          fail(`database ${dbName} already belongs to tenant "${owner._id}"`);
        if (id !== DEFAULT_TENANT_ID) {
          const populated = await populatedCollections(client.db(dbName));
          if (populated.length)
            fail(
              `database ${dbName} already contains data (${populated.join(", ")}) and is not registered; nothing was changed`,
            );
        }
        await catalogIndexes(catalog);
        // New workspaces are invite-only and private. Old readers know only
        // chatVisibility, so it is written alongside isUserSpecific.
        await tenants.insertOne({
          _id: id,
          name,
          dbName,
          status: "active",
          admissionPolicy: "inviteOnly",
          isUserSpecific: true,
          chatVisibility: "own",
          createdAt: now(),
          updatedAt: now(),
        });
        await tenantIndexes(client.db(dbName), true);
        console.log(`created tenant "${id}" (${name}) -> database ${dbName}`);
        return;
      }
      case "list": {
        const docs = await tenants.find({}).sort({ _id: 1 }).toArray();
        if (!docs.some((d) => d._id === DEFAULT_TENANT_ID))
          console.log(
            `default\tactive\t${database}\t(implicit, not registered)`,
          );
        for (const d of docs) {
          const limits = [
            d.allowedModelIds
              ? `models=${d.allowedModelIds.join(",")}`
              : "models=all",
            d.allowedSkillIds
              ? `skills=${d.allowedSkillIds.join(",")}`
              : "skills=all",
            (() => {
              const p = effectivePrivate(d);
              return `chats=${p.invalid ? "INVALID" : p.value === undefined ? "all" : p.value ? "own" : "all"}`;
            })(),
            `admission=${d.admissionPolicy ?? "inviteOnly"}`,
          ].join(" ");
          console.log(
            `${d._id}\t${d.status}\t${d.dbName}\t${d.name}\t${limits}`,
          );
        }
        if (!docs.length && catalogDatabase === database)
          console.log(`(catalog database: ${catalogDatabase})`);
        return;
      }
      case "disable":
      case "enable": {
        const [id] = args;
        const doc = await find(id);
        const status = command === "disable" ? "disabled" : "active";
        if (doc.status === status) {
          console.log(`tenant "${id}" is already ${status}`);
          return;
        }
        await tenants.updateOne(
          { _id: id },
          { $set: { status, updatedAt: now() } },
        );
        console.log(`tenant "${id}" is now ${status}`);
        if (status === "disabled") {
          // Signed-in people are signed out now, not only refused on their next
          // request. Nothing else is touched; the data stays.
          const { deletedCount } = await catalog
            .collection("auth_sessions")
            .deleteMany({ tenantId: id, app: "main" });
          console.log(`ended ${deletedCount} signed-in session(s)`);
          console.log(
            "note: this does not ask the assistant runtime to stop running turns; the admin API (PATCH /api/admin/tenants/<id>) does that too",
          );
        }
        return;
      }
      case "allow-models":
      case "allow-skills": {
        const [id, ...ids] = args;
        const field =
          command === "allow-models" ? "allowedModelIds" : "allowedSkillIds";
        const collection =
          command === "allow-models" ? "truex_models" : "truex_skills";
        if (!ids.length)
          fail(
            `usage: ${command} <id> <${collection === "truex_models" ? "modelId" : "skillId"}...|--all|--none>`,
          );
        await find(id);
        if (ids.includes("--none")) {
          if (ids.length > 1) fail("--none cannot be combined with ids");
          await tenants.updateOne(
            { _id: id },
            { $set: { [field]: [], updatedAt: now() } },
          );
          console.log(`tenant "${id}": ${field} = (none approved)`);
          return;
        }
        if (ids.includes("--all")) {
          if (ids.length > 1) fail("--all cannot be combined with ids");
          await tenants.updateOne(
            { _id: id },
            { $unset: { [field]: "" }, $set: { updatedAt: now() } },
          );
          console.log(
            `tenant "${id}": ${field} restriction removed (all enabled entries allowed)`,
          );
          return;
        }
        const unique = [...new Set(ids)];
        const missing = [];
        for (const entry of unique)
          if (
            !(await catalog
              .collection(collection)
              .findOne(idQuery(entry), { projection: { _id: 1 } }))
          )
            missing.push(entry);
        if (missing.length)
          fail(
            `not found in ${catalogDatabase}.${collection}: ${missing.join(", ")}`,
          );
        await tenants.updateOne(
          { _id: id },
          { $set: { [field]: unique, updatedAt: now() } },
        );
        console.log(`tenant "${id}": ${field} = ${unique.join(", ")}`);
        return;
      }
      case "chat-visibility": {
        const [id, value, ...rest] = args;
        if ((value !== "own" && value !== "all") || rest.length)
          fail("usage: chat-visibility <id> own|all");
        // Registers the implicit default tenant on first change.
        const doc = await find(id);
        const current = effectivePrivate(doc);
        const wantPrivate = value === "own";
        // Making a private workspace shared would show its history to every
        // member; that is not a live toggle. A record whose two privacy fields
        // disagree can only be repaired towards private.
        if (!wantPrivate && (current.invalid || current.value === true))
          fail(
            `tenant "${id}" is private; making it shared would expose its history and needs a separate reviewed change`,
          );
        if (current.value === wantPrivate && !current.invalid) {
          console.log(`tenant "${id}": chatVisibility is already ${value}`);
          return;
        }
        // Both spellings together, so old and new readers agree.
        await tenants.updateOne(
          { _id: id },
          {
            $set: {
              isUserSpecific: wantPrivate,
              chatVisibility: value,
              updatedAt: now(),
            },
          },
        );
        console.log(`tenant "${id}": chatVisibility = ${value}`);
        return;
      }
      case "admission": {
        const [id, value, ...rest] = args;
        if ((value !== "open" && value !== "inviteOnly") || rest.length)
          fail("usage: admission <id> open|inviteOnly");
        const doc = await find(id);
        if (value === "open") {
          // Open admission is for the one configured demo tenant only, and
          // only for a private, active workspace.
          const demoId = process.env.DEMO_TENANT_ID?.trim();
          if (!demoId || demoId !== id || id === DEFAULT_TENANT_ID)
            fail(
              `open admission is only for the configured demo tenant: set DEMO_TENANT_ID=${id} first`,
            );
          if (doc.status !== "active") fail(`tenant "${id}" is disabled`);
          const p = effectivePrivate(doc);
          if (p.invalid || p.value !== true)
            fail(
              `tenant "${id}" must be private (isUserSpecific) before it is opened`,
            );
          if (
            !Array.isArray(doc.allowedModelIds) ||
            !doc.allowedModelIds.length
          )
            fail(
              `tenant "${id}" has no approved models: run allow-models ${id} <modelId...> first`,
            );
          if (!Array.isArray(doc.allowedSkillIds))
            fail(
              `tenant "${id}" has no skill allow-list: run allow-skills ${id} <skillId...> (or --none) first`,
            );
        }
        if (value === "open") {
          // The same indexes the platform's readiness check looks for.
          const names = await agentIndexNames(client.db(doc.dbName));
          if (!names.includes("agent_creator_handle"))
            fail(
              `tenant "${id}" has no per-creator handle index: run provision-demo ${id}`,
            );
          if (names.includes("handle_1")) fail(handleIndexProblem(doc.dbName));
        }
        if (
          (doc.admissionPolicy ?? "inviteOnly") === value &&
          doc.admissionPolicy
        ) {
          console.log(`tenant "${id}": admission is already ${value}`);
          return;
        }
        await tenants.updateOne(
          { _id: id },
          { $set: { admissionPolicy: value, updatedAt: now() } },
        );
        console.log(`tenant "${id}": admission = ${value}`);
        return;
      }
      case "agent-indexes": {
        const [id, ...rest] = args;
        if (rest.length) fail("usage: agent-indexes <id>");
        const doc = await find(id);
        const agents = client.db(doc.dbName).collection("truex_agents");
        const names = (await agents.indexes().catch(() => [])).map(
          (i) => i.name,
        );
        console.log(`tenant "${id}" -> ${doc.dbName}`);
        console.log(`  indexes: ${names.join(", ") || "(none)"}`);
        console.log(
          `  workspace-wide handle index (handle_1): ${names.includes("handle_1") ? "present" : "absent"}`,
        );
        console.log(
          `  per-creator handle index (agent_creator_handle): ${names.includes("agent_creator_handle") ? "present" : "absent"}`,
        );
        const dupes = await agents
          .aggregate([
            { $match: { handle: { $type: "string" } } },
            { $group: { _id: "$handle", n: { $sum: 1 } } },
            { $match: { n: { $gt: 1 } } },
            { $limit: 50 },
          ])
          .toArray();
        console.log(
          `  handles used by more than one agent: ${dupes.length}${dupes.length ? " (" + dupes.map((d) => `${d._id}x${d.n}`).join(", ") + ")" : ""}`,
        );
        const clash = await agents
          .aggregate([
            {
              $match: {
                createdBy: { $type: "string" },
                handle: { $type: "string" },
              },
            },
            {
              $group: {
                _id: { by: "$createdBy", handle: "$handle" },
                n: { $sum: 1 },
              },
            },
            { $match: { n: { $gt: 1 } } },
            { $limit: 50 },
          ])
          .toArray();
        console.log(
          `  creator + handle pairs used twice (would block the per-creator index): ${clash.length}`,
        );
        console.log(
          `  agents without a creator (admin-readable only in a private workspace): ${await agents.countDocuments({ createdBy: { $exists: false } })}`,
        );
        console.log(
          "  This command changes nothing. Removing handle_1 is a separate, reviewed step: see docs/mongodb.md.",
        );
        return;
      }
      case "provision-default":
      case "provision-demo": {
        const isDefault = command === "provision-default";
        const flags = new Set(["--dry-run"]);
        const dryRun = args.includes("--dry-run");
        const nameAt = args.indexOf("--name");
        const positional = args.filter(
          (a, i) =>
            !flags.has(a) && a !== "--name" && !(nameAt >= 0 && i > nameAt),
        );
        if (positional.length > 1)
          fail(`usage: ${command} [id] [--name <name...>] [--dry-run]`);
        const id = validId(
          positional[0] ??
            (isDefault
              ? process.env.DEFAULT_SIGNUP_TENANT_ID?.trim() || "default-tenant"
              : "demo"),
        );
        const defaultName = isDefault ? "Default tenant" : "Demo";
        const name =
          (nameAt >= 0
            ? args
                .slice(nameAt + 1)
                .filter((a) => !flags.has(a))
                .join(" ")
            : defaultName
          ).trim() || defaultName;
        if (id === DEFAULT_TENANT_ID)
          fail('public signup cannot use the implicit legacy "default" tenant');
        const dbName = dbNameFor(id);
        if (dbName === catalogDatabase || dbName === database)
          fail(
            `database ${dbName} is shared with the catalog or the default tenant`,
          );
        const say = (line) =>
          console.log(`${dryRun ? "[dry run] " : ""}${line}`);
        // Whoever owns the database name in the registry must be this tenant.
        const holder = await tenants.findOne({ dbName });
        if (holder && holder._id !== id)
          fail(`database ${dbName} already belongs to tenant "${holder._id}"`);
        const existing = await tenants.findOne({ _id: id });
        if (existing && existing.dbName !== dbName)
          fail(
            `tenant "${id}" maps to ${existing.dbName}, not the generated ${dbName}; refusing`,
          );
        if (!existing) {
          // Not registered: the database must be empty, whatever else it is.
          const populated = await populatedCollections(client.db(dbName));
          if (populated.length)
            fail(
              `database ${dbName} already contains data (${populated.join(", ")}) and is not registered; refusing to adopt it`,
            );
          // Found before anything is written, so a refusal leaves no half-registered tenant.
          if ((await agentIndexNames(client.db(dbName))).includes("handle_1"))
            fail(`${handleIndexProblem(dbName)} Nothing was registered.`);
          say(
            `${dryRun ? "would register" : "registering"} tenant "${id}" (${name}) -> database ${dbName}, private, invite-only`,
          );
        } else {
          if (isDefault && (existing.kind === "personal" || existing.createdBy))
            fail(
              `tenant "${id}" was customer-created; refusing to adopt it for public signup`,
            );
          const p = effectivePrivate(existing);
          if (p.invalid || p.value !== true)
            fail(
              `tenant "${id}" exists but is not private (isUserSpecific); public signup requires it`,
            );
          say(
            `tenant "${id}" is already registered (${existing.status}, admission ${existing.admissionPolicy ?? "inviteOnly"}); verifying only`,
          );
        }
        if (dryRun) {
          say(
            `would create owner-aware indexes in ${dbName} (no workspace-wide handle index)`,
          );
          say("would seed no agents, connectors or credentials");
          return;
        }
        await catalogIndexes(catalog);
        if (!existing)
          await tenants.insertOne({
            _id: id,
            name,
            dbName,
            status: "active",
            admissionPolicy: "inviteOnly",
            isUserSpecific: true,
            chatVisibility: "own",
            ...(isDefault
              ? { kind: "team", provisioningStatus: "pending" }
              : {}),
            createdAt: now(),
            updatedAt: now(),
          });
        await tenantIndexes(client.db(dbName), true);
        // Verify what was built.
        const agentIndexes = (
          await client.db(dbName).collection("truex_agents").indexes()
        ).map((i) => i.name);
        if (!agentIndexes.includes("agent_creator_handle"))
          fail("the creator handle index was not created");
        if (agentIndexes.includes("handle_1"))
          fail(
            `${handleIndexProblem(dbName)} The tenant "${id}" stays registered (invite-only), and the demo admits no one while the index exists.`,
          );
        if (isDefault) {
          const finalized = await tenants.updateOne(
            { _id: id, status: "active", createdBy: { $exists: false } },
            { $set: { provisioningStatus: "ready", updatedAt: now() } },
          );
          if (!finalized.matchedCount)
            fail(
              `tenant "${id}" is disabled or no longer operator-managed; signup remains unavailable`,
            );
        }
        console.log(
          existing
            ? `verified tenant "${id}" -> database ${dbName}; indexes ensured`
            : `created tenant "${id}" (${name}) -> database ${dbName}; private, invite-only, empty`,
        );
        console.log(
          isDefault
            ? `next: configure DEFAULT_SIGNUP_TENANT_ID=${id}; grant operator-approved admins by invitation. Customers join as members and cannot create tenants.`
            : `next: allow-models ${id} <modelId...>, allow-skills ${id} <skillId...>, invite the product owner as admin, set DEMO_TENANT_ID=${id}, then admission ${id} open`,
        );
        return;
      }
      case "drop": {
        const [id, flag, repeat] = args;
        validId(id);
        if (id === DEFAULT_TENANT_ID)
          fail('refusing to drop the "default" tenant');
        if (flag !== "--confirm" || repeat !== id)
          fail(`usage: drop <id> --confirm <id> (repeat the id to confirm)`);
        const doc = await tenants.findOne({ _id: id });
        if (!doc) fail(`tenant "${id}" is not registered`);
        // Never drop a shared database, whatever the registry says.
        if (
          doc.dbName === database ||
          doc.dbName === catalogDatabase ||
          doc.dbName !== dbNameFor(id)
        )
          fail(
            `refusing to drop ${doc.dbName}: not a generated tenant database`,
          );
        const db = client.db(doc.dbName);
        const collections = await db
          .listCollections({}, { nameOnly: true })
          .toArray();
        console.log(`will delete tenant "${id}" (${doc.name}):`);
        console.log(`  registry entry ${catalogDatabase}.tenants/${id}`);
        console.log(`  database ${doc.dbName}`);
        for (const { name } of collections.sort((a, b) =>
          a.name.localeCompare(b.name),
        ))
          console.log(
            `    ${name}: ${await db.collection(name).estimatedDocumentCount()} documents`,
          );
        await db.dropDatabase();
        await tenants.deleteOne({ _id: id });
        console.log(`dropped tenant "${id}"`);
        return;
      }
      case "invite": {
        const [id, email, flag, role, ...rest] = args;
        if (
          !email ||
          flag !== "--role" ||
          (role !== "admin" && role !== "user") ||
          rest.length
        )
          fail("usage: invite <id> <email> --role admin|user");
        await find(id);
        const address = validEmail(email);
        if (!address) fail("enter a valid email address for a Google account");
        const key = emailKey(address);
        const user = await catalog
          .collection("users")
          .findOne({ emailKey: key });
        if (
          user &&
          (await catalog
            .collection("memberships")
            .findOne({ userId: user._id, tenantId: id, status: "active" }))
        )
          fail(`${address} is already a member of "${id}"`);
        const invites = catalog.collection("invites");
        if (
          await invites.findOne({
            tenantId: id,
            emailKey: key,
            status: "pending",
          })
        )
          fail(
            `${address} already has a pending invite to "${id}"; revoke or resend it from the admin dashboard`,
          );
        // Only the hash is stored; the link printed below is the only copy.
        const token = randomBytes(32).toString("base64url");
        const created = new Date();
        const inviteId = `inv_${randomUUID()}`;
        await invites.insertOne({
          _id: inviteId,
          tenantId: id,
          email: address,
          emailKey: key,
          role,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          status: "pending",
          createdAt: created.toISOString(),
          expiresAt: new Date(created.getTime() + INVITE_LIFETIME_MS),
        });
        console.log(`invited ${address} to "${id}" as ${role} (${inviteId})`);
        console.log(`link (single use, expires in 7 days; not emailed):`);
        console.log(inviteLink(token));
        return;
      }
      case "members": {
        const [id, ...rest] = args;
        if (rest.length) fail("usage: members <id>");
        await find(id);
        const memberships = await catalog
          .collection("memberships")
          .find({ tenantId: id, status: "active" })
          .sort({ createdAt: 1 })
          .toArray();
        const users = await catalog
          .collection("users")
          .find({ _id: { $in: memberships.map((m) => m.userId) } })
          .toArray();
        const byId = new Map(users.map((u) => [u._id, u]));
        if (!memberships.length) console.log(`tenant "${id}" has no members`);
        for (const m of memberships) {
          const u = byId.get(m.userId);
          console.log(
            `${m.userId}\t${u?.email ?? "?"}\t${m.role}\t${u?.status ?? "?"}\tlast sign-in ${u?.lastLoginAt ?? "never"}`,
          );
        }
        return;
      }
      default:
        fail(`unknown command "${command}"\n${usage}`);
    }
  } finally {
    await client.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof CliError ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
