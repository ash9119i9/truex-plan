// Tenant registry CLI. Tenants live in the catalog database (`tenants`); each
// tenant's agents, MCP profiles and conversations live in its own database.
//
//   npm run tenant -- create <id> <name...>
//   npm run tenant -- list
//   npm run tenant -- disable <id> | enable <id>
//   npm run tenant -- allow-models <id> <modelId...|--all>
//   npm run tenant -- allow-skills <id> <skillId...|--all>
//   npm run tenant -- drop <id> --confirm <id>
//
// Reads MONGO_URI, MONGO_DB and CATALOG_MONGO_DB (process env first, then
// platform/.env). Unset CATALOG_MONGO_DB means the catalog is MONGO_DB.
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
  allow-models <id> <modelId...|--all>  restrict catalog models (--all lifts it)
  allow-skills <id> <skillId...|--all>  restrict catalog skills (--all lifts it)
  drop <id> --confirm <id>              delete a tenant database and registry entry`;

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

async function tenantIndexes(db) {
  await Promise.all([
    db.collection("messages").createIndex({ sessionId: 1, at: 1 }),
    db.collection("sessions").createIndex({ status: 1 }),
    db.collection("traces").createIndex({ sessionId: 1, startedAt: 1 }),
    db.collection("sessions").createIndex({ projectId: 1, createdAt: -1 }),
  ]);
}
async function catalogIndexes(catalog) {
  await Promise.all([
    catalog.collection("tenants").createIndex({ dbName: 1 }, { unique: true }),
    catalog
      .collection("truex_skills")
      .createIndex({ name: 1 }, { unique: true }),
  ]);
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
        await catalogIndexes(catalog);
        await tenants.insertOne({
          _id: id,
          name,
          dbName,
          status: "active",
          createdAt: now(),
          updatedAt: now(),
        });
        await tenantIndexes(client.db(dbName));
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
            `usage: ${command} <id> <${collection === "truex_models" ? "modelId" : "skillId"}...|--all>`,
          );
        await find(id);
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
